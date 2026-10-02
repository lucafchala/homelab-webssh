import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import QRCode from 'qrcode';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { AppContext } from '../context.js';
import { Passkeys, publicUser, Users, type UserRow } from '../db/models.js';
import { burnPasswordCheck, checkPasswordPolicy, hashPassword, verifyPassword } from '../security/password.js';
import { generateRecoveryCodes, generateTotpSecret, totpUri, verifyTotp } from '../security/totp.js';
import { randomToken, safeEqual, sha256 } from '../security/crypto.js';
import { TtlMap } from '../security/throttle.js';
import { clearSessionCookie, cookieName, pendingRequirements, setSessionCookie, userHas2fa, type Guards } from '../auth/guards.js';
import { actor, badRequest, clientIp, forbidden, HttpError, notFound, parse, sleep, userAgent } from '../util/http.js';

const USERNAME = z
  .string()
  .trim()
  .min(2)
  .max(64)
  .regex(/^[a-zA-Z0-9._-]+$/, 'Username may contain letters, digits, dot, dash and underscore');

const PASSKEY_COOKIE = 'webssh_pk';

export function registerAuthRoutes(app: FastifyInstance, ctx: AppContext, guards: Guards) {
  const { db, vault, audit, config } = ctx;
  /** WebAuthn challenges: keyed by session id (MFA / enrolment) or a random login nonce. */
  const challenges = new TtlMap<string>(5 * 60_000);
  /** TOTP secrets awaiting confirmation, keyed by user id. */
  const pendingTotp = new TtlMap<string>(10 * 60_000);

  const rp = { rpName: 'WebSSH', rpID: config.rpId, origin: config.publicUrl };

  function issueFullSession(reply: FastifyReply, req: FastifyRequest, user: UserRow) {
    const { token } = ctx.sessions.create(user.id, 'full', { ip: clientIp(req), userAgent: userAgent(req) });
    setSessionCookie(ctx, reply, token);
    Users.update(db, user.id, { last_login_at: Date.now(), failed_attempts: 0, locked_until: null });
  }

  function recordFailure(req: FastifyRequest, user: UserRow | undefined, username: string, reason: string) {
    ctx.ipThrottle.fail(clientIp(req));
    if (user) {
      const attempts = user.failed_attempts + 1;
      const lock = attempts >= config.loginMaxAttempts ? Date.now() + config.loginLockMs : null;
      Users.update(db, user.id, { failed_attempts: lock ? 0 : attempts, locked_until: lock ?? user.locked_until });
      if (lock) audit.write({ userId: user.id, username, ip: clientIp(req), action: 'auth.lockout', success: false });
    }
    audit.write({ userId: user?.id, username, ip: clientIp(req), action: 'auth.login', success: false, details: { reason } });
  }

  function checkIpThrottle(req: FastifyRequest) {
    const ip = clientIp(req);
    if (ctx.ipThrottle.blocked(ip)) {
      throw new HttpError(429, `Too many failed attempts. Try again in ${ctx.ipThrottle.retryAfter(ip)}s`);
    }
  }

  function mePayload(req: FastifyRequest) {
    const { user, session } = req.auth!;
    const ai = ctx.settings.ai();
    return {
      user: publicUser(user, { passkeys: Passkeys.count(db, user.id) }),
      csrf: session.csrf,
      ...pendingRequirements(ctx, user),
      features: {
        ai: !!ai && (ai.provider === 'ollama' || !!ai.apiKey),
        aiProvider: ai?.provider ?? 'none',
        aiModel: ai?.model ?? null,
        aiAutoApproveReadOnly: ai?.autoApproveReadOnly ?? false,
        tldr: config.tldr.enabled,
        recording: ctx.settings.get().recording,
        allowUserHosts: ctx.settings.get().allowUserHosts || user.role === 'admin',
        require2fa: config.require2fa,
        terminalGraceMinutes: Math.round(config.terminalGraceMs / 60000),
        maxUploadBytes: config.maxUploadBytes,
      },
    };
  }

  // ------------------------------------------------------------------ public state
  app.get('/api/auth/state', async (req) => {
    const setupRequired = Users.count(db) === 0;
    return {
      setupRequired,
      loginBanner: ctx.settings.get().loginBanner,
      passkeys: true,
    };
  });

  // ------------------------------------------------------------------ first-run setup
  app.post('/api/auth/setup', async (req, reply) => {
    const body = parse(z.object({ token: z.string().min(1), username: USERNAME, password: z.string(), displayName: z.string().max(100).optional() }), req.body);
    checkIpThrottle(req);
    if (Users.count(db) > 0 || !ctx.setupToken) throw forbidden('Setup already completed');
    if (!safeEqual(body.token.trim(), ctx.setupToken)) {
      ctx.ipThrottle.fail(clientIp(req));
      audit.write({ ip: clientIp(req), action: 'auth.setup', success: false, details: { reason: 'bad token' } });
      throw forbidden('Invalid setup token (see the server logs)');
    }
    const policy = checkPasswordPolicy(body.password, body.username);
    if (policy) throw badRequest(policy);
    const user = db.tx(() => {
      if (Users.count(db) > 0) throw forbidden('Setup already completed');
      return Users.create(db, { username: body.username, passwordHash: '', role: 'admin', displayName: body.displayName });
    });
    Users.update(db, user.id, { password_hash: await hashPassword(body.password) });
    ctx.setupToken = null;
    audit.write({ userId: user.id, username: user.username, ip: clientIp(req), action: 'auth.setup' });
    issueFullSession(reply, req, user);
    return { ok: true };
  });

  // ------------------------------------------------------------------ password login
  app.post('/api/auth/login', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
    const body = parse(z.object({ username: z.string().trim().min(1).max(64), password: z.string().min(1).max(1024) }), req.body);
    checkIpThrottle(req);
    const user = Users.byUsername(db, body.username);
    if (!user) {
      await burnPasswordCheck(body.password);
      recordFailure(req, undefined, body.username, 'unknown user');
      await sleep(300 + Math.random() * 300);
      throw new HttpError(401, 'Invalid username or password');
    }
    if (user.locked_until && user.locked_until > Date.now()) {
      audit.write({ userId: user.id, username: user.username, ip: clientIp(req), action: 'auth.login', success: false, details: { reason: 'locked' } });
      throw new HttpError(423, 'Account temporarily locked after too many failed attempts');
    }
    const ok = await verifyPassword(body.password, user.password_hash);
    if (!ok || user.disabled) {
      recordFailure(req, user, user.username, user.disabled ? 'disabled' : 'bad password');
      await sleep(300 + Math.random() * 300);
      throw new HttpError(401, 'Invalid username or password');
    }
    ctx.ipThrottle.reset(clientIp(req));
    if (userHas2fa(ctx, user)) {
      const { token } = ctx.sessions.create(user.id, 'mfa', { ip: clientIp(req), userAgent: userAgent(req) });
      setSessionCookie(ctx, reply, token);
      Users.update(db, user.id, { failed_attempts: 0 });
      return { mfa: { totp: !!user.totp_enabled, passkey: Passkeys.count(db, user.id) > 0 } };
    }
    issueFullSession(reply, req, user);
    audit.write({ userId: user.id, username: user.username, ip: clientIp(req), action: 'auth.login', details: { method: 'password' } });
    return { ok: true };
  });

  // ------------------------------------------------------------------ second factor: TOTP / recovery code
  app.post('/api/auth/mfa/totp', { preHandler: guards.mfa, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
    const { code } = parse(z.object({ code: z.string().trim().min(6).max(20) }), req.body);
    checkIpThrottle(req);
    const { session, user } = req.auth!;
    let method = 'totp';
    let ok = false;
    if (/^[a-z2-7]{5}-[a-z2-7]{5}$/i.test(code)) {
      // Recovery code (single use)
      const codes: string[] = user.recovery_codes ? JSON.parse(user.recovery_codes) : [];
      const h = sha256(code.toLowerCase());
      if (codes.includes(h)) {
        Users.update(db, user.id, { recovery_codes: JSON.stringify(codes.filter((c) => c !== h)) });
        ok = true;
        method = 'recovery-code';
      }
    } else if (user.totp_enabled && user.totp_secret_enc) {
      const secret = vault.decryptString(user.totp_secret_enc, `totp:${user.id}`);
      const step = verifyTotp(secret, code, { lastUsedStep: user.totp_last_step });
      if (step !== null) {
        Users.update(db, user.id, { totp_last_step: step });
        ok = true;
      }
    }
    if (!ok) {
      recordFailure(req, user, user.username, 'bad 2fa code');
      throw new HttpError(401, 'Invalid code');
    }
    const { token } = ctx.sessions.promote(session);
    setSessionCookie(ctx, reply, token);
    Users.update(db, user.id, { last_login_at: Date.now(), failed_attempts: 0 });
    audit.write({ userId: user.id, username: user.username, ip: clientIp(req), action: 'auth.login', details: { method } });
    return { ok: true };
  });

  // ------------------------------------------------------------------ second factor: passkey
  app.post('/api/auth/mfa/passkey/options', { preHandler: guards.mfa }, async (req) => {
    const { session, user } = req.auth!;
    const creds = Passkeys.byUser(db, user.id);
    if (!creds.length) throw badRequest('No passkeys registered');
    const options = await generateAuthenticationOptions({
      rpID: rp.rpID,
      userVerification: 'preferred',
      allowCredentials: creds.map((c) => ({ id: c.id, transports: JSON.parse(c.transports ?? '[]') })),
    });
    challenges.set(`mfa:${session.id}`, options.challenge);
    return options;
  });

  app.post('/api/auth/mfa/passkey/verify', { preHandler: guards.mfa }, async (req, reply) => {
    const { session, user } = req.auth!;
    const response = (req.body as { response?: AuthenticationResponseJSON })?.response;
    const expected = challenges.take(`mfa:${session.id}`);
    if (!response || !expected) throw badRequest('Missing or expired challenge');
    const cred = Passkeys.byId(db, response.id);
    if (!cred || cred.user_id !== user.id) {
      recordFailure(req, user, user.username, 'unknown passkey');
      throw new HttpError(401, 'Passkey not recognised');
    }
    await verifyPasskeyAssertion(response, expected, cred, false);
    const { token } = ctx.sessions.promote(session);
    setSessionCookie(ctx, reply, token);
    Users.update(db, user.id, { last_login_at: Date.now(), failed_attempts: 0 });
    audit.write({ userId: user.id, username: user.username, ip: clientIp(req), action: 'auth.login', details: { method: 'password+passkey' } });
    return { ok: true };
  });

  // ------------------------------------------------------------------ passwordless passkey login
  app.post('/api/auth/passkey/options', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    checkIpThrottle(req);
    const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: 'required' });
    const nonce = randomToken(16);
    challenges.set(`login:${nonce}`, options.challenge);
    reply.setCookie(PASSKEY_COOKIE, nonce, { httpOnly: true, secure: config.secureCookies, sameSite: 'strict', path: '/api/auth/passkey', maxAge: 300 });
    return options;
  });

  app.post('/api/auth/passkey/verify', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req, reply) => {
    checkIpThrottle(req);
    const response = (req.body as { response?: AuthenticationResponseJSON })?.response;
    const nonce = req.cookies[PASSKEY_COOKIE];
    const expected = nonce ? challenges.take(`login:${nonce}`) : undefined;
    reply.clearCookie(PASSKEY_COOKIE, { path: '/api/auth/passkey' });
    if (!response || !expected) throw badRequest('Missing or expired challenge');
    const cred = Passkeys.byId(db, response.id);
    const user = cred ? Users.byId(db, cred.user_id) : undefined;
    if (!cred || !user || user.disabled) {
      recordFailure(req, user, user?.username ?? '(passkey)', 'unknown passkey');
      throw new HttpError(401, 'Passkey not recognised');
    }
    if (user.locked_until && user.locked_until > Date.now()) throw new HttpError(423, 'Account temporarily locked');
    await verifyPasskeyAssertion(response, expected, cred, true);
    issueFullSession(reply, req, user);
    audit.write({ userId: user.id, username: user.username, ip: clientIp(req), action: 'auth.login', details: { method: 'passkey' } });
    return { ok: true };
  });

  async function verifyPasskeyAssertion(
    response: AuthenticationResponseJSON,
    expectedChallenge: string,
    cred: NonNullable<ReturnType<typeof Passkeys.byId>>,
    requireUv: boolean,
  ) {
    let verification;
    try {
      verification = await verifyAuthenticationResponse({
        response,
        expectedChallenge,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
        requireUserVerification: requireUv,
        credential: {
          id: cred.id,
          publicKey: new Uint8Array(cred.public_key),
          counter: cred.counter,
          transports: JSON.parse(cred.transports ?? '[]'),
        },
      });
    } catch (err) {
      throw new HttpError(401, `Passkey verification failed: ${(err as Error).message}`);
    }
    if (!verification.verified) throw new HttpError(401, 'Passkey verification failed');
    Passkeys.touch(db, cred.id, verification.authenticationInfo.newCounter);
  }

  // ------------------------------------------------------------------ logout / me
  app.post('/api/auth/logout', async (req, reply) => {
    const s = ctx.sessions.resolve(req.cookies[cookieName(ctx)]);
    if (s) {
      // Logout is allowed without CSRF only for MFA-stage sessions; full sessions must present it.
      if (s.stage === 'full' && req.headers['x-csrf-token'] !== s.csrf) throw forbidden('CSRF token missing or invalid');
      ctx.sessions.revoke(s.id);
      const u = Users.byId(db, s.user_id);
      audit.write({ userId: s.user_id, username: u?.username, ip: clientIp(req), action: 'auth.logout' });
    }
    clearSessionCookie(ctx, reply);
    return { ok: true };
  });

  app.get('/api/me', { preHandler: guards.account }, async (req) => mePayload(req));

  app.put('/api/me/settings', { preHandler: guards.account }, async (req) => {
    const body = parse(z.record(z.string(), z.unknown()), req.body);
    const json = JSON.stringify(body);
    if (json.length > 32_000) throw badRequest('Settings too large');
    Users.update(db, req.auth!.user.id, { settings: json });
    return { ok: true };
  });

  app.put('/api/me/profile', { preHandler: guards.account }, async (req) => {
    const body = parse(z.object({ displayName: z.string().trim().max(100) }), req.body);
    Users.update(db, req.auth!.user.id, { display_name: body.displayName || null });
    return { ok: true };
  });

  app.post('/api/me/password', { preHandler: guards.account, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const body = parse(z.object({ current: z.string().min(1).max(1024), next: z.string().max(1024) }), req.body);
    const { user, session } = req.auth!;
    if (!(await verifyPassword(body.current, user.password_hash))) {
      audit.write({ ...actor(req), action: 'auth.password_change', success: false });
      throw new HttpError(401, 'Current password is incorrect');
    }
    const policy = checkPasswordPolicy(body.next, user.username);
    if (policy) throw badRequest(policy);
    if (body.next === body.current) throw badRequest('New password must differ from the current one');
    Users.update(db, user.id, { password_hash: await hashPassword(body.next), must_change_password: 0 });
    const revoked = ctx.sessions.revokeAll(user.id, session.id);
    audit.write({ ...actor(req), action: 'auth.password_change', details: { revokedSessions: revoked } });
    return { ok: true, revokedSessions: revoked };
  });

  // ------------------------------------------------------------------ TOTP enrolment
  app.post('/api/me/totp/setup', { preHandler: guards.account }, async (req) => {
    const { user } = req.auth!;
    const secret = generateTotpSecret();
    pendingTotp.set(user.id, secret);
    const uri = totpUri(secret, user.username, `WebSSH (${config.rpId})`);
    const qr = await QRCode.toDataURL(uri, { margin: 1, width: 240, errorCorrectionLevel: 'M' });
    return { secret, uri, qr };
  });

  app.post('/api/me/totp/enable', { preHandler: guards.account }, async (req) => {
    const { code } = parse(z.object({ code: z.string().trim() }), req.body);
    const { user } = req.auth!;
    const secret = pendingTotp.get(user.id);
    if (!secret) throw badRequest('Enrolment expired, start again');
    const step = verifyTotp(secret, code);
    if (step === null) throw badRequest('Code did not match — check the time on your phone and try again');
    pendingTotp.delete(user.id);
    const codes = generateRecoveryCodes();
    Users.update(db, user.id, {
      totp_secret_enc: vault.encrypt(secret, `totp:${user.id}`),
      totp_enabled: 1,
      totp_last_step: step,
      recovery_codes: JSON.stringify(codes.map((c) => sha256(c))),
    });
    audit.write({ ...actor(req), action: 'auth.totp_enable' });
    return { ok: true, recoveryCodes: codes };
  });

  app.post('/api/me/totp/disable', { preHandler: guards.account }, async (req) => {
    const { password } = parse(z.object({ password: z.string().min(1) }), req.body);
    const { user } = req.auth!;
    if (!(await verifyPassword(password, user.password_hash))) throw new HttpError(401, 'Password is incorrect');
    if (config.require2fa && Passkeys.count(db, user.id) === 0) {
      throw badRequest('Two-factor authentication is required on this server; add a passkey before disabling TOTP');
    }
    Users.update(db, user.id, { totp_enabled: 0, totp_secret_enc: null, totp_last_step: null, recovery_codes: null });
    audit.write({ ...actor(req), action: 'auth.totp_disable' });
    return { ok: true };
  });

  app.post('/api/me/recovery-codes', { preHandler: guards.account }, async (req) => {
    const { password } = parse(z.object({ password: z.string().min(1) }), req.body);
    const { user } = req.auth!;
    if (!(await verifyPassword(password, user.password_hash))) throw new HttpError(401, 'Password is incorrect');
    if (!userHas2fa(ctx, user)) throw badRequest('Enable two-factor authentication first');
    const codes = generateRecoveryCodes();
    Users.update(db, user.id, { recovery_codes: JSON.stringify(codes.map((c) => sha256(c))) });
    audit.write({ ...actor(req), action: 'auth.recovery_codes' });
    return { recoveryCodes: codes };
  });

  // ------------------------------------------------------------------ passkey management
  app.get('/api/me/passkeys', { preHandler: guards.account }, async (req) =>
    Passkeys.byUser(db, req.auth!.user.id).map((p) => ({
      id: p.id,
      name: p.name,
      deviceType: p.device_type,
      backedUp: !!p.backed_up,
      createdAt: p.created_at,
      lastUsedAt: p.last_used_at,
    })),
  );

  app.post('/api/me/passkeys/options', { preHandler: guards.account }, async (req) => {
    const { user, session } = req.auth!;
    const existing = Passkeys.byUser(db, user.id);
    const options = await generateRegistrationOptions({
      rpName: rp.rpName,
      rpID: rp.rpID,
      userName: user.username,
      userDisplayName: user.display_name ?? user.username,
      userID: new TextEncoder().encode(user.id),
      attestationType: 'none',
      excludeCredentials: existing.map((c) => ({ id: c.id, transports: JSON.parse(c.transports ?? '[]') })),
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    });
    challenges.set(`reg:${session.id}`, options.challenge);
    return options;
  });

  app.post('/api/me/passkeys/verify', { preHandler: guards.account }, async (req) => {
    const body = req.body as { response?: RegistrationResponseJSON; name?: string };
    const { user, session } = req.auth!;
    const expected = challenges.take(`reg:${session.id}`);
    if (!body?.response || !expected) throw badRequest('Missing or expired challenge');
    let verification;
    try {
      verification = await verifyRegistrationResponse({
        response: body.response,
        expectedChallenge: expected,
        expectedOrigin: rp.origin,
        expectedRPID: rp.rpID,
        requireUserVerification: false,
      });
    } catch (err) {
      throw badRequest(`Passkey registration failed: ${(err as Error).message}`);
    }
    if (!verification.verified) throw badRequest('Passkey registration failed');
    const info = verification.registrationInfo;
    const name = (body.name ?? '').trim().slice(0, 64) || `Passkey ${Passkeys.count(db, user.id) + 1}`;
    Passkeys.create(db, {
      id: info.credential.id,
      userId: user.id,
      publicKey: info.credential.publicKey,
      counter: info.credential.counter,
      transports: info.credential.transports,
      name,
      deviceType: info.credentialDeviceType,
      backedUp: info.credentialBackedUp,
    });
    audit.write({ ...actor(req), action: 'auth.passkey_add', target: name });
    return { ok: true };
  });

  app.patch('/api/me/passkeys/:id', { preHandler: guards.account }, async (req) => {
    const { name } = parse(z.object({ name: z.string().trim().min(1).max(64) }), req.body);
    const { id } = req.params as { id: string };
    if (!Passkeys.rename(db, req.auth!.user.id, id, name)) throw notFound();
    return { ok: true };
  });

  app.delete('/api/me/passkeys/:id', { preHandler: guards.account }, async (req) => {
    const { id } = req.params as { id: string };
    const { user } = req.auth!;
    if (config.require2fa && !user.totp_enabled && Passkeys.count(db, user.id) <= 1) {
      throw badRequest('This is your only second factor; enable TOTP or add another passkey first');
    }
    if (!Passkeys.delete(db, user.id, id)) throw notFound();
    audit.write({ ...actor(req), action: 'auth.passkey_remove', target: id });
    return { ok: true };
  });

  // ------------------------------------------------------------------ login sessions
  app.get('/api/me/sessions', { preHandler: guards.account }, async (req) => {
    const current = req.auth!.session.id;
    return ctx.sessions.listForUser(req.auth!.user.id).map((s) => ({
      id: s.id.slice(0, 16),
      current: s.id === current,
      createdAt: s.created_at,
      lastSeenAt: s.last_seen_at,
      ip: s.ip,
      userAgent: s.user_agent,
    }));
  });

  app.delete('/api/me/sessions/:id', { preHandler: guards.account }, async (req) => {
    const { id } = req.params as { id: string };
    const target = ctx.sessions.listForUser(req.auth!.user.id).find((s) => s.id.startsWith(id) && id.length >= 16);
    if (!target) throw notFound();
    ctx.sessions.revoke(target.id);
    audit.write({ ...actor(req), action: 'auth.session_revoke' });
    return { ok: true };
  });

  app.post('/api/me/sessions/revoke-others', { preHandler: guards.account }, async (req) => {
    const n = ctx.sessions.revokeAll(req.auth!.user.id, req.auth!.session.id);
    audit.write({ ...actor(req), action: 'auth.session_revoke_all', details: { count: n } });
    return { ok: true, revoked: n };
  });
}
