/**
 * Admin CLI for break-glass tasks (run inside the container / on the host):
 *   npm run cli -- create-admin <username>      create an admin (prompts for password)
 *   npm run cli -- reset-password <username>    set a new password (forces change at next login)
 *   npm run cli -- reset-2fa <username>         remove TOTP + passkeys (e.g. lost phone)
 *   npm run cli -- unlock <username>            clear lockout
 *   npm run cli -- list-users
 *   npm run cli -- revoke-sessions <username>   sign the user out everywhere
 */
import readline from 'node:readline';
import { Writable } from 'node:stream';
import { loadConfig } from './config.js';
import { Db } from './db/index.js';
import { Users } from './db/models.js';
import { checkPasswordPolicy, hashPassword } from './security/password.js';

function askHidden(question: string): Promise<string> {
  if (process.env.WEBSSH_PASSWORD) return Promise.resolve(process.env.WEBSSH_PASSWORD);
  let muted = false;
  const out = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stdout.write(chunk);
      cb();
    },
  });
  const rl = readline.createInterface({ input: process.stdin, output: out, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
    muted = true;
  });
}

async function newPassword(username: string): Promise<string> {
  const p1 = await askHidden(`New password for ${username}: `);
  const policy = checkPasswordPolicy(p1, username);
  if (policy) throw new Error(policy);
  if (!process.env.WEBSSH_PASSWORD) {
    const p2 = await askHidden('Repeat password: ');
    if (p1 !== p2) throw new Error('Passwords do not match');
  }
  return p1;
}

async function main() {
  const [cmd, username] = process.argv.slice(2);
  const config = loadConfig();
  const db = Db.open(config.dataDir);
  const need = () => {
    if (!username) throw new Error(`Usage: ${cmd} <username>`);
    const u = Users.byUsername(db, username);
    if (!u) throw new Error(`No such user: ${username}`);
    return u;
  };
  switch (cmd) {
    case 'create-admin': {
      if (!username || !/^[a-zA-Z0-9._-]{2,64}$/.test(username)) throw new Error('Usage: create-admin <username>');
      if (Users.byUsername(db, username)) throw new Error('User already exists');
      const pw = await newPassword(username);
      Users.create(db, { username, passwordHash: await hashPassword(pw), role: 'admin' });
      console.log(`Admin ${username} created. Sign in and enrol two-factor authentication.`);
      break;
    }
    case 'reset-password': {
      const u = need();
      const pw = await newPassword(u.username);
      Users.update(db, u.id, { password_hash: await hashPassword(pw), must_change_password: 1, failed_attempts: 0, locked_until: null });
      db.run('DELETE FROM sessions WHERE user_id = ?', u.id);
      console.log('Password reset; the user must change it at next sign-in.');
      break;
    }
    case 'reset-2fa': {
      const u = need();
      Users.update(db, u.id, { totp_enabled: 0, totp_secret_enc: null, totp_last_step: null, recovery_codes: null });
      db.run('DELETE FROM webauthn_credentials WHERE user_id = ?', u.id);
      db.run('DELETE FROM sessions WHERE user_id = ?', u.id);
      console.log('Two-factor methods removed; the user will be asked to enrol again.');
      break;
    }
    case 'unlock': {
      const u = need();
      Users.update(db, u.id, { failed_attempts: 0, locked_until: null, disabled: 0 });
      console.log('Unlocked.');
      break;
    }
    case 'revoke-sessions': {
      const u = need();
      const n = db.run('DELETE FROM sessions WHERE user_id = ?', u.id).changes;
      console.log(`Revoked ${n} session(s).`);
      break;
    }
    case 'list-users': {
      for (const u of Users.list(db)) {
        console.log(`${u.username.padEnd(24)} ${u.role.padEnd(6)} 2fa=${u.totp_enabled ? 'totp' : '-'} ${u.disabled ? 'DISABLED' : ''}`);
      }
      break;
    }
    default:
      console.log('Commands: create-admin | reset-password | reset-2fa | unlock | revoke-sessions | list-users');
  }
  db.close();
}

main().catch((err) => {
  console.error(`Error: ${(err as Error).message}`);
  process.exit(1);
});
