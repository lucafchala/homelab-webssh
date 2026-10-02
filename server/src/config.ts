import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : /^(1|true|yes|on)$/i.test(v)));

const int = (def: number, min = 0, max = Number.MAX_SAFE_INTEGER) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number.parseInt(v, 10)))
    .pipe(z.number().int().min(min).max(max));

const list = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );

const EnvSchema = z.object({
  NODE_ENV: z.string().optional().default('production'),
  HOST: z.string().optional().default('0.0.0.0'),
  PORT: int(8080, 1, 65535),
  DATA_DIR: z.string().optional().default('./data'),
  /** Public URL users reach the app at, e.g. https://webssh.example.com */
  PUBLIC_URL: z.string().optional().default('http://localhost:8080'),
  /** Fastify trustProxy value: "true", "false", a hop count, or a comma separated list of CIDRs. */
  TRUST_PROXY: z.string().optional().default('loopback,linklocal,uniquelocal'),
  LOG_LEVEL: z.string().optional().default('info'),

  MASTER_KEY: z.string().optional(),
  MASTER_KEY_FILE: z.string().optional(),
  SETUP_TOKEN: z.string().optional(),

  SESSION_IDLE_HOURS: int(12, 1, 24 * 30),
  SESSION_MAX_DAYS: int(7, 1, 365),
  REQUIRE_2FA: bool(true),
  LOGIN_MAX_ATTEMPTS: int(5, 1, 100),
  LOGIN_LOCK_MINUTES: int(15, 1, 24 * 60),

  /** Only allow clients from these CIDRs (empty = allow all). */
  IP_ALLOWLIST: list,
  /** Only allow SSH connections to these CIDRs (empty = allow all). */
  SSH_TARGET_ALLOWLIST: list,

  /** Cloudflare Access (Zero Trust) JWT validation — defence in depth behind a tunnel. */
  CF_ACCESS_TEAM_DOMAIN: z.string().optional().default(''),
  CF_ACCESS_AUD: z.string().optional().default(''),

  TERMINAL_GRACE_MINUTES: int(30, 0, 24 * 60),
  MAX_SESSIONS_PER_USER: int(20, 1, 500),
  SCROLLBACK_LINES: int(5000, 100, 100000),
  RECORDINGS_RETENTION_DAYS: int(30, 0, 3650),
  MAX_UPLOAD_MB: int(2048, 1, 1024 * 100),

  AI_PROVIDER: z.enum(['none', 'anthropic', 'openai', 'ollama']).optional(),
  AI_MODEL: z.string().optional(),
  AI_BASE_URL: z.string().optional(),
  AI_API_KEY: z.string().optional(),
  ANTHROPIC_API_KEY: z.string().optional(),
  OPENAI_API_KEY: z.string().optional(),

  TLDR_ENABLED: bool(true),
  TLDR_BASE_URL: z.string().optional().default('https://raw.githubusercontent.com/tldr-pages/tldr/main/pages'),
});

export type Config = ReturnType<typeof loadConfig>;

function parseTrustProxy(v: string): boolean | number | string[] {
  if (/^(true|yes|on)$/i.test(v)) return true;
  if (/^(false|no|off|0)$/i.test(v) || v === '') return false;
  if (/^\d+$/.test(v)) return Number.parseInt(v, 10);
  return v
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  // Treat `KEY=` (empty) in .env the same as an unset variable.
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v.trim() !== ''));
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${issues}`);
  }
  const e = parsed.data;
  const publicUrl = new URL(e.PUBLIC_URL);
  const dataDir = path.resolve(e.DATA_DIR);
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  // AI provider resolution: explicit > inferred from available keys.
  let aiProvider = e.AI_PROVIDER;
  if (!aiProvider) {
    if (e.ANTHROPIC_API_KEY) aiProvider = 'anthropic';
    else if (e.OPENAI_API_KEY) aiProvider = 'openai';
    else aiProvider = 'none';
  }
  const aiApiKey =
    e.AI_API_KEY ?? (aiProvider === 'anthropic' ? e.ANTHROPIC_API_KEY : aiProvider === 'openai' ? e.OPENAI_API_KEY : undefined);

  return {
    env: e.NODE_ENV,
    isProd: e.NODE_ENV === 'production',
    host: e.HOST,
    port: e.PORT,
    dataDir,
    publicUrl: publicUrl.origin,
    rpId: publicUrl.hostname,
    secureCookies: publicUrl.protocol === 'https:',
    trustProxy: parseTrustProxy(e.TRUST_PROXY),
    logLevel: e.LOG_LEVEL,
    masterKey: e.MASTER_KEY,
    masterKeyFile: e.MASTER_KEY_FILE,
    setupToken: e.SETUP_TOKEN,
    sessionIdleMs: e.SESSION_IDLE_HOURS * 3600_000,
    sessionMaxMs: e.SESSION_MAX_DAYS * 86400_000,
    require2fa: e.REQUIRE_2FA,
    loginMaxAttempts: e.LOGIN_MAX_ATTEMPTS,
    loginLockMs: e.LOGIN_LOCK_MINUTES * 60_000,
    ipAllowlist: e.IP_ALLOWLIST,
    sshTargetAllowlist: e.SSH_TARGET_ALLOWLIST,
    cfAccess: e.CF_ACCESS_TEAM_DOMAIN && e.CF_ACCESS_AUD ? { teamDomain: e.CF_ACCESS_TEAM_DOMAIN, aud: e.CF_ACCESS_AUD } : null,
    terminalGraceMs: e.TERMINAL_GRACE_MINUTES * 60_000,
    maxSessionsPerUser: e.MAX_SESSIONS_PER_USER,
    scrollbackLines: e.SCROLLBACK_LINES,
    recordingsRetentionDays: e.RECORDINGS_RETENTION_DAYS,
    maxUploadBytes: e.MAX_UPLOAD_MB * 1024 * 1024,
    ai: {
      provider: aiProvider,
      model: e.AI_MODEL,
      baseUrl: e.AI_BASE_URL,
      apiKey: aiApiKey,
    },
    tldr: { enabled: e.TLDR_ENABLED, baseUrl: e.TLDR_BASE_URL.replace(/\/+$/, '') },
  };
}
