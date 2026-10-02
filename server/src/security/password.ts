import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt) as (
  password: crypto.BinaryLike,
  salt: crypto.BinaryLike,
  keylen: number,
  options: crypto.ScryptOptions,
) => Promise<Buffer>;

// N=2^17, r=8, p=1 -> ~128 MiB memory, OWASP recommended scrypt parameters.
const PARAMS = { N: 131072, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const KEYLEN = 64;

/** Hash format: scrypt$N$r$p$salt(b64url)$hash(b64url) */
export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(password.normalize('NFKC'), salt, KEYLEN, PARAMS);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64url'), hash.toString('base64url')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64url');
  const N = Number(n);
  const actual = await scrypt(password.normalize('NFKC'), Buffer.from(saltB64, 'base64url'), expected.length, {
    N,
    r: Number(r),
    p: Number(p),
    maxmem: Math.max(256 * 1024 * 1024, 256 * N * Number(r)),
  });
  return crypto.timingSafeEqual(actual, expected);
}

/** A fixed hash used to keep timing uniform when the user does not exist. */
let dummyHash: string | null = null;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= await hashPassword('dummy-password-for-timing');
  await verifyPassword(password, dummyHash);
}

const COMMON = new Set([
  'password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwerty123', 'qwertyuiop',
  'letmein', 'welcome', 'admin123', 'administrator', 'changeme', 'iloveyou', 'homelab', 'raspberry', 'passw0rd',
]);

/** Returns an error message, or null when the password is acceptable. */
export function checkPasswordPolicy(password: string, username?: string): string | null {
  if (password.length < 12) return 'Password must be at least 12 characters long';
  if (password.length > 1024) return 'Password is too long';
  if (COMMON.has(password.toLowerCase())) return 'Password is too common';
  if (username && password.toLowerCase().includes(username.toLowerCase())) return 'Password must not contain the username';
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^a-zA-Z0-9]/].filter((r) => r.test(password)).length;
  if (password.length < 16 && classes < 3) {
    return 'Use at least 3 of: lowercase, uppercase, digits, symbols — or a passphrase of 16+ characters';
  }
  return null;
}
