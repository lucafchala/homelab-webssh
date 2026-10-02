import dns from 'node:dns/promises';
import net from 'node:net';
import { EventEmitter } from 'node:events';
import ssh2, { type AnyAuthMethod, type AuthenticationType, type ClientChannel, type ConnectConfig, type SFTPWrapper } from 'ssh2';
import type { FastifyBaseLogger } from 'fastify';
import type { Db } from '../db/index.js';
import { Hosts, Keys, type HostRow } from '../db/models.js';
import type { Vault } from '../security/crypto.js';
import type { Audit } from '../audit.js';
import type { CidrList } from '../security/cidr.js';
import { fingerprintBlob, keyTypeFromBlob } from './keys.js';

const { Client } = ssh2;

export type SshErrorCode =
  | 'NOT_FOUND'
  | 'HOST_KEY_UNKNOWN'
  | 'HOST_KEY_MISMATCH'
  | 'HOST_KEY_REJECTED'
  | 'AUTH_FAILED'
  | 'AUTH_CANCELLED'
  | 'TARGET_DENIED'
  | 'CONNECT_FAILED'
  | 'TIMEOUT'
  | 'JUMP_LOOP';

export class SshError extends Error {
  constructor(
    readonly code: SshErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

export interface HostKeyInfo {
  hostId: string;
  hostName: string;
  fingerprint: string;
  keyType: string;
  status: 'new' | 'mismatch';
  expected?: string;
}

export interface AuthPrompt {
  hostName: string;
  title: string;
  instructions: string;
  prompts: { prompt: string; echo: boolean }[];
}

/** How a connection attempt talks to the human (WebSocket) — or not (HTTP). */
export interface Interaction {
  confirmHostKey(info: HostKeyInfo): Promise<boolean>;
  prompt(p: AuthPrompt): Promise<string[] | null>;
  status?(message: string): void;
}

export const NON_INTERACTIVE: Interaction = {
  confirmHostKey: async () => false,
  prompt: async () => null,
};

export interface Lease {
  conn: SshConnection;
  release(): void;
}

const IDLE_CLOSE_MS = 5 * 60_000;
const HANDSHAKE_TIMEOUT_MS = 20_000;
const AUTH_TIMEOUT_MS = 3 * 60_000;
const MAX_JUMP_DEPTH = 4;

export class SshConnection extends EventEmitter {
  leases = 0;
  closed = false;
  readonly createdAt = Date.now();
  private idleTimer: NodeJS.Timeout | null = null;
  private sftpPromise: Promise<SFTPWrapper> | null = null;

  constructor(
    readonly key: string,
    readonly userId: string,
    readonly host: HostRow,
    readonly client: InstanceType<typeof Client>,
    private readonly parent: Lease | null,
  ) {
    super();
    this.setMaxListeners(100);
    client.on('close', () => this.onClosed());
    client.on('error', () => {
      /* surfaced via close */
    });
  }

  acquire(): Lease {
    if (this.closed) throw new SshError('CONNECT_FAILED', 'Connection is closed');
    this.leases++;
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    let released = false;
    return {
      conn: this,
      release: () => {
        if (released) return;
        released = true;
        this.leases--;
        if (this.leases <= 0 && !this.closed) {
          this.idleTimer = setTimeout(() => this.end(), IDLE_CLOSE_MS);
          this.idleTimer.unref();
        }
      },
    };
  }

  sftp(): Promise<SFTPWrapper> {
    if (!this.sftpPromise) {
      this.sftpPromise = new Promise<SFTPWrapper>((resolve, reject) => {
        this.client.sftp((err, sftp) => {
          if (err) {
            this.sftpPromise = null;
            reject(new SshError('CONNECT_FAILED', `SFTP subsystem unavailable: ${err.message}`));
            return;
          }
          sftp.on('close', () => {
            this.sftpPromise = null;
          });
          resolve(sftp);
        });
      });
    }
    return this.sftpPromise;
  }

  end(): void {
    if (this.closed) return;
    this.client.end();
    // Hard stop if the server does not close in time.
    setTimeout(() => this.client.destroy(), 2000).unref();
  }

  private onClosed() {
    if (this.closed) return;
    this.closed = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.parent?.release();
    this.emit('closed');
  }
}

export interface ExecResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
}

export class SshManager {
  private readonly conns = new Map<string, SshConnection>();
  private readonly pending = new Map<string, Promise<SshConnection>>();

  constructor(
    private readonly deps: { db: Db; vault: Vault; log: FastifyBaseLogger; audit: Audit; targetAllowlist: CidrList },
  ) {}

  /** Get (or open) the pooled connection for user+host and take a lease on it. */
  async lease(userId: string, hostId: string, interaction: Interaction = NON_INTERACTIVE, depth = 0, chain: string[] = []): Promise<Lease> {
    if (chain.includes(hostId)) throw new SshError('JUMP_LOOP', 'Jump host chain contains a loop');
    if (depth > MAX_JUMP_DEPTH) throw new SshError('JUMP_LOOP', 'Jump host chain is too deep');
    const host = Hosts.accessible(this.deps.db, userId, hostId);
    if (!host) throw new SshError('NOT_FOUND', 'Host not found');
    const key = `${userId}:${hostId}`;
    const existing = this.conns.get(key);
    if (existing && !existing.closed) return existing.acquire();
    let p = this.pending.get(key);
    if (!p) {
      p = this.connect(key, userId, host, interaction, depth, [...chain, hostId]).finally(() => this.pending.delete(key));
      this.pending.set(key, p);
    }
    const conn = await p;
    return conn.acquire();
  }

  private async resolveTarget(host: HostRow): Promise<string> {
    const allow = this.deps.targetAllowlist;
    if (allow.empty) return host.hostname;
    let addrs: string[];
    if (net.isIP(host.hostname)) addrs = [host.hostname];
    else {
      try {
        addrs = (await dns.lookup(host.hostname, { all: true })).map((a) => a.address);
      } catch {
        throw new SshError('CONNECT_FAILED', `Could not resolve ${host.hostname}`);
      }
    }
    const ok = addrs.find((a) => allow.allows(a));
    if (!ok) throw new SshError('TARGET_DENIED', `${host.hostname} (${addrs.join(', ')}) is outside SSH_TARGET_ALLOWLIST`);
    // Connect to the vetted address to avoid DNS rebinding between check and connect.
    return ok;
  }

  private forwardOut(parent: SshConnection, host: string, port: number): Promise<ClientChannel> {
    return new Promise((resolve, reject) => {
      parent.client.forwardOut('127.0.0.1', 0, host, port, (err, stream) => {
        if (err) reject(new SshError('CONNECT_FAILED', `Jump host ${parent.host.name} could not reach ${host}:${port}: ${err.message}`));
        else resolve(stream);
      });
    });
  }

  private credentials(host: HostRow) {
    const { vault, db } = this.deps;
    const password = host.auth_type === 'password' ? vault.decryptNullable(host.password_enc, `host:${host.id}`) : null;
    let privateKey: string | null = null;
    let passphrase: string | null = null;
    if (host.auth_type === 'key' && host.key_id) {
      const k = Keys.byId(db, host.key_id);
      // A host may only use keys owned by the same account.
      if (k && k.owner_id === host.owner_id) {
        privateKey = vault.decryptString(k.private_key_enc, `key:${k.id}`);
        passphrase = vault.decryptNullable(k.passphrase_enc, `key:${k.id}`);
      }
    }
    return { password, privateKey, passphrase };
  }

  private async connect(key: string, userId: string, host: HostRow, interaction: Interaction, depth: number, chain: string[]): Promise<SshConnection> {
    const { log, audit, db } = this.deps;
    let parent: Lease | null = null;
    let sock: ClientChannel | undefined;
    let target = host.hostname;
    if (host.jump_host_id) {
      interaction.status?.(`Connecting via jump host…`);
      parent = await this.lease(userId, host.jump_host_id, interaction, depth + 1, chain);
      try {
        sock = await this.forwardOut(parent.conn, host.hostname, host.port);
      } catch (err) {
        parent.release();
        throw err;
      }
    } else {
      target = await this.resolveTarget(host);
    }

    interaction.status?.(`Connecting to ${host.username}@${host.hostname}:${host.port}…`);
    const creds = this.credentials(host);
    const client = new Client();

    return new Promise<SshConnection>((resolve, reject) => {
      let settled = false;
      let hostKeyError: SshError | null = null;
      let authCancelled = false;
      let handshakeTimer: NodeJS.Timeout | null = setTimeout(() => fail(new SshError('TIMEOUT', `Timed out connecting to ${host.hostname}:${host.port}`)), HANDSHAKE_TIMEOUT_MS);
      const authTimer = setTimeout(() => fail(new SshError('TIMEOUT', 'Timed out during authentication')), AUTH_TIMEOUT_MS);

      const clearTimers = () => {
        if (handshakeTimer) clearTimeout(handshakeTimer);
        handshakeTimer = null;
        clearTimeout(authTimer);
      };

      const fail = (err: SshError) => {
        if (settled) return;
        settled = true;
        clearTimers();
        client.removeAllListeners('ready');
        client.on('error', () => {});
        client.end();
        setTimeout(() => client.destroy(), 1000).unref();
        parent?.release();
        reject(err);
      };

      // --- host key pinning (trust on first use, hard fail on mismatch)
      const hostVerifier = (keyBlob: Buffer, verify: (ok: boolean) => void) => {
        const fingerprint = fingerprintBlob(keyBlob);
        const keyType = keyTypeFromBlob(keyBlob);
        const fresh = Hosts.byId(db, host.id);
        const pinned = fresh?.host_key_fp ?? null;
        if (pinned) {
          if (pinned === fingerprint) return verify(true);
          hostKeyError = new SshError(
            'HOST_KEY_MISMATCH',
            `HOST KEY CHANGED for ${host.name}! Expected ${pinned} but the server presented ${fingerprint}. ` +
              `This could be a man-in-the-middle attack — or the host was reinstalled. The host owner can reset the pinned key.`,
            { fingerprint, keyType, expected: pinned },
          );
          audit.write({ userId, action: 'ssh.hostkey_mismatch', target: host.name, success: false, details: { fingerprint, expected: pinned } });
          return verify(false);
        }
        // Pause the handshake watchdog while the human decides.
        if (handshakeTimer) clearTimeout(handshakeTimer);
        handshakeTimer = null;
        interaction
          .confirmHostKey({ hostId: host.id, hostName: host.name, fingerprint, keyType, status: 'new' })
          .then((ok) => {
            if (ok) {
              Hosts.setHostKey(db, host.id, keyType, fingerprint);
              audit.write({ userId, action: 'ssh.hostkey_trust', target: host.name, details: { fingerprint, keyType } });
            } else {
              hostKeyError = new SshError(
                interaction === NON_INTERACTIVE ? 'HOST_KEY_UNKNOWN' : 'HOST_KEY_REJECTED',
                interaction === NON_INTERACTIVE
                  ? `Host key for ${host.name} is not trusted yet. Open a terminal or use "Test connection" to verify it.`
                  : 'Host key was not accepted',
                { fingerprint, keyType },
              );
            }
            verify(ok);
          })
          .catch(() => verify(false));
      };

      // --- authentication sequence
      const username = host.username;
      let passwordAsks = 0;
      let savedPasswordUsedInKbd = false;
      const queue: (AnyAuthMethod | 'ask-password')[] = [];
      if (creds.privateKey) queue.push({ type: 'publickey', username, key: creds.privateKey, passphrase: creds.passphrase ?? undefined });
      if (creds.password) queue.push({ type: 'password', username, password: creds.password });
      queue.push({
        type: 'keyboard-interactive',
        username,
        prompt: (name, instructions, _lang, prompts, finish) => {
          if (!prompts.length) return finish([]);
          if (creds.password && !savedPasswordUsedInKbd && prompts.length === 1 && !prompts[0].echo && /pass/i.test(prompts[0].prompt)) {
            savedPasswordUsedInKbd = true;
            return finish([creds.password]);
          }
          interaction
            .prompt({
              hostName: host.name,
              title: name || `Authentication for ${username}@${host.hostname}`,
              instructions: instructions || '',
              prompts: prompts.map((p) => ({ prompt: p.prompt, echo: !!p.echo })),
            })
            .then((answers) => {
              if (!answers) authCancelled = true;
              finish(answers ?? []);
            })
            .catch(() => finish([]));
        },
      });
      if (!creds.privateKey || host.auth_type !== 'key') queue.push('ask-password', 'ask-password', 'ask-password');

      const authHandler = (methodsLeft: AuthenticationType[] | null, _partial: boolean | null, next: (m: AnyAuthMethod | AuthenticationType | false) => void) => {
        if (authCancelled) return next(false);
        if (methodsLeft === null && !creds.privateKey && !creds.password) {
          // Discover which methods the server offers before prompting the human.
          return next({ type: 'none', username });
        }
        const allowed = (t: AuthenticationType) => !methodsLeft || methodsLeft.includes(t);
        while (queue.length) {
          const m = queue.shift()!;
          if (m === 'ask-password') {
            if (!allowed('password')) continue;
            passwordAsks++;
            interaction
              .prompt({
                hostName: host.name,
                title: passwordAsks > 1 ? 'Permission denied, please try again' : 'Password required',
                instructions: '',
                prompts: [{ prompt: `${username}@${host.hostname}'s password:`, echo: false }],
              })
              .then((answers) => {
                if (!answers || answers[0] === undefined) {
                  authCancelled = true;
                  return next(false);
                }
                next({ type: 'password', username, password: answers[0] });
              })
              .catch(() => next(false));
            return;
          }
          if (allowed(m.type)) return next(m);
        }
        next(false);
      };

      client.on('handshake', () => {
        if (handshakeTimer) clearTimeout(handshakeTimer);
        handshakeTimer = null;
      });

      client.once('ready', () => {
        if (settled) return;
        settled = true;
        clearTimers();
        const conn = new SshConnection(key, userId, host, client, parent);
        this.conns.set(key, conn);
        conn.once('closed', () => {
          if (this.conns.get(key) === conn) this.conns.delete(key);
          log.info({ host: host.name, userId }, 'ssh connection closed');
        });
        Hosts.touch(db, host.id);
        log.info({ host: host.name, userId }, 'ssh connection established');
        resolve(conn);
      });

      client.on('error', (err: Error & { level?: string }) => {
        if (hostKeyError) return fail(hostKeyError);
        if (authCancelled && interaction === NON_INTERACTIVE) {
          return fail(
            new SshError('AUTH_FAILED', `${host.name} needs interactive authentication — open a terminal to it first (the connection is then shared with files, stats and the AI assistant)`),
          );
        }
        if (authCancelled) return fail(new SshError('AUTH_CANCELLED', 'Authentication cancelled'));
        if (err.level === 'client-authentication' || /authentication methods failed/i.test(err.message)) {
          return fail(new SshError('AUTH_FAILED', `Authentication failed for ${username}@${host.hostname}`));
        }
        fail(new SshError('CONNECT_FAILED', `${host.hostname}:${host.port}: ${err.message}`));
      });

      client.on('close', () => fail(hostKeyError ?? new SshError('CONNECT_FAILED', 'Connection closed during setup')));

      const cfg: ConnectConfig = {
        host: target,
        port: host.port,
        username,
        sock,
        hostVerifier: hostVerifier as ConnectConfig['hostVerifier'],
        authHandler: authHandler as unknown as ConnectConfig['authHandler'],
        readyTimeout: AUTH_TIMEOUT_MS + 5000,
        keepaliveInterval: 15_000,
        keepaliveCountMax: 4,
      };
      try {
        client.connect(cfg);
      } catch (err) {
        fail(new SshError('CONNECT_FAILED', (err as Error).message));
      }
    });
  }

  /** Run a non-interactive command. Output is capped; the channel is closed on timeout. */
  exec(conn: SshConnection, command: string, opts: { timeoutMs?: number; maxBytes?: number; stdin?: string | Buffer; pty?: boolean } = {}): Promise<ExecResult> {
    const timeoutMs = opts.timeoutMs ?? 30_000;
    const maxBytes = opts.maxBytes ?? 1024 * 1024;
    const started = Date.now();
    return new Promise((resolve, reject) => {
      conn.client.exec(command, { pty: opts.pty ? { term: 'dumb', cols: 200, rows: 50 } : undefined }, (err, stream) => {
        if (err) return reject(new SshError('CONNECT_FAILED', `exec failed: ${err.message}`));
        const out: Buffer[] = [];
        const errOut: Buffer[] = [];
        let outLen = 0;
        let errLen = 0;
        let truncated = false;
        let timedOut = false;
        let code: number | null = null;
        let signal: string | null = null;
        const timer = setTimeout(() => {
          timedOut = true;
          try {
            stream.signal('KILL');
          } catch {
            /* not all servers support signals */
          }
          stream.close();
        }, timeoutMs);
        stream.on('data', (d: Buffer) => {
          if (outLen < maxBytes) out.push(d.subarray(0, maxBytes - outLen));
          else truncated = true;
          outLen += d.length;
          if (outLen > maxBytes) truncated = true;
        });
        stream.stderr.on('data', (d: Buffer) => {
          if (errLen < maxBytes) errOut.push(d.subarray(0, maxBytes - errLen));
          errLen += d.length;
        });
        stream.on('exit', (c: number | null, s?: string) => {
          code = c;
          signal = s ?? null;
        });
        stream.on('close', () => {
          clearTimeout(timer);
          resolve({
            code,
            signal,
            stdout: Buffer.concat(out).toString('utf8'),
            stderr: Buffer.concat(errOut).toString('utf8'),
            truncated,
            timedOut,
            durationMs: Date.now() - started,
          });
        });
        if (opts.stdin !== undefined) stream.end(opts.stdin);
        else stream.end();
      });
    });
  }

  /** Lease + exec + release in one go (non-interactive). */
  async run(userId: string, hostId: string, command: string, opts?: Parameters<SshManager['exec']>[2]): Promise<ExecResult> {
    const lease = await this.lease(userId, hostId);
    try {
      return await this.exec(lease.conn, command, opts);
    } finally {
      lease.release();
    }
  }

  /** Drop pooled connections for a host (e.g. after its credentials changed). */
  closeHost(hostId: string): void {
    for (const c of this.conns.values()) if (c.host.id === hostId && c.leases === 0) c.end();
  }

  closeUser(userId: string): void {
    for (const c of this.conns.values()) if (c.userId === userId) c.end();
  }

  closeAll(): void {
    for (const c of this.conns.values()) c.end();
  }

  list() {
    return [...this.conns.values()].map((c) => ({ userId: c.userId, hostId: c.host.id, hostName: c.host.name, leases: c.leases, createdAt: c.createdAt }));
  }
}

/** POSIX single-quote escaping for building remote shell commands. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
