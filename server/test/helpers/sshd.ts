import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export const SSHD = ['/usr/sbin/sshd', '/usr/bin/sshd'].find((p) => fs.existsSync(p)) ?? null;
const SFTP_SERVER = ['/usr/lib/openssh/sftp-server', '/usr/libexec/openssh/sftp-server', '/usr/lib/ssh/sftp-server'].find((p) => fs.existsSync(p));

export async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

export interface TestSshd {
  port: number;
  dir: string;
  authorizedKeys: string;
  user: string;
  stop(): void;
}

/** Start a throwaway OpenSSH server for the current user (key auth via a temp authorized_keys). */
export async function startSshd(): Promise<TestSshd> {
  if (!SSHD) throw new Error('sshd not installed');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'webssh-sshd-'));
  const hostKey = path.join(dir, 'host_ed25519');
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', hostKey]);
  const authorizedKeys = path.join(dir, 'authorized_keys');
  fs.writeFileSync(authorizedKeys, '', { mode: 0o600 });
  const port = await freePort();
  const user = os.userInfo().username;
  fs.mkdirSync('/run/sshd', { recursive: true, mode: 0o755 });
  const config = [
    `Port ${port}`,
    'ListenAddress 127.0.0.1',
    `HostKey ${hostKey}`,
    `PidFile ${path.join(dir, 'sshd.pid')}`,
    `AuthorizedKeysFile ${authorizedKeys}`,
    'StrictModes no',
    'PermitRootLogin yes',
    'PubkeyAuthentication yes',
    'PasswordAuthentication yes',
    'KbdInteractiveAuthentication no',
    'UsePAM no',
    'PrintMotd no',
    `Subsystem sftp ${SFTP_SERVER ?? 'internal-sftp'}`,
    'LogLevel ERROR',
  ].join('\n');
  const cfgPath = path.join(dir, 'sshd_config');
  fs.writeFileSync(cfgPath, config + '\n');
  const proc: ChildProcess = spawn(SSHD, ['-D', '-e', '-f', cfgPath], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  proc.stderr?.on('data', (d) => (stderr += d.toString()));
  // Wait for the port to accept connections.
  for (let i = 0; i < 50; i++) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = net.connect(port, '127.0.0.1', () => {
        s.end();
        resolve(true);
      });
      s.on('error', () => resolve(false));
    });
    if (ok) break;
    if (proc.exitCode !== null) throw new Error(`sshd exited: ${stderr}`);
    await new Promise((r) => setTimeout(r, 100));
  }
  return {
    port,
    dir,
    authorizedKeys,
    user,
    stop: () => {
      proc.kill('SIGTERM');
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
