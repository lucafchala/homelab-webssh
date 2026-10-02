import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import path from 'node:path';
import { MIGRATIONS } from './migrations.js';

export type Param = SQLInputValue;

/** Thin synchronous wrapper around node:sqlite (no native addon needed). */
export class Db {
  readonly raw: DatabaseSync;
  private readonly cache = new Map<string, ReturnType<DatabaseSync['prepare']>>();

  constructor(file: string) {
    this.raw = new DatabaseSync(file);
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA foreign_keys = ON');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    this.raw.exec('PRAGMA synchronous = NORMAL');
  }

  static open(dataDir: string): Db {
    const db = new Db(path.join(dataDir, 'webssh.db'));
    db.migrate();
    return db;
  }

  static memory(): Db {
    const db = new Db(':memory:');
    db.migrate();
    return db;
  }

  private stmt(sql: string) {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  get<T = Record<string, unknown>>(sql: string, ...params: Param[]): T | undefined {
    return this.stmt(sql).get(...params) as T | undefined;
  }

  all<T = Record<string, unknown>>(sql: string, ...params: Param[]): T[] {
    return this.stmt(sql).all(...params) as T[];
  }

  run(sql: string, ...params: Param[]): { changes: number; lastInsertRowid: number | bigint } {
    const r = this.stmt(sql).run(...params);
    return { changes: Number(r.changes), lastInsertRowid: r.lastInsertRowid };
  }

  tx<T>(fn: () => T): T {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (err) {
      this.raw.exec('ROLLBACK');
      throw err;
    }
  }

  migrate(): void {
    const row = this.raw.prepare('PRAGMA user_version').get() as { user_version: number };
    let version = row.user_version;
    for (let i = version; i < MIGRATIONS.length; i++) {
      this.tx(() => {
        this.raw.exec(MIGRATIONS[i]);
        this.raw.exec(`PRAGMA user_version = ${i + 1}`);
      });
      version = i + 1;
    }
  }

  close(): void {
    this.cache.clear();
    this.raw.close();
  }
}

export const now = () => Date.now();

export function parseJson<T>(text: string | null | undefined, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
