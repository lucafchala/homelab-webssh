import { describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { Vault, safeEqual, sha256 } from '../src/security/crypto.js';
import { checkPasswordPolicy, hashPassword, verifyPassword } from '../src/security/password.js';
import { base32Decode, base32Encode, generateRecoveryCodes, hotp, totp, totpUri, verifyTotp } from '../src/security/totp.js';
import { CidrList, ipInCidr, parseCidr } from '../src/security/cidr.js';
import { FailureThrottle, TtlMap } from '../src/security/throttle.js';
import { Db } from '../src/db/index.js';
import { SessionStore } from '../src/auth/sessions.js';
import { Users } from '../src/db/models.js';

describe('Vault (AES-256-GCM)', () => {
  const vault = new Vault(crypto.randomBytes(32));

  it('round-trips secrets', () => {
    const ct = vault.encrypt('hunter2', 'host:1');
    expect(ct.startsWith('v1:')).toBe(true);
    expect(ct).not.toContain('hunter2');
    expect(vault.decryptString(ct, 'host:1')).toBe('hunter2');
  });

  it('binds ciphertext to its associated data', () => {
    const ct = vault.encrypt('secret', 'host:1');
    expect(() => vault.decryptString(ct, 'host:2')).toThrow();
  });

  it('detects tampering', () => {
    const ct = vault.encrypt('secret');
    const raw = Buffer.from(ct.slice(3), 'base64url');
    raw[raw.length - 1] ^= 1;
    expect(() => vault.decrypt('v1:' + raw.toString('base64url'))).toThrow();
  });

  it('rejects a different key', () => {
    const other = new Vault(crypto.randomBytes(32));
    expect(() => other.decrypt(vault.encrypt('x'))).toThrow();
  });

  it('uses a random IV per encryption', () => {
    expect(vault.encrypt('same')).not.toBe(vault.encrypt('same'));
  });

  it('safeEqual and sha256 behave', () => {
    expect(safeEqual('abc', 'abc')).toBe(true);
    expect(safeEqual('abc', 'abd')).toBe(false);
    expect(safeEqual('abc', 'abcd')).toBe(false);
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });
});

describe('passwords', () => {
  it('hashes and verifies with scrypt', async () => {
    const h = await hashPassword('Correct-Horse-Battery-9');
    expect(h.startsWith('scrypt$')).toBe(true);
    expect(await verifyPassword('Correct-Horse-Battery-9', h)).toBe(true);
    expect(await verifyPassword('wrong', h)).toBe(false);
  });

  it('enforces a sane policy', () => {
    expect(checkPasswordPolicy('short')).toMatch(/12 characters/);
    expect(checkPasswordPolicy('password123')).not.toBeNull();
    expect(checkPasswordPolicy('alllowercaseonly')).toBeNull(); // 16+ char passphrase is fine
    expect(checkPasswordPolicy('lowercaseonly')).toMatch(/at least 3/);
    expect(checkPasswordPolicy('Admin-Secret-99', 'admin')).toMatch(/username/);
    expect(checkPasswordPolicy('Good-Pass-word-1')).toBeNull();
  });
});

describe('TOTP (RFC 4226 / 6238)', () => {
  const secret = base32Encode(Buffer.from('12345678901234567890'));

  it('base32 round-trips', () => {
    expect(secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
  });

  it('matches the RFC 4226 HOTP vectors', () => {
    const key = Buffer.from('12345678901234567890');
    const expected = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
    expected.forEach((code, i) => expect(hotp(key, i)).toBe(code));
  });

  it('matches RFC 6238 SHA1 vectors (last 6 digits)', () => {
    expect(totp(secret, 59_000)).toBe('287082');
    expect(totp(secret, 1111111109_000)).toBe('081804');
    expect(totp(secret, 1234567890_000)).toBe('005924');
  });

  it('accepts ±1 step drift and blocks replays', () => {
    const t = 1_700_000_000_000;
    const code = totp(secret, t - 30_000);
    const step = verifyTotp(secret, code, { time: t });
    expect(step).not.toBeNull();
    expect(verifyTotp(secret, code, { time: t, lastUsedStep: step })).toBeNull();
    expect(verifyTotp(secret, totp(secret, t - 120_000), { time: t })).toBeNull();
    expect(verifyTotp(secret, 'abcdef', { time: t })).toBeNull();
  });

  it('builds otpauth URIs and recovery codes', () => {
    expect(totpUri(secret, 'alice', 'WebSSH')).toMatch(/^otpauth:\/\/totp\/WebSSH%3Aalice\?secret=GEZ/);
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    for (const c of codes) expect(c).toMatch(/^[a-z2-7]{5}-[a-z2-7]{5}$/);
    expect(new Set(codes).size).toBe(10);
  });
});

describe('CIDR matching', () => {
  it('matches IPv4 and IPv6', () => {
    expect(ipInCidr('192.168.1.20', parseCidr('192.168.1.0/24'))).toBe(true);
    expect(ipInCidr('192.168.2.20', parseCidr('192.168.1.0/24'))).toBe(false);
    expect(ipInCidr('::ffff:10.0.0.5', parseCidr('10.0.0.0/8'))).toBe(true);
    expect(ipInCidr('fd00::1', parseCidr('fd00::/8'))).toBe(true);
    expect(ipInCidr('2001:db8::1', parseCidr('fd00::/8'))).toBe(false);
    expect(ipInCidr('127.0.0.1', parseCidr('127.0.0.1'))).toBe(true);
    expect(ipInCidr('10.0.0.1', parseCidr('0.0.0.0/0'))).toBe(true);
  });

  it('empty list allows everything; rejects garbage', () => {
    expect(new CidrList([]).allows('8.8.8.8')).toBe(true);
    const l = new CidrList(['192.168.0.0/16', '100.64.0.0/10']);
    expect(l.allows('100.100.1.1')).toBe(true);
    expect(l.allows('8.8.8.8')).toBe(false);
    expect(() => parseCidr('not-an-ip/8')).toThrow();
    expect(() => parseCidr('10.0.0.0/33')).toThrow();
  });
});

describe('throttles', () => {
  it('blocks after N failures within the window', () => {
    const t = new FailureThrottle(3, 1000);
    t.fail('ip', 0);
    t.fail('ip', 10);
    expect(t.blocked('ip', 20)).toBe(false);
    t.fail('ip', 20);
    expect(t.blocked('ip', 30)).toBe(true);
    expect(t.retryAfter('ip', 30)).toBe(1);
    expect(t.blocked('ip', 1100)).toBe(false);
  });

  it('TtlMap take() is single-use', () => {
    const m = new TtlMap<string>(1000);
    m.set('k', 'v');
    expect(m.take('k')).toBe('v');
    expect(m.take('k')).toBeUndefined();
  });
});

describe('sessions', () => {
  it('stores only token hashes, rotates on promotion, enforces expiry', () => {
    const db = Db.memory();
    const u = Users.create(db, { username: 'alice', passwordHash: 'x', role: 'admin' });
    const store = new SessionStore(db, { idleMs: 60_000, maxMs: 3600_000 });
    const { token, session } = store.create(u.id, 'mfa', {});
    expect(session.id).toBe(sha256(token));
    expect(db.get('SELECT * FROM sessions WHERE id = ?', token)).toBeUndefined();
    expect(store.resolve(token)?.stage).toBe('mfa');
    const promoted = store.promote(session);
    expect(promoted.token).not.toBe(token);
    expect(store.resolve(token)).toBeNull();
    expect(store.resolve(promoted.token)?.stage).toBe('full');
    db.run('UPDATE sessions SET last_seen_at = 0');
    expect(store.resolve(promoted.token)).toBeNull();
  });
});
