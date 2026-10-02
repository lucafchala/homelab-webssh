import type { Db } from '../db/index.js';
import { randomToken, sha256 } from '../security/crypto.js';

export type SessionStage = 'mfa' | 'full';

export interface SessionRow {
  id: string;
  user_id: string;
  csrf: string;
  stage: SessionStage;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  ip: string | null;
  user_agent: string | null;
}

/** MFA-pending sessions only live long enough to type a code. */
const MFA_STAGE_TTL = 5 * 60_000;
const TOUCH_INTERVAL = 60_000;

/**
 * Server-side sessions. The cookie carries a random 256-bit token; the DB only
 * stores its SHA-256, so a leaked database cannot be replayed as cookies.
 */
export class SessionStore {
  constructor(
    private readonly db: Db,
    private readonly opts: { idleMs: number; maxMs: number },
  ) {}

  create(userId: string, stage: SessionStage, meta: { ip?: string; userAgent?: string }): { token: string; session: SessionRow } {
    const token = randomToken(32);
    const id = sha256(token);
    const t = Date.now();
    const expires = stage === 'mfa' ? t + MFA_STAGE_TTL : t + this.opts.maxMs;
    this.db.run(
      'INSERT INTO sessions (id, user_id, csrf, stage, created_at, last_seen_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      userId,
      randomToken(24),
      stage,
      t,
      t,
      expires,
      meta.ip ?? null,
      (meta.userAgent ?? '').slice(0, 300) || null,
    );
    return { token, session: this.db.get<SessionRow>('SELECT * FROM sessions WHERE id = ?', id)! };
  }

  /** Resolve a cookie token to a live session, enforcing idle + absolute expiry. */
  resolve(token: string | undefined): SessionRow | null {
    if (!token || token.length > 100) return null;
    const id = sha256(token);
    const s = this.db.get<SessionRow>('SELECT * FROM sessions WHERE id = ?', id);
    if (!s) return null;
    const t = Date.now();
    const idleLimit = s.stage === 'mfa' ? MFA_STAGE_TTL : this.opts.idleMs;
    if (s.expires_at <= t || s.last_seen_at + idleLimit <= t) {
      this.db.run('DELETE FROM sessions WHERE id = ?', id);
      return null;
    }
    if (t - s.last_seen_at > TOUCH_INTERVAL) {
      this.db.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', t, id);
      s.last_seen_at = t;
    }
    return s;
  }

  /** Validity check by stored id (for long-lived WebSockets); optionally counts as activity. */
  check(id: string, active: boolean): boolean {
    const s = this.db.get<SessionRow>('SELECT * FROM sessions WHERE id = ?', id);
    const t = Date.now();
    if (!s || s.stage !== 'full' || s.expires_at <= t || s.last_seen_at + this.opts.idleMs <= t) return false;
    if (active && t - s.last_seen_at > TOUCH_INTERVAL) this.db.run('UPDATE sessions SET last_seen_at = ? WHERE id = ?', t, id);
    return true;
  }

  /** Promote an MFA-pending session to a full one, rotating the token (prevents fixation). */
  promote(old: SessionRow): { token: string; session: SessionRow } {
    this.revoke(old.id);
    return this.create(old.user_id, 'full', { ip: old.ip ?? undefined, userAgent: old.user_agent ?? undefined });
  }

  revoke(id: string): void {
    this.db.run('DELETE FROM sessions WHERE id = ?', id);
  }

  revokeForUser(userId: string, id: string): number {
    return this.db.run('DELETE FROM sessions WHERE id = ? AND user_id = ?', id, userId).changes;
  }

  revokeAll(userId: string, exceptId?: string): number {
    if (exceptId) return this.db.run('DELETE FROM sessions WHERE user_id = ? AND id != ?', userId, exceptId).changes;
    return this.db.run('DELETE FROM sessions WHERE user_id = ?', userId).changes;
  }

  listForUser(userId: string): SessionRow[] {
    return this.db.all<SessionRow>("SELECT * FROM sessions WHERE user_id = ? AND stage = 'full' ORDER BY last_seen_at DESC", userId);
  }

  prune(): number {
    const t = Date.now();
    return this.db.run('DELETE FROM sessions WHERE expires_at <= ? OR last_seen_at <= ?', t, t - this.opts.idleMs).changes;
  }
}
