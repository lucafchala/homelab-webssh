import crypto from 'node:crypto';
import ssh2 from 'ssh2';

const { utils } = ssh2;

export type GeneratedKeyType = 'ed25519' | 'ecdsa' | 'rsa';

export function fingerprintBlob(blob: Buffer): string {
  return 'SHA256:' + crypto.createHash('sha256').update(blob).digest('base64').replace(/=+$/, '');
}

/** Key type name from an SSH wire-format public key blob (string type || ...). */
export function keyTypeFromBlob(blob: Buffer): string {
  if (blob.length < 4) return 'unknown';
  const len = blob.readUInt32BE(0);
  if (len <= 0 || len > 64 || 4 + len > blob.length) return 'unknown';
  return blob.subarray(4, 4 + len).toString('ascii');
}

function sanitizeComment(c: string): string {
  return c.replace(/[^\w@.+-]/g, '_').slice(0, 64);
}

export function generateKey(type: GeneratedKeyType, comment: string): { privateKey: string; publicKey: string; fingerprint: string; type: string } {
  const c = sanitizeComment(comment);
  const pair =
    type === 'rsa'
      ? utils.generateKeyPairSync('rsa', { bits: 4096, comment: c })
      : type === 'ecdsa'
        ? utils.generateKeyPairSync('ecdsa', { bits: 256, comment: c })
        : utils.generateKeyPairSync('ed25519', { comment: c });
  const info = inspectPrivateKey(pair.private);
  return { privateKey: pair.private, publicKey: pair.public.trim(), fingerprint: info.fingerprint, type: info.type };
}

/** Validate a private key (optionally encrypted) and derive its public half. */
export function inspectPrivateKey(text: string, passphrase?: string): { type: string; publicKey: string; fingerprint: string } {
  const parsed = utils.parseKey(text, passphrase || undefined);
  if (parsed instanceof Error) {
    if (/encrypted|passphrase|bad decrypt/i.test(parsed.message)) throw new Error('Key is encrypted: wrong or missing passphrase');
    throw new Error(`Unsupported or invalid private key: ${parsed.message}`);
  }
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!key.isPrivateKey()) throw new Error('That is a public key — paste the PRIVATE key');
  const blob = key.getPublicSSH();
  const comment = key.comment ? ` ${sanitizeComment(key.comment)}` : '';
  return {
    type: key.type,
    publicKey: `${key.type} ${blob.toString('base64')}${comment}`,
    fingerprint: fingerprintBlob(blob),
  };
}
