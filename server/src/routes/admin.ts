import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { Passkeys, publicUser, Users } from '../db/models.js';
import { checkPasswordPolicy, hashPassword } from '../security/password.js';
import { AI_PROVIDERS, AppSettingsSchema } from '../appSettings.js';
import type { Guards } from '../auth/guards.js';
import { actor, badRequest, conflict, notFound, parse } from '../util/http.js';
import { testAiProvider } from '../ai/providers.js';

const USERNAME = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[a-zA-Z0-9._-]+$/);

export function registerAdminRoutes(app: FastifyInstance, ctx: AppContext, guards: Guards) {
  const { db, audit } = ctx;
  const pre = { preHandler: guards.admin };

  // ------------------------------------------------------------------ users
  app.get('/api/admin/users', pre, async () => Users.list(db).map((u) => publicUser(u, { passkeys: Passkeys.count(db, u.id) })));

  app.post('/api/admin/users', pre, async (req) => {
    const body = parse(
      z.object({ username: USERNAME, password: z.string(), role: z.enum(['admin', 'user']), displayName: z.string().max(100).optional() }),
      req.body,
    );
    if (Users.byUsername(db, body.username)) throw conflict('Username already exists');
    const policy = checkPasswordPolicy(body.password, body.username);
    if (policy) throw badRequest(policy);
    const user = Users.create(db, {
      username: body.username,
      passwordHash: await hashPassword(body.password),
      role: body.role,
      displayName: body.displayName,
      mustChangePassword: true,
    });
    audit.write({ ...actor(req), action: 'admin.user_create', target: user.username, details: { role: body.role } });
    return publicUser(user);
  });

  app.patch('/api/admin/users/:id', pre, async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(
      z.object({ role: z.enum(['admin', 'user']).optional(), disabled: z.boolean().optional(), displayName: z.string().max(100).optional() }),
      req.body,
    );
    const target = Users.byId(db, id);
    if (!target) throw notFound();
    const self = id === req.auth!.user.id;
    if (self && (body.disabled || body.role === 'user')) throw badRequest('You cannot demote or disable yourself');
    if (target.role === 'admin' && (body.role === 'user' || body.disabled) && Users.adminCount(db) <= 1) {
      throw badRequest('At least one active admin is required');
    }
    Users.update(db, id, {
      ...(body.role ? { role: body.role } : {}),
      ...(body.disabled !== undefined ? { disabled: body.disabled ? 1 : 0 } : {}),
      ...(body.displayName !== undefined ? { display_name: body.displayName || null } : {}),
    });
    if (body.disabled) {
      ctx.sessions.revokeAll(id);
      ctx.terminals.closeAllForUser(id, 'Account disabled');
    }
    audit.write({ ...actor(req), action: 'admin.user_update', target: target.username, details: body });
    return publicUser(Users.byId(db, id)!);
  });

  app.post('/api/admin/users/:id/reset-password', pre, async (req) => {
    const { id } = req.params as { id: string };
    const { password } = parse(z.object({ password: z.string() }), req.body);
    const target = Users.byId(db, id);
    if (!target) throw notFound();
    const policy = checkPasswordPolicy(password, target.username);
    if (policy) throw badRequest(policy);
    Users.update(db, id, { password_hash: await hashPassword(password), must_change_password: 1, failed_attempts: 0, locked_until: null });
    ctx.sessions.revokeAll(id);
    audit.write({ ...actor(req), action: 'admin.user_reset_password', target: target.username });
    return { ok: true };
  });

  app.post('/api/admin/users/:id/reset-2fa', pre, async (req) => {
    const { id } = req.params as { id: string };
    const target = Users.byId(db, id);
    if (!target) throw notFound();
    db.tx(() => {
      Users.update(db, id, { totp_enabled: 0, totp_secret_enc: null, totp_last_step: null, recovery_codes: null });
      db.run('DELETE FROM webauthn_credentials WHERE user_id = ?', id);
    });
    ctx.sessions.revokeAll(id);
    audit.write({ ...actor(req), action: 'admin.user_reset_2fa', target: target.username });
    return { ok: true };
  });

  app.post('/api/admin/users/:id/unlock', pre, async (req) => {
    const { id } = req.params as { id: string };
    const target = Users.byId(db, id);
    if (!target) throw notFound();
    Users.update(db, id, { failed_attempts: 0, locked_until: null });
    audit.write({ ...actor(req), action: 'admin.user_unlock', target: target.username });
    return { ok: true };
  });

  app.delete('/api/admin/users/:id', pre, async (req) => {
    const { id } = req.params as { id: string };
    const target = Users.byId(db, id);
    if (!target) throw notFound();
    if (id === req.auth!.user.id) throw badRequest('You cannot delete yourself');
    if (target.role === 'admin' && Users.adminCount(db) <= 1) throw badRequest('At least one active admin is required');
    ctx.terminals.closeAllForUser(id, 'Account deleted');
    Users.delete(db, id);
    audit.write({ ...actor(req), action: 'admin.user_delete', target: target.username });
    return { ok: true };
  });

  // ------------------------------------------------------------------ audit log
  app.get('/api/admin/audit', pre, async (req) => {
    const q = parse(
      z.object({
        userId: z.string().optional(),
        action: z.string().max(64).optional(),
        q: z.string().max(200).optional(),
        before: z.coerce.number().int().optional(),
        limit: z.coerce.number().int().min(1).max(500).optional(),
        failed: z.enum(['0', '1']).optional(),
      }),
      req.query,
    );
    return audit.query({ ...q, failedOnly: q.failed === '1' });
  });

  // ------------------------------------------------------------------ live terminal sessions (all users)
  app.get('/api/admin/terminals', pre, async () => ctx.terminals.listAll());

  app.delete('/api/admin/terminals/:id', pre, async (req) => {
    const { id } = req.params as { id: string };
    if (!ctx.terminals.close(id, 'Closed by an administrator')) throw notFound();
    audit.write({ ...actor(req), action: 'admin.terminal_kill', target: id });
    return { ok: true };
  });

  // ------------------------------------------------------------------ settings
  app.get('/api/admin/settings', pre, async () => ({
    settings: ctx.settings.publicView(),
    env: {
      publicUrl: ctx.config.publicUrl,
      require2fa: ctx.config.require2fa,
      sessionIdleHours: ctx.config.sessionIdleMs / 3600_000,
      sessionMaxDays: ctx.config.sessionMaxMs / 86400_000,
      ipAllowlist: ctx.config.ipAllowlist,
      sshTargetAllowlist: ctx.config.sshTargetAllowlist,
      cfAccess: !!ctx.config.cfAccess,
      terminalGraceMinutes: ctx.config.terminalGraceMs / 60000,
      recordingsRetentionDays: ctx.config.recordingsRetentionDays,
      tldr: ctx.config.tldr.enabled,
      trustProxy: ctx.config.trustProxy,
    },
  }));

  const SettingsUpdate = z.object({
    recording: z.enum(['off', 'per-host', 'all']).optional(),
    loginBanner: z.string().max(2000).optional(),
    allowUserHosts: z.boolean().optional(),
    ai: z
      .object({
        provider: z.enum(AI_PROVIDERS).optional(),
        model: z.string().max(200).optional(),
        baseUrl: z
          .string()
          .max(500)
          .refine((v) => v === '' || /^https?:\/\//.test(v), 'Base URL must start with http:// or https://')
          .optional(),
        /** undefined = keep, '' = clear, other = set */
        apiKey: z.string().max(500).optional(),
        autoApproveReadOnly: z.boolean().optional(),
        maxTokens: z.number().int().min(1024).max(64000).optional(),
      })
      .optional(),
  });

  app.put('/api/admin/settings', pre, async (req) => {
    const body = parse(SettingsUpdate, req.body);
    const cur = ctx.settings.get();
    const { apiKey, ...aiRest } = body.ai ?? {};
    const next = AppSettingsSchema.parse({
      ...cur,
      ...(body.recording ? { recording: body.recording } : {}),
      ...(body.loginBanner !== undefined ? { loginBanner: body.loginBanner } : {}),
      ...(body.allowUserHosts !== undefined ? { allowUserHosts: body.allowUserHosts } : {}),
      ai: {
        ...cur.ai,
        ...aiRest,
        apiKeyEnc: apiKey === undefined ? cur.ai.apiKeyEnc : apiKey === '' ? null : ctx.vault.encrypt(apiKey, 'ai-key'),
      },
    });
    ctx.settings.save(next);
    audit.write({
      ...actor(req),
      action: 'admin.settings_update',
      details: { ...body, ai: body.ai ? { ...aiRest, apiKey: apiKey === undefined ? undefined : apiKey ? '(set)' : '(cleared)' } : undefined },
    });
    return ctx.settings.publicView();
  });

  app.post('/api/admin/settings/ai-test', pre, async () => {
    const ai = ctx.settings.ai();
    if (!ai) throw badRequest('AI provider is disabled');
    return testAiProvider(ai);
  });
}
