import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/**
 * Secret vault: AES-256-GCM authenticated encryption for credentials at rest
 * (SSH passwords, private keys, TOTP secrets, AI API keys).
 *
 * Ciphertext format: "v1:" + base64url(iv[12] | tag[16] | ciphertext)
 * The data key is derived from the master key with HKDF so the raw master key
 * is never used directly; associated data binds a ciphertext to its purpose.
 */
export class Vault {
  private readonly key: Buffer;

  constructor(masterKey: Buffer) {
    if (masterKey.length < 32) throw new Error('Master key must be at least 32 bytes');
    this.key = Buffer.from(crypto.hkdfSync('sha256', masterKey, Buffer.alloc(0), 'webssh-vault-v1', 32));
  }

  encrypt(plaintext: string | Buffer, aad = ''): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const tag = cipher.getAuthTag();
    return 'v1:' + Buffer.concat([iv, tag, ct]).toString('base64url');
  }

  decrypt(payload: string, aad = ''): Buffer {
    if (!payload.startsWith('v1:')) throw new Error('Unsupported ciphertext version');
    const raw = Buffer.from(payload.slice(3), 'base64url');
    if (raw.length < 28) throw new Error('Ciphertext too short');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const ct = raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]);
  }

  decryptString(payload: string, aad = ''): string {
    return this.decrypt(payload, aad).toString('utf8');
  }

  encryptNullable(v: string | null | undefined, aad = ''): string | null {
    return v === null || v === undefined || v === '' ? null : this.encrypt(v, aad);
  }

  decryptNullable(v: string | null | undefined, aad = ''): string | null {
    return v ? this.decryptString(v, aad) : null;
  }
}

function decodeKey(text: string): Buffer {
  const t = text.trim();
  if (/^[0-9a-f]{64,}$/i.test(t)) return Buffer.from(t, 'hex');
  const b = Buffer.from(t, 'base64');
  if (b.length >= 32) return b;
  throw new Error('MASTER_KEY must be >= 32 bytes, encoded as hex or base64 (generate with: openssl rand -base64 32)');
}

/**
 * Resolve the master key from MASTER_KEY, MASTER_KEY_FILE (docker secret), or
 * an auto-generated key file inside the data dir (convenient, but then a copy
 * of the data dir is enough to decrypt it — documented in SECURITY.md).
 */
export function loadMasterKey(opts: { masterKey?: string; masterKeyFile?: string; dataDir: string }): {
  key: Buffer;
  source: 'env' | 'file' | 'generated';
} {
  if (opts.masterKey) return { key: decodeKey(opts.masterKey), source: 'env' };
  if (opts.masterKeyFile) return { key: decodeKey(fs.readFileSync(opts.masterKeyFile, 'utf8')), source: 'file' };
  const p = path.join(opts.dataDir, 'master.key');
  if (fs.existsSync(p)) return { key: decodeKey(fs.readFileSync(p, 'utf8')), source: 'generated' };
  const key = crypto.randomBytes(32);
  fs.writeFileSync(p, key.toString('base64') + '\n', { mode: 0o600 });
  return { key, source: 'generated' };
}

export function randomToken(bytes = 32): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    crypto.timingSafeEqual(ab, ab);
    return false;
  }
  return crypto.timingSafeEqual(ab, bb);
}

export function newId(): string {
  return crypto.randomUUID();
}
