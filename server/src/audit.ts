import type { FastifyBaseLogger } from 'fastify';
import type { Db } from './db/index.js';

export interface AuditEntry {
  userId?: string | null;
  username?: string | null;
  ip?: string | null;
  action: string;
  target?: string | null;
  success?: boolean;
  details?: Record<string, unknown> | null;
}

export interface AuditRow {
  id: number;
  ts: number;
  user_id: string | null;
  username: string | null;
  ip: string | null;
  action: string;
  target: string | null;
  success: number;
  details: string | null;
}

/**
 * Audit trail: persisted to SQLite (viewable by admins) and mirrored to the
 * structured log so fail2ban / CrowdSec / Loki can act on it. Failed logins
 * produce a stable line: `webssh auth failure ip=<ip> user=<name>`.
 */
export class Audit {
  constructor(
    private readonly db: Db,
    private readonly log: FastifyBaseLogger,
  ) {}

  write(e: AuditEntry): void {
    const success = e.success ?? true;
    try {
      this.db.run(
        'INSERT INTO audit_log (ts, user_id, username, ip, action, target, success, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        Date.now(),
        e.userId ?? null,
        e.username ?? null,
        e.ip ?? null,
        e.action,
        e.target ?? null,
        success ? 1 : 0,
        e.details ? JSON.stringify(e.details) : null,
      );
    } catch (err) {
      this.log.error({ err }, 'failed to write audit log');
    }
    const payload = { audit: true, action: e.action, user: e.username, ip: e.ip, target: e.target, success };
    if (!success && e.action.startsWith('auth.')) {
      this.log.warn(payload, `webssh auth failure ip=${e.ip ?? '-'} user=${e.username ?? '-'}`);
    } else {
      this.log.info(payload, `audit ${e.action}`);
    }
  }

  query(opts: { userId?: string; action?: string; q?: string; before?: number; limit?: number; failedOnly?: boolean }) {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.userId) {
      where.push('user_id = ?');
      params.push(opts.userId);
    }
    if (opts.action) {
      where.push('action LIKE ?');
      params.push(`${opts.action}%`);
    }
    if (opts.q) {
      where.push('(username LIKE ? OR target LIKE ? OR details LIKE ? OR ip LIKE ?)');
      const like = `%${opts.q}%`;
      params.push(like, like, like, like);
    }
    if (opts.before) {
      where.push('id < ?');
      params.push(opts.before);
    }
    if (opts.failedOnly) where.push('success = 0');
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const sql = `SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ${limit}`;
    return this.db.all<AuditRow>(sql, ...params).map((r) => ({
      id: r.id,
      ts: r.ts,
      userId: r.user_id,
      username: r.username,
      ip: r.ip,
      action: r.action,
      target: r.target,
      success: !!r.success,
      details: r.details ? JSON.parse(r.details) : null,
    }));
  }

  prune(retentionDays: number): number {
    return this.db.run('DELETE FROM audit_log WHERE ts < ?', Date.now() - retentionDays * 86400_000).changes;
  }
}
