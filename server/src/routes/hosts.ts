import dgram from 'node:dgram';
import net from 'node:net';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { Guards } from '../auth/guards.js';
import { Hosts, Keys, publicHost, type HostRow } from '../db/models.js';
import { actor, badRequest, forbidden, notFound, parse } from '../util/http.js';
import { SshError, type HostKeyInfo, type Interaction } from '../ssh/manager.js';

const MAC = /^([0-9a-fA-F]{2}[:-]){5}[0-9a-fA-F]{2}$/;

export const HostInput = z.object({
  name: z.string().trim().min(1).max(100),
  hostname: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^[a-zA-Z0-9._:%\-[\]]+$/, 'Invalid hostname'),
  port: z.number().int().min(1).max(65535).default(22),
  username: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9._@\\-]+$/, 'Invalid username'),
  authType: z.enum(['password', 'key', 'ask']),
  /** undefined = keep existing, '' = clear */
  password: z.string().max(1024).optional(),
  keyId: z.string().max(64).nullable().optional(),
  jumpHostId: z.string().max(64).nullable().optional(),
  group: z.string().trim().max(64).default(''),
  tags: z.array(z.string().trim().min(1).max(32)).max(20).default([]),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
  notes: z.string().max(5000).default(''),
  macAddress: z
    .string()
    .trim()
    .refine((v) => v === '' || MAC.test(v), 'MAC address must look like aa:bb:cc:dd:ee:ff')
    .nullable()
    .optional(),
  startupCommand: z.string().max(1000).nullable().optional(),
  shared: z.boolean().default(false),
  record: z.boolean().default(false),
  useSudo: z.boolean().default(false),
  favorite: z.boolean().default(false),
});
type HostInputT = z.infer<typeof HostInput>;

export function registerHostRoutes(app: FastifyInstance, ctx: AppContext, guards: Guards) {
  const { db, vault, audit } = ctx;
  const pre = { preHandler: guards.user };

  function canCreate(req: FastifyRequest) {
    return req.auth!.user.role === 'admin' || ctx.settings.get().allowUserHosts;
  }

  function ownedOr404(req: FastifyRequest): HostRow {
    const { id } = req.params as { id: string };
    const h = Hosts.byId(db, id);
    if (!h) throw notFound('Host not found');
    // Admins may manage every host; others only their own.
    if (h.owner_id !== req.auth!.user.id && req.auth!.user.role !== 'admin') throw forbidden('Only the owner can modify this host');
    return h;
  }

  function accessibleOr404(req: FastifyRequest): HostRow {
    const { id } = req.params as { id: string };
    const h = Hosts.accessible(db, req.auth!.user.id, id);
    if (!h) throw notFound('Host not found');
    return h;
  }

  function validateRefs(input: HostInputT, ownerId: string, selfId?: string) {
    if (input.authType === 'key') {
      if (!input.keyId) throw badRequest('Choose an SSH key for key authentication');
      const k = Keys.byId(db, input.keyId);
      if (!k || k.owner_id !== ownerId) throw badRequest('SSH key not found');
    }
    if (input.jumpHostId) {
      if (input.jumpHostId === selfId) throw badRequest('A host cannot be its own jump host');
      const j = Hosts.accessible(db, ownerId, input.jumpHostId);
      if (!j) throw badRequest('Jump host not found');
      // Walk the chain to reject loops.
      const seen = new Set([selfId]);
      let cur: HostRow | undefined = j;
      for (let i = 0; cur && i < 10; i++) {
        if (seen.has(cur.id)) throw badRequest('Jump host chain would create a loop');
        seen.add(cur.id);
        cur = cur.jump_host_id ? Hosts.byId(db, cur.jump_host_id) : undefined;
      }
    }
  }

  function toRow(input: HostInputT, req: FastifyRequest, existing?: HostRow) {
    const isAdmin = req.auth!.user.role === 'admin';
    const id = existing?.id;
    let passwordEnc = existing?.password_enc ?? null;
    if (input.authType !== 'password') passwordEnc = null;
    else if (input.password !== undefined) passwordEnc = input.password === '' ? null : vault.encrypt(input.password, `host:${id ?? '__new__'}`);
    return {
      name: input.name,
      hostname: input.hostname,
      port: input.port,
      username: input.username,
      auth_type: input.authType,
      password_enc: passwordEnc,
      key_id: input.authType === 'key' ? (input.keyId ?? null) : null,
      jump_host_id: input.jumpHostId ?? null,
      group_name: input.group,
      tags: JSON.stringify([...new Set(input.tags)]),
      color: input.color ?? null,
      notes: input.notes,
      mac_address: input.macAddress ? input.macAddress.toLowerCase().replace(/-/g, ':') : null,
      startup_command: input.startupCommand?.trim() || null,
      shared: isAdmin && input.shared ? 1 : 0,
      record: input.record ? 1 : 0,
      use_sudo: input.useSudo ? 1 : 0,
      favorite: input.favorite ? 1 : 0,
    };
  }

  app.get('/api/hosts', pre, async (req) => Hosts.visibleTo(db, req.auth!.user.id).map((h) => publicHost(h, req.auth!.user.id)));

  app.post('/api/hosts', pre, async (req) => {
    if (!canCreate(req)) throw forbidden('Only administrators can add hosts on this server');
    const input = parse(HostInput, req.body);
    const ownerId = req.auth!.user.id;
    validateRefs(input, ownerId);
    const row = toRow(input, req);
    const created = Hosts.create(db, { ...row, owner_id: ownerId, password_enc: null });
    // Encrypt with the real id as associated data now that we have it.
    if (input.authType === 'password' && input.password) Hosts.update(db, created.id, { password_enc: vault.encrypt(input.password, `host:${created.id}`) });
    audit.write({ ...actor(req), action: 'host.create', target: created.name, details: { hostname: created.hostname, port: created.port } });
    return publicHost(Hosts.byId(db, created.id)!, ownerId);
  });

  app.put('/api/hosts/:id', pre, async (req) => {
    const existing = ownedOr404(req);
    const input = parse(HostInput, req.body);
    validateRefs(input, existing.owner_id, existing.id);
    const row = toRow(input, req, existing);
    if (existing.owner_id !== req.auth!.user.id) row.shared = existing.shared; // admins editing others' hosts keep sharing as is
    Hosts.update(db, existing.id, row);
    if (existing.hostname !== input.hostname || existing.port !== input.port) {
      Hosts.setHostKey(db, existing.id, null, null);
    }
    ctx.ssh.closeHost(existing.id);
    audit.write({ ...actor(req), action: 'host.update', target: input.name });
    return publicHost(Hosts.byId(db, existing.id)!, req.auth!.user.id);
  });

  app.patch('/api/hosts/:id/favorite', pre, async (req) => {
    const h = ownedOr404(req);
    const { favorite } = parse(z.object({ favorite: z.boolean() }), req.body);
    Hosts.update(db, h.id, { favorite: favorite ? 1 : 0 });
    return { ok: true };
  });

  app.delete('/api/hosts/:id', pre, async (req) => {
    const h = ownedOr404(req);
    for (const s of ctx.terminals.listAll()) if (s.hostId === h.id) ctx.terminals.close(s.id, 'Host deleted');
    ctx.ssh.closeHost(h.id);
    Hosts.delete(db, h.id);
    audit.write({ ...actor(req), action: 'host.delete', target: h.name });
    return { ok: true };
  });

  app.post('/api/hosts/:id/reset-hostkey', pre, async (req) => {
    const h = ownedOr404(req);
    Hosts.setHostKey(db, h.id, null, null);
    ctx.ssh.closeHost(h.id);
    audit.write({ ...actor(req), action: 'host.hostkey_reset', target: h.name, details: { previous: h.host_key_fp } });
    return { ok: true };
  });

  /**
   * Non-interactive connection test. If the host key is unknown the response
   * carries its fingerprint; repeat the call with `trustFingerprint` to pin it.
   */
  app.post('/api/hosts/:id/test', pre, async (req) => {
    const h = accessibleOr404(req);
    const { trustFingerprint } = parse(z.object({ trustFingerprint: z.string().max(200).optional() }), req.body);
    let seenKey: HostKeyInfo | null = null;
    const interaction: Interaction = {
      confirmHostKey: async (info) => {
        seenKey = info;
        return !!trustFingerprint && trustFingerprint === info.fingerprint;
      },
      prompt: async () => null,
    };
    const started = Date.now();
    try {
      const lease = await ctx.ssh.lease(req.auth!.user.id, h.id, interaction);
      try {
        const r = await ctx.ssh.exec(lease.conn, 'uname -srmo 2>/dev/null || uname -a; hostname 2>/dev/null', { timeoutMs: 10_000, maxBytes: 4096 });
        const fresh = Hosts.byId(db, h.id)!;
        return {
          ok: true,
          latencyMs: Date.now() - started,
          output: r.stdout.trim(),
          hostKey: fresh.host_key_fp ? { fingerprint: fresh.host_key_fp, keyType: fresh.host_key_type } : null,
        };
      } finally {
        lease.release();
      }
    } catch (err) {
      const e = err as SshError;
      const sk = seenKey as HostKeyInfo | null;
      return {
        ok: false,
        code: e.code ?? 'CONNECT_FAILED',
        message: e.message,
        hostKey: sk ? { fingerprint: sk.fingerprint, keyType: sk.keyType } : (e.details ?? null),
      };
    }
  });

  app.post('/api/hosts/:id/wol', pre, async (req) => {
    const h = accessibleOr404(req);
    const { broadcast } = parse(z.object({ broadcast: z.ipv4().optional() }), req.body);
    if (!h.mac_address) throw badRequest('This host has no MAC address configured');
    const targets = new Set<string>(['255.255.255.255']);
    if (broadcast) targets.add(broadcast);
    if (net.isIPv4(h.hostname)) targets.add(h.hostname.replace(/\.\d+$/, '.255'));
    await sendMagicPacket(h.mac_address, [...targets]);
    audit.write({ ...actor(req), action: 'host.wol', target: h.name, details: { mac: h.mac_address, targets: [...targets] } });
    return { ok: true, targets: [...targets] };
  });

  app.get('/api/hosts/export', pre, async (req) => {
    const uid = req.auth!.user.id;
    const hosts = Hosts.visibleTo(db, uid).filter((h) => h.owner_id === uid);
    const byId = new Map(hosts.map((h) => [h.id, h.name]));
    return hosts.map((h) => ({
      name: h.name,
      hostname: h.hostname,
      port: h.port,
      username: h.username,
      authType: h.auth_type,
      group: h.group_name,
      tags: JSON.parse(h.tags),
      color: h.color,
      notes: h.notes,
      macAddress: h.mac_address,
      startupCommand: h.startup_command,
      jumpHost: h.jump_host_id ? (byId.get(h.jump_host_id) ?? null) : null,
    }));
  });

  /** Import Host blocks from an OpenSSH client config (~/.ssh/config). */
  app.post('/api/hosts/import', pre, async (req) => {
    if (!canCreate(req)) throw forbidden('Only administrators can add hosts on this server');
    const body = parse(z.object({ config: z.string().max(200_000), keyId: z.string().max(64).nullable().optional(), group: z.string().max(64).default('') }), req.body);
    const ownerId = req.auth!.user.id;
    if (body.keyId) {
      const k = Keys.byId(db, body.keyId);
      if (!k || k.owner_id !== ownerId) throw badRequest('SSH key not found');
    }
    const entries = parseSshConfig(body.config);
    if (!entries.length) throw badRequest('No concrete Host entries found');
    const existing = new Map(Hosts.visibleTo(db, ownerId).map((h) => [h.name.toLowerCase(), h]));
    const created: HostRow[] = [];
    const skipped: string[] = [];
    db.tx(() => {
      for (const e of entries) {
        if (existing.has(e.alias.toLowerCase())) {
          skipped.push(e.alias);
          continue;
        }
        const h = Hosts.create(db, {
          owner_id: ownerId,
          name: e.alias,
          hostname: e.hostname ?? e.alias,
          port: e.port ?? 22,
          username: e.user ?? 'root',
          auth_type: body.keyId ? 'key' : 'ask',
          password_enc: null,
          key_id: body.keyId ?? null,
          jump_host_id: null,
          group_name: body.group,
          tags: '[]',
          color: null,
          notes: e.identityFile ? `Imported. Original IdentityFile: ${e.identityFile}` : 'Imported from ssh config',
          mac_address: null,
          startup_command: null,
          shared: 0,
          record: 0,
          use_sudo: 0,
          favorite: 0,
        });
        created.push(h);
        existing.set(h.name.toLowerCase(), h);
      }
      // Second pass: resolve ProxyJump aliases.
      for (const e of entries) {
        if (!e.proxyJump) continue;
        const self = created.find((c) => c.name === e.alias);
        const jump = existing.get(e.proxyJump.split(',')[0].replace(/^.*@/, '').replace(/:\d+$/, '').toLowerCase());
        if (self && jump && jump.id !== self.id) Hosts.update(db, self.id, { jump_host_id: jump.id });
      }
    });
    audit.write({ ...actor(req), action: 'host.import', details: { created: created.length, skipped: skipped.length } });
    return { created: created.length, skipped };
  });
}

export interface SshConfigEntry {
  alias: string;
  hostname?: string;
  user?: string;
  port?: number;
  proxyJump?: string;
  identityFile?: string;
}

export function parseSshConfig(text: string): SshConfigEntry[] {
  const out: SshConfigEntry[] = [];
  let current: SshConfigEntry[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const m = /^(\S+)\s*=?\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim().replace(/^"(.*)"$/, '$1');
    if (key === 'host') {
      current = value
        .split(/\s+/)
        .filter((a) => a && !/[*?!]/.test(a))
        .map((alias) => ({ alias }));
      out.push(...current);
    } else if (key === 'match') {
      current = [];
    } else {
      for (const e of current) {
        if (key === 'hostname') e.hostname = value;
        else if (key === 'user') e.user = value;
        else if (key === 'port') e.port = Number.parseInt(value, 10) || 22;
        else if (key === 'proxyjump' && value.toLowerCase() !== 'none') e.proxyJump = value;
        else if (key === 'identityfile') e.identityFile = value;
      }
    }
  }
  return out.filter((e) => /^[a-zA-Z0-9._:%\-[\]]+$/.test(e.hostname ?? e.alias));
}

export function magicPacket(mac: string): Buffer {
  const bytes = Buffer.from(mac.replace(/[:-]/g, ''), 'hex');
  if (bytes.length !== 6) throw new Error('Invalid MAC address');
  const pkt = Buffer.alloc(6 + 16 * 6, 0xff);
  for (let i = 0; i < 16; i++) bytes.copy(pkt, 6 + i * 6);
  return pkt;
}

async function sendMagicPacket(mac: string, targets: string[]): Promise<void> {
  const pkt = magicPacket(mac);
  const sock = dgram.createSocket('udp4');
  await new Promise<void>((resolve, reject) => {
    sock.once('error', reject);
    sock.bind(() => {
      sock.setBroadcast(true);
      resolve();
    });
  });
  try {
    for (const t of targets) {
      for (const port of [9, 7]) {
        await new Promise<void>((resolve) => sock.send(pkt, port, t, () => resolve()));
      }
    }
  } finally {
    sock.close();
  }
}
