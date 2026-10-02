import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { LogController, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import fastifyStatic from '@fastify/static';
import type { Config } from './config.js';
import { Db } from './db/index.js';
import { Users } from './db/models.js';
import { loadMasterKey, randomToken, Vault } from './security/crypto.js';
import { Audit } from './audit.js';
import { AppSettingsStore } from './appSettings.js';
import { SessionStore } from './auth/sessions.js';
import { FailureThrottle } from './security/throttle.js';
import { CidrList, normalizeIp } from './security/cidr.js';
import { CfAccessVerifier } from './security/cfaccess.js';
import { SshManager } from './ssh/manager.js';
import { TerminalManager } from './ssh/terminals.js';
import { Recorder } from './recorder.js';
import type { AppContext } from './context.js';
import { makeGuards } from './auth/guards.js';
import { HttpError } from './util/http.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerAdminRoutes } from './routes/admin.js';
import { registerHostRoutes } from './routes/hosts.js';
import { registerKeyRoutes } from './routes/keys.js';
import { registerTerminalRoutes } from './routes/terminal.js';
import { registerSftpRoutes } from './routes/sftp.js';
import { registerMonitorRoutes } from './routes/monitor.js';
import { registerSnippetRoutes } from './routes/snippets.js';
import { registerHelpRoutes } from './routes/help.js';
import { registerAiRoutes } from './routes/ai.js';

export interface BuildOptions {
  logger?: FastifyServerOptions['logger'];
  db?: Db;
  webDist?: string;
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export async function buildApp(config: Config, opts: BuildOptions = {}): Promise<{ app: FastifyInstance; ctx: AppContext }> {
  const app = Fastify({
    logger: opts.logger ?? {
      level: config.logLevel,
      redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["cf-access-jwt-assertion"]', 'req.headers["x-csrf-token"]'],
    },
    trustProxy: typeof config.trustProxy === 'number' ? ((_addr: string, hop: number) => hop < (config.trustProxy as number)) : config.trustProxy,
    bodyLimit: 8 * 1024 * 1024,
    logController: new LogController({ disableRequestLogging: config.logLevel !== 'debug' }),
    routerOptions: { maxParamLength: 300 },
  });

  const db = opts.db ?? Db.open(config.dataDir);
  const mk = loadMasterKey({ masterKey: config.masterKey, masterKeyFile: config.masterKeyFile, dataDir: config.dataDir });
  if (mk.source === 'generated') {
    app.log.warn('Using an auto-generated master key stored in DATA_DIR/master.key. For better protection set MASTER_KEY or MASTER_KEY_FILE (see SECURITY.md).');
  }
  const vault = new Vault(mk.key);
  const audit = new Audit(db, app.log);
  const settings = new AppSettingsStore(db, config, vault);
  const recorder = new Recorder(db, config.dataDir);
  const ssh = new SshManager({ db, vault, log: app.log, audit, targetAllowlist: new CidrList(config.sshTargetAllowlist) });
  const terminals = new TerminalManager(
    { db, ssh, audit, recorder, settings, log: app.log },
    { graceMs: config.terminalGraceMs, maxPerUser: config.maxSessionsPerUser, scrollbackLines: config.scrollbackLines },
  );

  const ctx: AppContext = {
    config,
    db,
    vault,
    log: app.log,
    audit,
    settings,
    sessions: new SessionStore(db, { idleMs: config.sessionIdleMs, maxMs: config.sessionMaxMs }),
    ipThrottle: new FailureThrottle(20, 15 * 60_000),
    ipAllowlist: new CidrList(config.ipAllowlist),
    cfAccess: config.cfAccess ? new CfAccessVerifier(config.cfAccess.teamDomain, config.cfAccess.aud) : null,
    ssh,
    terminals,
    recorder,
    setupToken: Users.count(db) === 0 ? (config.setupToken ?? randomToken(18)) : null,
  };

  // ------------------------------------------------------------------ plugins
  await app.register(cookie);
  const publicOrigin = new URL(config.publicUrl);
  const wsOrigin = `${publicOrigin.protocol === 'https:' ? 'wss:' : 'ws:'}//${publicOrigin.host}`;
  await app.register(helmet, {
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        fontSrc: ["'self'", 'data:'],
        connectSrc: ["'self'", wsOrigin],
        workerSrc: ["'self'", 'blob:'],
        manifestSrc: ["'self'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        baseUri: ["'self'"],
        objectSrc: ["'none'"],
      },
    },
    hsts: config.secureCookies ? { maxAge: 31536000, includeSubDomains: false } : false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-origin' },
    referrerPolicy: { policy: 'no-referrer' },
  });
  app.addHook('onSend', async (_req, reply) => {
    reply.header('permissions-policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
  });
  await app.register(rateLimit, { global: true, max: 600, timeWindow: '1 minute', keyGenerator: (req) => normalizeIp(req.ip) });
  await app.register(multipart, { limits: { fileSize: config.maxUploadBytes, files: 50, fields: 10 } });
  await app.register(websocket, { options: { maxPayload: 1024 * 1024 } });

  app.decorateRequest('auth', null);

  // ------------------------------------------------------------------ perimeter checks
  app.addHook('onRequest', async (req, reply) => {
    if (req.url === '/healthz') return;
    const ip = normalizeIp(req.ip);
    if (!ctx.ipAllowlist.allows(ip)) {
      req.log.warn({ ip }, 'blocked by IP_ALLOWLIST');
      return reply.code(403).send({ error: 'Forbidden' });
    }
    if (ctx.cfAccess) {
      const token = (req.headers['cf-access-jwt-assertion'] as string | undefined) ?? req.cookies?.CF_Authorization;
      if (!(await ctx.cfAccess.verify(token))) {
        req.log.warn({ ip }, 'missing/invalid Cloudflare Access token');
        return reply.code(403).send({ error: 'Forbidden: Cloudflare Access required' });
      }
    }
    // Cross-site protection: state-changing requests and WebSocket upgrades must come from our own origin.
    const origin = req.headers.origin;
    const isUpgrade = (req.headers.upgrade ?? '').toLowerCase() === 'websocket';
    if ((isUpgrade || !SAFE_METHODS.has(req.method)) && origin && origin !== config.publicUrl) {
      req.log.warn({ origin }, 'rejected cross-origin request');
      return reply.code(403).send({ error: 'Cross-origin request rejected (check PUBLIC_URL)' });
    }
    if (isUpgrade && !origin) return reply.code(403).send({ error: 'Origin header required' });
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) return reply.code(err.status).send({ error: err.message, code: err.code });
    const e = err as { statusCode?: number; message: string; code?: string; validation?: unknown };
    if (e.statusCode === 429) return reply.code(429).send({ error: 'Too many requests, slow down' });
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.message, code: e.code });
    req.log.error({ err }, 'unhandled error');
    return reply.code(500).send({ error: 'Internal server error' });
  });

  // ------------------------------------------------------------------ routes
  const guards = makeGuards(ctx);
  app.get('/healthz', { config: { rateLimit: false } }, async () => ({ ok: true }));
  registerAuthRoutes(app, ctx, guards);
  registerAdminRoutes(app, ctx, guards);
  registerHostRoutes(app, ctx, guards);
  registerKeyRoutes(app, ctx, guards);
  registerTerminalRoutes(app, ctx, guards);
  registerSftpRoutes(app, ctx, guards);
  registerMonitorRoutes(app, ctx, guards);
  registerSnippetRoutes(app, ctx, guards);
  registerHelpRoutes(app, ctx, guards);
  registerAiRoutes(app, ctx, guards);

  // ------------------------------------------------------------------ web UI (built SPA)
  const webDist = opts.webDist ?? process.env.WEB_DIST ?? fileURLToPath(new URL('../../web/dist', import.meta.url));
  const indexHtml = path.join(webDist, 'index.html');
  if (fs.existsSync(indexHtml)) {
    await app.register(fastifyStatic, {
      root: webDist,
      wildcard: false,
      index: false,
      setHeaders: (reply, filePath) => {
        if (filePath.includes(`${path.sep}assets${path.sep}`)) reply.header('cache-control', 'public, max-age=31536000, immutable');
        else reply.header('cache-control', 'no-cache');
      },
    });
    const html = fs.readFileSync(indexHtml);
    app.get('/*', { config: { rateLimit: false } }, async (req, reply) => {
      const p = req.url.split('?')[0];
      if (p.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
      const file = path.join(webDist, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
      if (file.startsWith(webDist + path.sep) && fs.existsSync(file) && fs.statSync(file).isFile()) {
        return reply.sendFile(path.relative(webDist, file));
      }
      return reply.header('cache-control', 'no-cache').type('text/html').send(html);
    });
  } else {
    app.log.warn(`Web UI not found at ${webDist} — run "npm run build:web"`);
  }

  app.addHook('onClose', async () => {
    terminals.shutdown();
    ssh.closeAll();
  });

  return { app, ctx };
}
