import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { Guards } from '../auth/guards.js';
import { Hosts, type HostRow } from '../db/models.js';
import { SshError, shq, type ExecResult } from '../ssh/manager.js';
import { hostOsCache, parseDockerPs, parseStats, parseSystemdUnits, STATS_SCRIPT } from '../ssh/stats.js';
import { classifyCommand } from '../ai/safety.js';
import { actor, badRequest, HttpError, notFound, parse } from '../util/http.js';

const CONTAINER = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const UNIT = /^[a-zA-Z0-9@._:\\-]{1,200}\.service$/;

function sshHttpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof SshError) {
    const status = err.code === 'NOT_FOUND' ? 404 : err.code === 'HOST_KEY_UNKNOWN' || err.code === 'AUTH_FAILED' ? 409 : 502;
    return new HttpError(status, err.message, err.code);
  }
  return new HttpError(500, (err as Error).message);
}

export function registerMonitorRoutes(app: FastifyInstance, ctx: AppContext, guards: Guards) {
  const { db, audit } = ctx;
  const pre = { preHandler: guards.user };

  function host(req: FastifyRequest): HostRow {
    const { id } = req.params as { id: string };
    const h = Hosts.accessible(db, req.auth!.user.id, id);
    if (!h) throw notFound('Host not found');
    return h;
  }

  async function run(req: FastifyRequest, h: HostRow, command: string, opts: { timeoutMs?: number; maxBytes?: number } = {}): Promise<ExecResult> {
    try {
      return await ctx.ssh.run(req.auth!.user.id, h.id, command, opts);
    } catch (err) {
      throw sshHttpError(err);
    }
  }

  /** Prefix for privileged commands: sudo -n unless we're already root. */
  const priv = (h: HostRow) => (h.username === 'root' ? '' : h.use_sudo ? 'sudo -n ' : '');

  // ------------------------------------------------------------------ stats
  app.get('/api/hosts/:id/stats', pre, async (req) => {
    const h = host(req);
    const r = await run(req, h, STATS_SCRIPT, { timeoutMs: 15_000, maxBytes: 256 * 1024 });
    const stats = parseStats(r.stdout);
    if (stats.os) hostOsCache.set(h.id, stats.os);
    return { ...stats, sampledAt: Date.now() };
  });

  // ------------------------------------------------------------------ generic exec (AI agent, multi-host snippets)
  app.post('/api/hosts/:id/exec', { ...pre, config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const h = host(req);
    const body = parse(
      z.object({
        command: z.string().min(1).max(10_000),
        timeoutSec: z.number().int().min(1).max(600).default(60),
        source: z.enum(['user', 'ai', 'snippet']).default('user'),
        confirmDangerous: z.boolean().default(false),
      }),
      req.body,
    );
    const risk = classifyCommand(body.command);
    if (risk.risk === 'dangerous' && !body.confirmDangerous) {
      throw new HttpError(428, `Potentially destructive command: ${risk.reasons.join('; ')}`, 'CONFIRM_DANGEROUS');
    }
    const r = await run(req, h, body.command, { timeoutMs: body.timeoutSec * 1000, maxBytes: 512 * 1024 });
    audit.write({
      ...actor(req),
      action: `exec.${body.source}`,
      target: h.name,
      success: r.code === 0,
      details: { command: body.command.slice(0, 2000), exitCode: r.code, risk: risk.risk, durationMs: r.durationMs },
    });
    return { ...r, risk };
  });

  // ------------------------------------------------------------------ docker
  app.get('/api/hosts/:id/docker', pre, async (req) => {
    const h = host(req);
    const r = await run(req, h, `${priv(h)}docker ps -a --no-trunc --format '{{json .}}'`, { timeoutMs: 20_000, maxBytes: 2 * 1024 * 1024 });
    if (r.code !== 0) {
      const msg = r.stderr.trim();
      if (/not found/i.test(msg)) throw badRequest('Docker is not installed on this host');
      if (/permission denied/i.test(msg)) throw badRequest('Permission denied talking to Docker — add the user to the "docker" group or enable sudo for this host');
      throw badRequest(msg || 'docker ps failed');
    }
    return { containers: parseDockerPs(r.stdout) };
  });

  app.get('/api/hosts/:id/docker/stats', pre, async (req) => {
    const h = host(req);
    const r = await run(req, h, `${priv(h)}docker stats --no-stream --format '{{json .}}'`, { timeoutMs: 30_000 });
    if (r.code !== 0) throw badRequest(r.stderr.trim() || 'docker stats failed');
    const stats: Record<string, { cpu: string; mem: string; memPct: string; net: string; block: string }> = {};
    for (const line of r.stdout.split('\n')) {
      try {
        const j = JSON.parse(line) as Record<string, string>;
        stats[j.Name] = { cpu: j.CPUPerc, mem: j.MemUsage, memPct: j.MemPerc, net: j.NetIO, block: j.BlockIO };
      } catch {
        /* skip */
      }
    }
    return { stats };
  });

  app.post('/api/hosts/:id/docker/:container/:action', pre, async (req) => {
    const h = host(req);
    const { container, action } = req.params as { container: string; action: string };
    if (!CONTAINER.test(container)) throw badRequest('Invalid container name');
    if (!['start', 'stop', 'restart', 'pause', 'unpause', 'kill'].includes(action)) throw badRequest('Unsupported action');
    const r = await run(req, h, `${priv(h)}docker ${action} ${shq(container)}`, { timeoutMs: 120_000 });
    audit.write({ ...actor(req), action: `docker.${action}`, target: `${h.name}:${container}`, success: r.code === 0 });
    if (r.code !== 0) throw badRequest(r.stderr.trim() || `docker ${action} failed`);
    return { ok: true };
  });

  app.get('/api/hosts/:id/docker/:container/logs', pre, async (req) => {
    const h = host(req);
    const { container } = req.params as { container: string };
    const q = parse(z.object({ tail: z.coerce.number().int().min(10).max(5000).default(300) }), req.query);
    if (!CONTAINER.test(container)) throw badRequest('Invalid container name');
    const r = await run(req, h, `${priv(h)}docker logs --tail ${q.tail} --timestamps ${shq(container)} 2>&1`, { timeoutMs: 20_000, maxBytes: 2 * 1024 * 1024 });
    return { logs: r.stdout, truncated: r.truncated };
  });

  // ------------------------------------------------------------------ systemd
  app.get('/api/hosts/:id/services', pre, async (req) => {
    const h = host(req);
    const r = await run(
      req,
      h,
      `systemctl list-units --type=service --all --no-legend --plain --no-pager 2>/dev/null; echo @@FILES; systemctl list-unit-files --type=service --no-legend --no-pager 2>/dev/null`,
      { timeoutMs: 20_000, maxBytes: 2 * 1024 * 1024 },
    );
    const [units, files = ''] = r.stdout.split('@@FILES');
    const services = parseSystemdUnits(units, files);
    if (!services.length && r.code !== 0) throw badRequest('systemd is not available on this host');
    return { services };
  });

  app.post('/api/hosts/:id/services/:unit/:action', pre, async (req) => {
    const h = host(req);
    const { unit, action } = req.params as { unit: string; action: string };
    if (!UNIT.test(unit)) throw badRequest('Invalid unit name');
    if (!['start', 'stop', 'restart', 'reload', 'enable', 'disable'].includes(action)) throw badRequest('Unsupported action');
    const r = await run(req, h, `${priv(h)}systemctl ${action} ${shq(unit)}`, { timeoutMs: 90_000 });
    audit.write({ ...actor(req), action: `systemd.${action}`, target: `${h.name}:${unit}`, success: r.code === 0 });
    if (r.code !== 0) {
      const msg = r.stderr.trim();
      throw badRequest(/password is required|a terminal is required|interactive authentication/i.test(msg) ? 'Root privileges required: enable passwordless sudo for this user, or connect as root' : msg || `systemctl ${action} failed`);
    }
    return { ok: true };
  });

  app.get('/api/hosts/:id/services/:unit/logs', pre, async (req) => {
    const h = host(req);
    const { unit } = req.params as { unit: string };
    const q = parse(z.object({ lines: z.coerce.number().int().min(10).max(5000).default(300) }), req.query);
    if (!UNIT.test(unit)) throw badRequest('Invalid unit name');
    const r = await run(req, h, `${priv(h)}journalctl -u ${shq(unit)} -n ${q.lines} --no-pager -o short-iso 2>&1`, { timeoutMs: 20_000, maxBytes: 2 * 1024 * 1024 });
    return { logs: r.stdout };
  });

  // ------------------------------------------------------------------ package updates
  app.get('/api/hosts/:id/updates', pre, async (req) => {
    const h = host(req);
    const script = `export LC_ALL=C
if command -v apt >/dev/null 2>&1; then echo @@apt; apt list --upgradable 2>/dev/null | tail -n +2
elif command -v dnf >/dev/null 2>&1; then echo @@dnf; dnf -q check-update 2>/dev/null
elif command -v pacman >/dev/null 2>&1; then echo @@pacman; (checkupdates 2>/dev/null || pacman -Qu 2>/dev/null)
elif command -v apk >/dev/null 2>&1; then echo @@apk; apk version -l '<' 2>/dev/null | tail -n +2
else echo @@unknown; fi`;
    const r = await run(req, h, script, { timeoutMs: 60_000, maxBytes: 1024 * 1024 });
    const lines = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean);
    const manager = (lines.shift() ?? '@@unknown').replace('@@', '');
    const packages = lines
      .filter((l) => !/^(Listing|Last metadata|Obsoleting|Security:)/.test(l))
      .map((l) => {
        const name = l.split(/[\s/]/)[0];
        return { name, line: l };
      })
      .filter((p) => p.name);
    return { manager, packages, count: packages.length };
  });

  // ------------------------------------------------------------------ power
  app.post('/api/hosts/:id/power', pre, async (req) => {
    const h = host(req);
    const { action } = parse(z.object({ action: z.enum(['reboot', 'poweroff']) }), req.body);
    const r = await run(req, h, `${h.username === 'root' ? '' : 'sudo -n '}systemctl ${action}`, { timeoutMs: 15_000 }).catch((e: HttpError) => {
      // The connection often drops as the host goes down — that's success.
      if (e.code === 'CONNECT_FAILED') return { code: 0, stderr: '' } as ExecResult;
      throw e;
    });
    audit.write({ ...actor(req), action: `host.${action}`, target: h.name, success: r.code === 0 || r.code === null });
    if (r.code && r.code !== 0) throw badRequest(r.stderr.trim() || `${action} failed (passwordless sudo required)`);
    return { ok: true };
  });
}
