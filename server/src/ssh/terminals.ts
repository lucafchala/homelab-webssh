import headless from '@xterm/headless';
import serializeAddon from '@xterm/addon-serialize';
import type { ClientChannel } from 'ssh2';
import type { FastifyBaseLogger } from 'fastify';
import { newId } from '../security/crypto.js';
import { Hosts, type HostRow } from '../db/models.js';
import type { Db } from '../db/index.js';
import type { Audit } from '../audit.js';
import type { Recorder, RecordingHandle } from '../recorder.js';
import type { AppSettingsStore } from '../appSettings.js';
import { SshError, type Interaction, type Lease, type SshManager } from './manager.js';

const { Terminal } = headless;
const { SerializeAddon } = serializeAddon;

/** A browser tab attached to a terminal session. */
export interface TerminalClient {
  readonly id: string;
  sendJson(msg: Record<string, unknown>): void;
  sendData(data: Buffer): void;
  bufferedAmount(): number;
  close(code?: number, reason?: string): void;
}

export type TerminalStatus = 'connecting' | 'ready' | 'closed';

const HIGH_WATER = 4 * 1024 * 1024;
const LOW_WATER = 512 * 1024;

export class TerminalSession {
  readonly id = newId();
  readonly createdAt = Date.now();
  lastActivityAt = Date.now();
  status: TerminalStatus = 'connecting';
  title = '';
  exitCode: number | null = null;
  closeReason = '';
  recordingId: string | null = null;

  private readonly clients = new Map<TerminalClient, { pending: Buffer[] | null }>();
  private readonly term: InstanceType<typeof Terminal>;
  private readonly serializer: InstanceType<typeof SerializeAddon>;
  private stream: ClientChannel | null = null;
  private lease: Lease | null = null;
  private recording: RecordingHandle | null = null;
  private graceTimer: NodeJS.Timeout | null = null;
  private pauseTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly mgr: TerminalManager,
    readonly userId: string,
    readonly username: string,
    readonly host: HostRow,
    public cols: number,
    public rows: number,
  ) {
    this.term = new Terminal({ cols, rows, scrollback: mgr.opts.scrollbackLines, allowProposedApi: true });
    this.serializer = new SerializeAddon();
    this.term.loadAddon(this.serializer);
    this.term.onTitleChange((t) => {
      this.title = t.slice(0, 200);
      this.broadcastJson({ type: 'title', title: this.title });
    });
  }

  /** Status may change while we await (close() from another path); read it fresh. */
  private isClosed(): boolean {
    return this.status === 'closed';
  }

  get clientCount() {
    return this.clients.size;
  }

  info() {
    return {
      id: this.id,
      userId: this.userId,
      username: this.username,
      hostId: this.host.id,
      hostName: this.host.name,
      title: this.title,
      status: this.status,
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
      clients: this.clients.size,
      cols: this.cols,
      rows: this.rows,
      recording: !!this.recording,
    };
  }

  /** Connect and open the remote shell; `interaction` handles host-key and auth prompts. */
  async start(interaction: Interaction): Promise<void> {
    const { ssh, audit, log } = this.mgr.deps;
    try {
      this.lease = await ssh.lease(this.userId, this.host.id, {
        ...interaction,
        status: (m) => this.broadcastJson({ type: 'status', state: 'connecting', message: m }),
      });
      if (this.isClosed()) {
        this.lease.release();
        return;
      }
      const conn = this.lease.conn;
      this.stream = await new Promise<ClientChannel>((resolve, reject) => {
        conn.client.shell({ term: 'xterm-256color', cols: this.cols, rows: this.rows }, (err, stream) => (err ? reject(err) : resolve(stream)));
      });
      if (this.isClosed()) {
        this.stream.close();
        this.lease.release();
        return;
      }
      conn.once('closed', () => this.close('Connection lost'));
      this.stream.on('data', (d: Buffer) => this.onOutput(d));
      this.stream.stderr.on('data', (d: Buffer) => this.onOutput(d));
      this.stream.on('exit', (code: number | null) => {
        this.exitCode = code;
      });
      this.stream.on('close', () => this.close(this.exitCode !== null ? `Shell exited (code ${this.exitCode})` : 'Shell closed'));

      const rec = this.mgr.deps.settings.get().recording;
      if (rec === 'all' || (rec === 'per-host' && this.host.record)) {
        this.recording = this.mgr.deps.recorder.start({
          userId: this.userId,
          hostId: this.host.id,
          hostName: this.host.name,
          sessionId: this.id,
          cols: this.cols,
          rows: this.rows,
          title: `${this.username} → ${this.host.username}@${this.host.name}`,
        });
        this.recordingId = this.recording.id;
      }

      this.status = 'ready';
      this.broadcastJson({ type: 'ready', sessionId: this.id, recording: !!this.recording });
      audit.write({ userId: this.userId, username: this.username, action: 'terminal.open', target: this.host.name, details: { sessionId: this.id, recording: !!this.recording } });
      if (this.host.startup_command) this.stream.write(this.host.startup_command.replace(/\r?\n/g, '\r') + '\r');
    } catch (err) {
      const e = err as SshError;
      log.info({ err: e.message, host: this.host.name }, 'terminal start failed');
      this.broadcastJson({ type: 'error', code: e.code ?? 'CONNECT_FAILED', message: e.message, details: e.details ?? null });
      if (e.code !== 'AUTH_CANCELLED' && e.code !== 'HOST_KEY_REJECTED') {
        audit.write({ userId: this.userId, username: this.username, action: 'terminal.open', target: this.host.name, success: false, details: { error: e.message } });
      }
      this.close(e.message, true);
    }
  }

  private onOutput(d: Buffer) {
    this.lastActivityAt = Date.now();
    this.term.write(d);
    this.recording?.output(d);
    for (const [client, state] of this.clients) {
      if (state.pending) state.pending.push(d);
      else client.sendData(d);
    }
    this.checkBackpressure();
  }

  private checkBackpressure() {
    if (!this.stream || this.pauseTimer) return;
    let max = 0;
    for (const c of this.clients.keys()) max = Math.max(max, c.bufferedAmount());
    if (max > HIGH_WATER) {
      this.stream.pause();
      const poll = () => {
        let m = 0;
        for (const c of this.clients.keys()) m = Math.max(m, c.bufferedAmount());
        if (m < LOW_WATER || this.status === 'closed') {
          this.pauseTimer = null;
          this.stream?.resume();
        } else {
          this.pauseTimer = setTimeout(poll, 50);
        }
      };
      this.pauseTimer = setTimeout(poll, 50);
    }
  }

  /** Attach a client: replay the current screen (serialized), then stream live output. */
  attach(client: TerminalClient, cols?: number, rows?: number) {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
    const state = { pending: [] as Buffer[] | null };
    this.clients.set(client, state);
    if (cols && rows) this.resize(cols, rows);
    // Wait until everything already received has been parsed, then snapshot.
    this.term.write('', () => {
      if (!this.clients.has(client)) return;
      const snapshot = this.serializer.serialize({ scrollback: this.mgr.opts.scrollbackLines });
      client.sendJson({ type: 'attached', sessionId: this.id, status: this.status, title: this.title, recording: !!this.recording, hostId: this.host.id, hostName: this.host.name });
      if (snapshot) client.sendData(Buffer.from(snapshot, 'utf8'));
      for (const chunk of state.pending ?? []) client.sendData(chunk);
      state.pending = null;
    });
  }

  /** Register the creating client without replay (it receives everything from the start). */
  attachCreator(client: TerminalClient) {
    this.clients.set(client, { pending: null });
  }

  detach(client: TerminalClient) {
    this.clients.delete(client);
    if (this.clients.size === 0 && this.status !== 'closed') {
      const grace = this.status === 'ready' ? this.mgr.opts.graceMs : 0;
      if (grace <= 0) return this.close('Detached');
      this.graceTimer = setTimeout(() => this.close('Detached (grace period expired)'), grace);
      this.graceTimer.unref();
    }
  }

  input(data: Buffer | string) {
    if (this.status !== 'ready' || !this.stream) return;
    this.lastActivityAt = Date.now();
    this.stream.write(data);
  }

  resize(cols: number, rows: number) {
    const c = Math.max(10, Math.min(500, Math.floor(cols)));
    const r = Math.max(2, Math.min(200, Math.floor(rows)));
    if (!Number.isFinite(c) || !Number.isFinite(r) || (c === this.cols && r === this.rows)) return;
    this.cols = c;
    this.rows = r;
    this.term.resize(c, r);
    this.stream?.setWindow(r, c, 0, 0);
    this.recording?.resize(c, r);
  }

  close(reason: string, isError = false) {
    if (this.status === 'closed') return;
    this.status = 'closed';
    this.closeReason = reason;
    if (this.graceTimer) clearTimeout(this.graceTimer);
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    try {
      this.stream?.close();
    } catch {
      /* ignore */
    }
    this.lease?.release();
    this.lease = null;
    this.recording?.end();
    if (!isError) this.broadcastJson({ type: 'closed', reason, exitCode: this.exitCode });
    for (const c of this.clients.keys()) c.close(1000, 'session closed');
    this.clients.clear();
    this.term.dispose();
    this.mgr.remove(this);
    if (this.stream) {
      this.mgr.deps.audit.write({
        userId: this.userId,
        username: this.username,
        action: 'terminal.close',
        target: this.host.name,
        details: { sessionId: this.id, reason, durationSec: Math.round((Date.now() - this.createdAt) / 1000) },
      });
    }
  }

  private broadcastJson(msg: Record<string, unknown>) {
    for (const c of this.clients.keys()) c.sendJson(msg);
  }
}

export class TerminalManager {
  private readonly sessions = new Map<string, TerminalSession>();

  constructor(
    readonly deps: { db: Db; ssh: SshManager; audit: Audit; recorder: Recorder; settings: AppSettingsStore; log: FastifyBaseLogger },
    readonly opts: { graceMs: number; maxPerUser: number; scrollbackLines: number },
  ) {}

  create(user: { id: string; username: string }, hostId: string, cols: number, rows: number): TerminalSession {
    const host = Hosts.accessible(this.deps.db, user.id, hostId);
    if (!host) throw new SshError('NOT_FOUND', 'Host not found');
    const mine = [...this.sessions.values()].filter((s) => s.userId === user.id).length;
    if (mine >= this.opts.maxPerUser) throw new SshError('CONNECT_FAILED', `Session limit reached (${this.opts.maxPerUser}). Close some terminals first.`);
    const s = new TerminalSession(this, user.id, user.username, host, Math.max(10, Math.min(500, cols)), Math.max(2, Math.min(200, rows)));
    this.sessions.set(s.id, s);
    return s;
  }

  get(id: string): TerminalSession | undefined {
    return this.sessions.get(id);
  }

  remove(s: TerminalSession) {
    this.sessions.delete(s.id);
  }

  listForUser(userId: string) {
    return [...this.sessions.values()].filter((s) => s.userId === userId).map((s) => s.info());
  }

  listAll() {
    return [...this.sessions.values()].map((s) => s.info());
  }

  close(id: string, reason: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.close(reason);
    return true;
  }

  closeAllForUser(userId: string, reason: string) {
    for (const s of [...this.sessions.values()]) if (s.userId === userId) s.close(reason);
  }

  shutdown() {
    for (const s of [...this.sessions.values()]) s.close('Server shutting down');
  }
}
