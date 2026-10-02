import type { FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../context.js';
import { Passkeys, Users, type UserRow } from '../db/models.js';
import type { SessionRow } from './sessions.js';

export interface AuthInfo {
  session: SessionRow;
  user: UserRow;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthInfo | null;
  }
}

export function cookieName(ctx: AppContext): string {
  // The __Host- prefix pins the cookie to this exact origin (Secure, Path=/, no Domain).
  return ctx.config.secureCookies ? '__Host-webssh_sid' : 'webssh_sid';
}

export function setSessionCookie(ctx: AppContext, reply: FastifyReply, token: string): void {
  reply.setCookie(cookieName(ctx), token, {
    httpOnly: true,
    secure: ctx.config.secureCookies,
    sameSite: 'strict',
    path: '/',
    maxAge: Math.floor(ctx.config.sessionMaxMs / 1000),
  });
}

export function clearSessionCookie(ctx: AppContext, reply: FastifyReply): void {
  reply.clearCookie(cookieName(ctx), { path: '/', secure: ctx.config.secureCookies, sameSite: 'strict', httpOnly: true });
}

/** Resolve session + user from the cookie. Disabled users are treated as logged out. */
export function resolveAuth(ctx: AppContext, req: FastifyRequest): AuthInfo | null {
  const token = req.cookies?.[cookieName(ctx)];
  const session = ctx.sessions.resolve(token);
  if (!session) return null;
  const user = Users.byId(ctx.db, session.user_id);
  if (!user || user.disabled) {
    ctx.sessions.revoke(session.id);
    return null;
  }
  return { session, user };
}

export function userHas2fa(ctx: AppContext, user: UserRow): boolean {
  return !!user.totp_enabled || Passkeys.count(ctx.db, user.id) > 0;
}

/** Whether this user is restricted to account-security routes until they fix something. */
export function pendingRequirements(ctx: AppContext, user: UserRow) {
  return {
    mustChangePassword: !!user.must_change_password,
    needs2faSetup: ctx.config.require2fa && !userHas2fa(ctx, user),
  };
}

function deny(reply: FastifyReply, status: number, error: string, extra: Record<string, unknown> = {}) {
  return reply.code(status).send({ error, ...extra });
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** CSRF: state-changing requests must echo the per-session token in a header. */
function csrfOk(req: FastifyRequest, session: SessionRow): boolean {
  if (SAFE_METHODS.has(req.method)) return true;
  const header = req.headers['x-csrf-token'];
  return typeof header === 'string' && header === session.csrf;
}

export function makeGuards(ctx: AppContext) {
  /** Fully authenticated, CSRF-checked; allowed even while enrolment is pending. */
  const account = async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = resolveAuth(ctx, req);
    if (!auth || auth.session.stage !== 'full') return deny(reply, 401, 'Not authenticated');
    if (!csrfOk(req, auth.session)) return deny(reply, 403, 'CSRF token missing or invalid');
    req.auth = auth;
  };

  /** Normal app access: full session and no pending security requirements. */
  const user = async (req: FastifyRequest, reply: FastifyReply) => {
    await account(req, reply);
    if (reply.sent || !req.auth) return;
    const p = pendingRequirements(ctx, req.auth.user);
    if (p.mustChangePassword) return deny(reply, 403, 'Password change required', { code: 'PASSWORD_CHANGE_REQUIRED' });
    if (p.needs2faSetup) return deny(reply, 403, 'Two-factor authentication setup required', { code: 'MFA_SETUP_REQUIRED' });
  };

  const admin = async (req: FastifyRequest, reply: FastifyReply) => {
    await user(req, reply);
    if (reply.sent || !req.auth) return;
    if (req.auth.user.role !== 'admin') return deny(reply, 403, 'Admin only');
  };

  /** Password accepted, second factor pending. */
  const mfa = async (req: FastifyRequest, reply: FastifyReply) => {
    const auth = resolveAuth(ctx, req);
    if (!auth || auth.session.stage !== 'mfa') return deny(reply, 401, 'No pending sign-in; start again');
    req.auth = auth;
  };

  return { account, user, admin, mfa };
}

export type Guards = ReturnType<typeof makeGuards>;
