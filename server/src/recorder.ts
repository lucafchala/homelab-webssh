import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { Db } from './db/index.js';
import { newId } from './security/crypto.js';

export interface RecordingRow {
  id: string;
  user_id: string;
  host_id: string | null;
  host_name: string;
  session_id: string;
  cols: number;
  rows: number;
  size: number;
  started_at: number;
  ended_at: number | null;
}

/** One in-progress asciicast v2 recording (https://docs.asciinema.org/manual/asciicast/v2/). */
export class RecordingHandle {
  private readonly decoder = new StringDecoder('utf8');
  private readonly stream: fs.WriteStream;
  private readonly t0 = Date.now();
  private bytes = 0;
  private ended = false;

  constructor(
    readonly id: string,
    file: string,
    header: Record<string, unknown>,
    private readonly onEnd: (size: number) => void,
  ) {
    this.stream = fs.createWriteStream(file, { flags: 'w', mode: 0o600 });
    this.writeLine(header);
  }

  private writeLine(v: unknown) {
    const line = JSON.stringify(v) + '\n';
    this.bytes += Buffer.byteLength(line);
    this.stream.write(line);
  }

  private elapsed() {
    return Math.round(Date.now() - this.t0) / 1000;
  }

  output(chunk: Buffer) {
    if (this.ended) return;
    const text = this.decoder.write(chunk);
    if (text) this.writeLine([this.elapsed(), 'o', text]);
  }

  resize(cols: number, rows: number) {
    if (!this.ended) this.writeLine([this.elapsed(), 'r', `${cols}x${rows}`]);
  }

  marker(label: string) {
    if (!this.ended) this.writeLine([this.elapsed(), 'm', label]);
  }

  end() {
    if (this.ended) return;
    const rest = this.decoder.end();
    if (rest) this.writeLine([this.elapsed(), 'o', rest]);
    this.ended = true;
    this.stream.end(() => this.onEnd(this.bytes));
  }
}

export class Recorder {
  readonly dir: string;

  constructor(
    private readonly db: Db,
    dataDir: string,
  ) {
    this.dir = path.join(dataDir, 'recordings');
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  file(id: string): string {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('bad recording id');
    return path.join(this.dir, `${id}.cast`);
  }

  start(meta: { userId: string; hostId: string; hostName: string; sessionId: string; cols: number; rows: number; title: string }): RecordingHandle {
    const id = newId();
    const startedAt = Date.now();
    this.db.run(
      'INSERT INTO recordings (id, user_id, host_id, host_name, session_id, cols, rows, size, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)',
      id,
      meta.userId,
      meta.hostId,
      meta.hostName,
      meta.sessionId,
      meta.cols,
      meta.rows,
      startedAt,
    );
    return new RecordingHandle(
      id,
      this.file(id),
      { version: 2, width: meta.cols, height: meta.rows, timestamp: Math.floor(startedAt / 1000), title: meta.title, env: { TERM: 'xterm-256color' } },
      (size) => this.db.run('UPDATE recordings SET ended_at = ?, size = ? WHERE id = ?', Date.now(), size, id),
    );
  }

  list(userId: string | null, limit = 200) {
    const rows = userId
      ? this.db.all<RecordingRow & { username: string }>(
          'SELECT r.*, u.username FROM recordings r JOIN users u ON u.id = r.user_id WHERE r.user_id = ? ORDER BY r.started_at DESC LIMIT ?',
          userId,
          limit,
        )
      : this.db.all<RecordingRow & { username: string }>(
          'SELECT r.*, u.username FROM recordings r JOIN users u ON u.id = r.user_id ORDER BY r.started_at DESC LIMIT ?',
          limit,
        );
    return rows.map((r) => ({
      id: r.id,
      userId: r.user_id,
      username: r.username,
      hostId: r.host_id,
      hostName: r.host_name,
      sessionId: r.session_id,
      cols: r.cols,
      rows: r.rows,
      size: r.size,
      startedAt: r.started_at,
      endedAt: r.ended_at,
    }));
  }

  get(id: string) {
    return this.db.get<RecordingRow>('SELECT * FROM recordings WHERE id = ?', id);
  }

  delete(id: string) {
    this.db.run('DELETE FROM recordings WHERE id = ?', id);
    fs.rmSync(this.file(id), { force: true });
  }

  prune(retentionDays: number): number {
    if (retentionDays <= 0) return 0;
    const cutoff = Date.now() - retentionDays * 86400_000;
    const old = this.db.all<{ id: string }>('SELECT id FROM recordings WHERE started_at < ? AND ended_at IS NOT NULL', cutoff);
    for (const r of old) this.delete(r.id);
    return old.length;
  }
}
