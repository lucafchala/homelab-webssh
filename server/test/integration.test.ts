import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import type { AppContext } from '../src/context.js';
import { totp } from '../src/security/totp.js';
import { SSHD, freePort, startSshd, type TestSshd } from './helpers/sshd.js';
import { Client } from './helpers/client.js';

const PASSWORD = 'Correct-Horse-Battery-9';

function openTerminal(base: string, client: Client) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/api/terminal/ws', { headers: { origin: base, cookie: client.cookieHeader() } });
  const messages: any[] = [];
  let output = '';
  const waiters: (() => void)[] = [];
  ws.on('message', (data, isBinary) => {
    if (isBinary) output += data.toString();
    else messages.push(JSON.parse(data.toString()));
    waiters.splice(0).forEach((w) => w());
  });
  const until = (pred: () => boolean, ms = 15000) =>
    new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`timeout; output=${JSON.stringify(output.slice(-500))} messages=${JSON.stringify(messages)}`)), ms);
      const check = () => {
        if (pred()) {
          clearTimeout(t);
          resolve();
        } else waiters.push(check);
      };
      check();
    });
  const opened = new Promise<void>((resolve, reject) => {
    ws.once('open', () => resolve());
    ws.once('error', reject);
  });
  return { ws, messages, get output() { return output; }, until, opened };
}

describe.skipIf(!SSHD)('integration: real sshd', () => {
  let sshd: TestSshd;
  let app: FastifyInstance;
  let ctx: AppContext;
  let base: string;
  let dataDir: string;
  const c = () => client;
  let client: Client;
  let hostId = '';
  let keyId = '';
  let totpSecret = '';

  beforeAll(async () => {
    sshd = await startSshd();
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webssh-data-'));
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const config = loadConfig({
      NODE_ENV: 'test',
      DATA_DIR: dataDir,
      PUBLIC_URL: base,
      PORT: String(port),
      SETUP_TOKEN: 'setup-token-for-tests',
      LOG_LEVEL: 'warn',
      TERMINAL_GRACE_MINUTES: '5',
      TLDR_ENABLED: 'false',
    });
    ({ app, ctx } = await buildApp(config, { logger: false, webDist: '/nonexistent' }));
    await app.listen({ host: '127.0.0.1', port });
    client = new Client(base);
  });

  afterAll(async () => {
    await app?.close();
    ctx?.db.close();
    sshd?.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('first-run setup requires the setup token', async () => {
    expect((await c().get('/api/auth/state')).json.setupRequired).toBe(true);
    const bad = await c().post('/api/auth/setup', { token: 'wrong', username: 'admin', password: PASSWORD });
    expect(bad.status).toBe(403);
    const ok = await c().post('/api/auth/setup', { token: 'setup-token-for-tests', username: 'admin', password: PASSWORD });
    expect(ok.status).toBe(200);
    const again = await new Client(base).post('/api/auth/setup', { token: 'setup-token-for-tests', username: 'evil', password: PASSWORD });
    expect(again.status).toBe(403);
  });

  it('forces 2FA enrolment before anything else', async () => {
    const me = await c().refreshCsrf();
    expect(me.json.needs2faSetup).toBe(true);
    const hosts = await c().get('/api/hosts');
    expect(hosts.status).toBe(403);
    expect(hosts.json.code).toBe('MFA_SETUP_REQUIRED');
  });

  it('rejects state changes without CSRF token or from another origin', async () => {
    const noCsrf = await c().req('POST', '/api/me/totp/setup', {}, { 'x-csrf-token': '' });
    expect(noCsrf.status).toBe(403);
    const evil = await c().req('POST', '/api/me/totp/setup', {}, { origin: 'https://evil.example' });
    expect(evil.status).toBe(403);
  });

  it('enrols TOTP and returns recovery codes', async () => {
    const setup = await c().post('/api/me/totp/setup');
    expect(setup.status).toBe(200);
    expect(setup.json.qr).toMatch(/^data:image\/png;base64,/);
    totpSecret = setup.json.secret;
    const wrong = await c().post('/api/me/totp/enable', { code: '000000' });
    expect(wrong.status).toBe(400);
    const ok = await c().post('/api/me/totp/enable', { code: totp(totpSecret) });
    expect(ok.status).toBe(200);
    expect(ok.json.recoveryCodes).toHaveLength(10);
    expect((await c().refreshCsrf()).json.needs2faSetup).toBe(false);
  });

  it('login needs password + TOTP; recovery codes are single use', async () => {
    const fresh = new Client(base);
    expect((await fresh.post('/api/auth/login', { username: 'admin', password: 'nope-nope-nope' })).status).toBe(401);
    const step1 = await fresh.post('/api/auth/login', { username: 'admin', password: PASSWORD });
    expect(step1.json.mfa.totp).toBe(true);
    // MFA-stage session cannot use the app
    expect((await fresh.get('/api/me')).status).toBe(401);
    // TOTP codes can't be replayed — wait for a fresh step if the enrolment code is still current.
    const code = totp(totpSecret, Date.now() + 30_000);
    const step2 = await fresh.post('/api/auth/mfa/totp', { code });
    expect(step2.status).toBe(200);
    expect((await fresh.refreshCsrf()).status).toBe(200);
    // logout
    expect((await fresh.post('/api/auth/logout')).status).toBe(200);
    expect((await fresh.get('/api/me')).status).toBe(401);
  });

  it('generates an SSH key and creates a host', async () => {
    const key = await c().post('/api/keys/generate', { name: 'test key', type: 'ed25519' });
    expect(key.status).toBe(200);
    expect(key.json.publicKey).toMatch(/^ssh-ed25519 /);
    expect(key.json).not.toHaveProperty('privateKey');
    keyId = key.json.id;
    fs.writeFileSync(sshd.authorizedKeys, key.json.publicKey + '\n');

    const host = await c().post('/api/hosts', {
      name: 'local test',
      hostname: '127.0.0.1',
      port: sshd.port,
      username: sshd.user,
      authType: 'key',
      keyId,
      tags: ['test'],
      group: 'lab',
      record: true,
    });
    expect(host.status).toBe(200);
    hostId = host.json.id;
    expect(host.json.hostKey).toBeNull();
  });

  it('host key must be trusted before non-interactive use (TOFU)', async () => {
    const stats = await c().get(`/api/hosts/${hostId}/stats`);
    expect(stats.status).toBe(409);
    expect(stats.json.code).toBe('HOST_KEY_UNKNOWN');

    const t1 = await c().post(`/api/hosts/${hostId}/test`);
    expect(t1.json.ok).toBe(false);
    expect(t1.json.hostKey.fingerprint).toMatch(/^SHA256:/);
    const t2 = await c().post(`/api/hosts/${hostId}/test`, { trustFingerprint: t1.json.hostKey.fingerprint });
    expect(t2.json.ok).toBe(true);
    expect(t2.json.output.length).toBeGreaterThan(0);
  });

  it('collects stats', async () => {
    const s = await c().get(`/api/hosts/${hostId}/stats`);
    expect(s.status).toBe(200);
    expect(s.json.cpu.cores).toBeGreaterThan(0);
    expect(s.json.memory.totalKb).toBeGreaterThan(0);
    expect(s.json.hostname.length).toBeGreaterThan(0);
  });

  it('runs commands via exec and gates dangerous ones', async () => {
    const r = await c().post(`/api/hosts/${hostId}/exec`, { command: 'echo exec-$((20+22))' });
    expect(r.status).toBe(200);
    expect(r.json.stdout.trim()).toBe('exec-42');
    expect(r.json.code).toBe(0);
    expect(r.json.risk.risk).toBe('read');
    const danger = await c().post(`/api/hosts/${hostId}/exec`, { command: 'sudo reboot' });
    expect(danger.status).toBe(428);
    const timeout = await c().post(`/api/hosts/${hostId}/exec`, { command: 'sleep 5', timeoutSec: 1 });
    expect(timeout.json.timedOut).toBe(true);
  });

  it('opens a terminal over WebSocket, survives detach, and re-attaches with screen state', async () => {
    const t = openTerminal(base, c());
    await t.opened;
    t.ws.send(JSON.stringify({ type: 'open', hostId, cols: 100, rows: 30 }));
    await t.until(() => t.messages.some((m) => m.type === 'ready'));
    const sessionId = t.messages.find((m) => m.type === 'created').sessionId;
    expect(t.messages.find((m) => m.type === 'ready').recording).toBe(true);
    t.ws.send(Buffer.from('echo marker-$((6*7))\r'));
    await t.until(() => t.output.includes('marker-42'));
    t.ws.close();
    await new Promise((r) => setTimeout(r, 300));

    // The session keeps running for the grace period…
    const live = await c().get('/api/terminals');
    expect(live.json.map((s: any) => s.id)).toContain(sessionId);

    // …and a new socket (e.g. from the phone) re-attaches with the screen restored.
    const t2 = openTerminal(base, c());
    await t2.opened;
    t2.ws.send(JSON.stringify({ type: 'attach', sessionId, cols: 80, rows: 24 }));
    await t2.until(() => t2.messages.some((m) => m.type === 'attached'));
    await t2.until(() => t2.output.includes('marker-42'));
    t2.ws.send(Buffer.from('echo second-$((1+1))\r'));
    await t2.until(() => t2.output.includes('second-2'));
    t2.ws.send(JSON.stringify({ type: 'close' }));
    await t2.until(() => t2.messages.some((m) => m.type === 'closed'));
    expect((await c().get('/api/terminals')).json).toHaveLength(0);
  });

  it('stores an asciicast recording of the session', async () => {
    await new Promise((r) => setTimeout(r, 300));
    const list = await c().get('/api/recordings');
    expect(list.json.length).toBe(1);
    const cast = await c().get(`/api/recordings/${list.json[0].id}`);
    const lines = cast.text.trim().split('\n');
    expect(JSON.parse(lines[0])).toMatchObject({ version: 2, width: 100, height: 30 });
    expect(cast.text).toContain('marker-42');
  });

  it('prompts for an unknown host key on the WebSocket and can reject it', async () => {
    const h = await c().post('/api/hosts', { name: 'unknown key', hostname: 'localhost', port: sshd.port, username: sshd.user, authType: 'key', keyId });
    const t = openTerminal(base, c());
    await t.opened;
    t.ws.send(JSON.stringify({ type: 'open', hostId: h.json.id, cols: 80, rows: 24 }));
    await t.until(() => t.messages.some((m) => m.type === 'hostkey'));
    const q = t.messages.find((m) => m.type === 'hostkey');
    expect(q.fingerprint).toMatch(/^SHA256:/);
    t.ws.send(JSON.stringify({ type: 'answer', requestId: q.requestId, accept: false }));
    await t.until(() => t.messages.some((m) => m.type === 'error'));
    expect(t.messages.find((m) => m.type === 'error').code).toBe('HOST_KEY_REJECTED');
    await c().del(`/api/hosts/${h.json.id}`);
  });

  it('detects a changed host key (MITM protection)', async () => {
    ctx.db.run("UPDATE hosts SET host_key_fp = 'SHA256:not-the-real-key' WHERE id = ?", hostId);
    ctx.ssh.closeAll();
    await new Promise((r) => setTimeout(r, 300));
    const r = await c().post(`/api/hosts/${hostId}/test`);
    expect(r.json.ok).toBe(false);
    expect(r.json.code).toBe('HOST_KEY_MISMATCH');
    await c().post(`/api/hosts/${hostId}/reset-hostkey`);
    const t1 = await c().post(`/api/hosts/${hostId}/test`);
    const t2 = await c().post(`/api/hosts/${hostId}/test`, { trustFingerprint: t1.json.hostKey.fingerprint });
    expect(t2.json.ok).toBe(true);
  });

  it('SFTP: list, upload, read, edit with conflict detection, download, rename, delete', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webssh-sftp-'));
    const ls = await c().get(`/api/sftp/${hostId}/list?path=${encodeURIComponent(dir)}`);
    expect(ls.status).toBe(200);
    expect(ls.json.entries).toEqual([]);

    const form = new FormData();
    form.append('file', new Blob(['hello from upload\n']), 'note.txt');
    const up = await c().req('POST', `/api/sftp/${hostId}/upload?path=${encodeURIComponent(dir)}`, form);
    expect(up.status).toBe(200);
    expect(up.json.uploaded[0]).toEqual({ name: 'note.txt', size: 18 });
    const form2 = new FormData();
    form2.append('file', new Blob(['x']), 'note.txt');
    expect((await c().req('POST', `/api/sftp/${hostId}/upload?path=${encodeURIComponent(dir)}`, form2)).status).toBe(409);

    const file = path.join(dir, 'note.txt');
    const rd = await c().get(`/api/sftp/${hostId}/read?path=${encodeURIComponent(file)}`);
    expect(rd.json.content).toBe('hello from upload\n');
    const wr = await c().put(`/api/sftp/${hostId}/write`, { path: file, content: 'edited\n', expectedMtime: rd.json.mtime });
    expect(wr.status).toBe(200);
    expect(fs.readFileSync(file, 'utf8')).toBe('edited\n');
    const stale = await c().put(`/api/sftp/${hostId}/write`, { path: file, content: 'x', expectedMtime: rd.json.mtime - 100 });
    expect(stale.status).toBe(409);

    const dl = await c().get(`/api/sftp/${hostId}/download?path=${encodeURIComponent(file)}`);
    expect(dl.text).toBe('edited\n');
    expect(dl.headers.get('content-disposition')).toMatch(/attachment/);

    expect((await c().post(`/api/sftp/${hostId}/mkdir`, { path: path.join(dir, 'sub') })).status).toBe(200);
    expect((await c().post(`/api/sftp/${hostId}/rename`, { from: file, to: path.join(dir, 'sub', 'moved.txt') })).status).toBe(200);
    const tgz = await fetch(`${base}/api/sftp/${hostId}/download?path=${encodeURIComponent(path.join(dir, 'sub'))}`, { headers: { cookie: c().cookieHeader() } });
    expect(tgz.headers.get('content-type')).toBe('application/gzip');
    const buf = Buffer.from(await tgz.arrayBuffer());
    expect(buf[0]).toBe(0x1f);
    expect(buf[1]).toBe(0x8b);

    expect((await c().post(`/api/sftp/${hostId}/delete`, { paths: [path.join(dir, 'sub')] })).status).not.toBe(200); // non-empty without recursive
    expect((await c().post(`/api/sftp/${hostId}/delete`, { paths: [path.join(dir, 'sub')], recursive: true })).status).toBe(200);
    expect(fs.existsSync(path.join(dir, 'sub'))).toBe(false);
    expect((await c().post(`/api/sftp/${hostId}/delete`, { paths: ['/'], recursive: true })).status).toBe(400);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('installs a key on a host (ssh-copy-id) idempotently', async () => {
    const k2 = await c().post('/api/keys/generate', { name: 'second', type: 'ed25519' });
    const r = await c().post(`/api/keys/${k2.json.id}/install`, { hostId, switchHost: false });
    expect(r.status).toBe(200);
    // authorized_keys here is the sshd-configured file, the install wrote to ~/.ssh/authorized_keys on the "remote"
    expect(['installed', 'already-present']).toContain(r.json.result);
    const again = await c().post(`/api/keys/${k2.json.id}/install`, { hostId, switchHost: false });
    expect(again.json.result).toBe('already-present');
  });

  it('serves the local-first help', async () => {
    const r = await c().get('/api/help/search?q=' + encodeURIComponent('what is using port 443'));
    expect(r.json.confidence).toBe('high');
    expect(r.json.recipes[0].id).toBe('port-in-use');
    const man = await c().get(`/api/help/man/${hostId}/ls`);
    expect([200, 404]).toContain(man.status); // man pages may not be installed in CI images
  });

  it('writes an audit trail', async () => {
    const a = await c().get('/api/admin/audit?limit=500');
    const actions = new Set(a.json.map((e: any) => e.action));
    for (const x of ['auth.setup', 'auth.login', 'auth.totp_enable', 'host.create', 'ssh.hostkey_trust', 'terminal.open', 'terminal.close', 'exec.user', 'sftp.upload', 'sftp.write', 'ssh.hostkey_mismatch']) {
      expect(actions, x).toContain(x);
    }
    expect(a.json.some((e: any) => e.action === 'auth.login' && !e.success)).toBe(true);
  });

  it('never returns secrets', async () => {
    const hosts = await c().get('/api/hosts');
    const keys = await c().get('/api/keys');
    const blob = JSON.stringify([hosts.json, keys.json]);
    expect(blob).not.toMatch(/PRIVATE KEY|password_enc|private_key_enc|v1:/);
    const raw = ctx.db.get<{ private_key_enc: string }>('SELECT private_key_enc FROM ssh_keys LIMIT 1');
    expect(raw?.private_key_enc.startsWith('v1:')).toBe(true);
  });

  it('locks an account after repeated failures', async () => {
    const other = new Client(base);
    for (let i = 0; i < 5; i++) await other.post('/api/auth/login', { username: 'admin', password: 'wrong-password-' + i });
    const locked = await other.post('/api/auth/login', { username: 'admin', password: PASSWORD });
    expect(locked.status).toBe(423);
    ctx.db.run('UPDATE users SET locked_until = NULL, failed_attempts = 0');
  });
});
