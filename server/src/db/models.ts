import type { Db } from './index.js';
import { now, parseJson } from './index.js';
import { newId } from '../security/crypto.js';

// ---------------------------------------------------------------- users
export type Role = 'admin' | 'user';

export interface UserRow {
  id: string;
  username: string;
  display_name: string | null;
  password_hash: string;
  role: Role;
  totp_secret_enc: string | null;
  totp_enabled: number;
  totp_last_step: number | null;
  recovery_codes: string | null;
  disabled: number;
  must_change_password: number;
  settings: string;
  failed_attempts: number;
  locked_until: number | null;
  created_at: number;
  updated_at: number;
  last_login_at: number | null;
}

export function publicUser(u: UserRow, extra: { passkeys?: number } = {}) {
  return {
    id: u.id,
    username: u.username,
    displayName: u.display_name ?? u.username,
    role: u.role,
    totpEnabled: !!u.totp_enabled,
    passkeys: extra.passkeys ?? 0,
    disabled: !!u.disabled,
    mustChangePassword: !!u.must_change_password,
    createdAt: u.created_at,
    lastLoginAt: u.last_login_at,
    locked: !!(u.locked_until && u.locked_until > Date.now()),
    settings: parseJson<Record<string, unknown>>(u.settings, {}),
  };
}

export const Users = {
  count(db: Db): number {
    return db.get<{ n: number }>('SELECT COUNT(*) AS n FROM users')!.n;
  },
  byId(db: Db, id: string) {
    return db.get<UserRow>('SELECT * FROM users WHERE id = ?', id);
  },
  byUsername(db: Db, username: string) {
    return db.get<UserRow>('SELECT * FROM users WHERE username = ?', username);
  },
  list(db: Db) {
    return db.all<UserRow>('SELECT * FROM users ORDER BY username');
  },
  create(db: Db, u: { username: string; passwordHash: string; role: Role; displayName?: string; mustChangePassword?: boolean }) {
    const id = newId();
    const t = now();
    db.run(
      `INSERT INTO users (id, username, display_name, password_hash, role, must_change_password, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      u.username,
      u.displayName ?? null,
      u.passwordHash,
      u.role,
      u.mustChangePassword ? 1 : 0,
      t,
      t,
    );
    return Users.byId(db, id)!;
  },
  update(db: Db, id: string, fields: Partial<Omit<UserRow, 'id' | 'created_at'>>) {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    db.run(`UPDATE users SET ${sets}, updated_at = ? WHERE id = ?`, ...keys.map((k) => fields[k] as never), now(), id);
  },
  delete(db: Db, id: string) {
    db.run('DELETE FROM users WHERE id = ?', id);
  },
  adminCount(db: Db): number {
    return db.get<{ n: number }>("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND disabled = 0")!.n;
  },
};

// ---------------------------------------------------------------- passkeys
export interface PasskeyRow {
  id: string;
  user_id: string;
  public_key: Uint8Array;
  counter: number;
  transports: string | null;
  name: string;
  device_type: string | null;
  backed_up: number;
  created_at: number;
  last_used_at: number | null;
}

export const Passkeys = {
  byUser(db: Db, userId: string) {
    return db.all<PasskeyRow>('SELECT * FROM webauthn_credentials WHERE user_id = ? ORDER BY created_at', userId);
  },
  byId(db: Db, id: string) {
    return db.get<PasskeyRow>('SELECT * FROM webauthn_credentials WHERE id = ?', id);
  },
  count(db: Db, userId: string): number {
    return db.get<{ n: number }>('SELECT COUNT(*) AS n FROM webauthn_credentials WHERE user_id = ?', userId)!.n;
  },
  create(db: Db, p: { id: string; userId: string; publicKey: Uint8Array; counter: number; transports?: string[]; name: string; deviceType?: string; backedUp?: boolean }) {
    db.run(
      `INSERT INTO webauthn_credentials (id, user_id, public_key, counter, transports, name, device_type, backed_up, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      p.id,
      p.userId,
      p.publicKey,
      p.counter,
      JSON.stringify(p.transports ?? []),
      p.name,
      p.deviceType ?? null,
      p.backedUp ? 1 : 0,
      now(),
    );
  },
  touch(db: Db, id: string, counter: number) {
    db.run('UPDATE webauthn_credentials SET counter = ?, last_used_at = ? WHERE id = ?', counter, now(), id);
  },
  rename(db: Db, userId: string, id: string, name: string) {
    return db.run('UPDATE webauthn_credentials SET name = ? WHERE id = ? AND user_id = ?', name, id, userId).changes;
  },
  delete(db: Db, userId: string, id: string) {
    return db.run('DELETE FROM webauthn_credentials WHERE id = ? AND user_id = ?', id, userId).changes;
  },
};

// ---------------------------------------------------------------- ssh keys
export interface KeyRow {
  id: string;
  owner_id: string;
  name: string;
  type: string;
  public_key: string;
  fingerprint: string;
  private_key_enc: string;
  passphrase_enc: string | null;
  created_at: number;
}

export const publicKeyRow = (k: KeyRow) => ({
  id: k.id,
  name: k.name,
  type: k.type,
  publicKey: k.public_key,
  fingerprint: k.fingerprint,
  hasPassphrase: !!k.passphrase_enc,
  createdAt: k.created_at,
});

export const Keys = {
  byOwner(db: Db, ownerId: string) {
    return db.all<KeyRow>('SELECT * FROM ssh_keys WHERE owner_id = ? ORDER BY name', ownerId);
  },
  byId(db: Db, id: string) {
    return db.get<KeyRow>('SELECT * FROM ssh_keys WHERE id = ?', id);
  },
  create(db: Db, k: Omit<KeyRow, 'id' | 'created_at'>) {
    const id = newId();
    db.run(
      `INSERT INTO ssh_keys (id, owner_id, name, type, public_key, fingerprint, private_key_enc, passphrase_enc, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      k.owner_id,
      k.name,
      k.type,
      k.public_key,
      k.fingerprint,
      k.private_key_enc,
      k.passphrase_enc,
      now(),
    );
    return Keys.byId(db, id)!;
  },
  rename(db: Db, ownerId: string, id: string, name: string) {
    return db.run('UPDATE ssh_keys SET name = ? WHERE id = ? AND owner_id = ?', name, id, ownerId).changes;
  },
  delete(db: Db, ownerId: string, id: string) {
    return db.run('DELETE FROM ssh_keys WHERE id = ? AND owner_id = ?', id, ownerId).changes;
  },
};

// ---------------------------------------------------------------- hosts
export interface HostRow {
  id: string;
  owner_id: string;
  name: string;
  hostname: string;
  port: number;
  username: string;
  auth_type: 'password' | 'key' | 'ask';
  password_enc: string | null;
  key_id: string | null;
  jump_host_id: string | null;
  group_name: string;
  tags: string;
  color: string | null;
  notes: string;
  mac_address: string | null;
  startup_command: string | null;
  shared: number;
  record: number;
  use_sudo: number;
  favorite: number;
  host_key_type: string | null;
  host_key_fp: string | null;
  host_key_trusted_at: number | null;
  last_connected_at: number | null;
  created_at: number;
  updated_at: number;
}

export function publicHost(h: HostRow, viewerId: string) {
  return {
    id: h.id,
    name: h.name,
    hostname: h.hostname,
    port: h.port,
    username: h.username,
    authType: h.auth_type,
    hasPassword: !!h.password_enc,
    keyId: h.key_id,
    jumpHostId: h.jump_host_id,
    group: h.group_name,
    tags: parseJson<string[]>(h.tags, []),
    color: h.color,
    notes: h.notes,
    macAddress: h.mac_address,
    startupCommand: h.startup_command,
    shared: !!h.shared,
    record: !!h.record,
    useSudo: !!h.use_sudo,
    favorite: !!h.favorite,
    hostKey: h.host_key_fp ? { type: h.host_key_type, fingerprint: h.host_key_fp, trustedAt: h.host_key_trusted_at } : null,
    lastConnectedAt: h.last_connected_at,
    owned: h.owner_id === viewerId,
    createdAt: h.created_at,
    updatedAt: h.updated_at,
  };
}

export const Hosts = {
  /** Hosts a user may use: their own plus shared ones. */
  visibleTo(db: Db, userId: string) {
    return db.all<HostRow>('SELECT * FROM hosts WHERE owner_id = ? OR shared = 1 ORDER BY favorite DESC, group_name, name', userId);
  },
  byId(db: Db, id: string) {
    return db.get<HostRow>('SELECT * FROM hosts WHERE id = ?', id);
  },
  accessible(db: Db, userId: string, id: string) {
    return db.get<HostRow>('SELECT * FROM hosts WHERE id = ? AND (owner_id = ? OR shared = 1)', id, userId);
  },
  owned(db: Db, userId: string, id: string) {
    return db.get<HostRow>('SELECT * FROM hosts WHERE id = ? AND owner_id = ?', id, userId);
  },
  create(db: Db, h: Omit<HostRow, 'id' | 'created_at' | 'updated_at' | 'host_key_type' | 'host_key_fp' | 'host_key_trusted_at' | 'last_connected_at'>) {
    const id = newId();
    const t = now();
    db.run(
      `INSERT INTO hosts (id, owner_id, name, hostname, port, username, auth_type, password_enc, key_id, jump_host_id,
        group_name, tags, color, notes, mac_address, startup_command, shared, record, use_sudo, favorite, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      h.owner_id,
      h.name,
      h.hostname,
      h.port,
      h.username,
      h.auth_type,
      h.password_enc,
      h.key_id,
      h.jump_host_id,
      h.group_name,
      h.tags,
      h.color,
      h.notes,
      h.mac_address,
      h.startup_command,
      h.shared,
      h.record,
      h.use_sudo,
      h.favorite,
      t,
      t,
    );
    return Hosts.byId(db, id)!;
  },
  update(db: Db, id: string, fields: Partial<Omit<HostRow, 'id' | 'owner_id' | 'created_at'>>) {
    const keys = Object.keys(fields) as (keyof typeof fields)[];
    if (!keys.length) return;
    const sets = keys.map((k) => `${k} = ?`).join(', ');
    db.run(`UPDATE hosts SET ${sets}, updated_at = ? WHERE id = ?`, ...keys.map((k) => fields[k] as never), now(), id);
  },
  setHostKey(db: Db, id: string, type: string | null, fp: string | null) {
    db.run('UPDATE hosts SET host_key_type = ?, host_key_fp = ?, host_key_trusted_at = ? WHERE id = ?', type, fp, fp ? now() : null, id);
  },
  touch(db: Db, id: string) {
    db.run('UPDATE hosts SET last_connected_at = ? WHERE id = ?', now(), id);
  },
  delete(db: Db, id: string) {
    db.run('DELETE FROM hosts WHERE id = ?', id);
  },
};

// ---------------------------------------------------------------- snippets
export interface SnippetRow {
  id: string;
  owner_id: string;
  name: string;
  command: string;
  description: string;
  tags: string;
  shared: number;
  created_at: number;
  updated_at: number;
}

export const publicSnippet = (s: SnippetRow, viewerId: string) => ({
  id: s.id,
  name: s.name,
  command: s.command,
  description: s.description,
  tags: parseJson<string[]>(s.tags, []),
  shared: !!s.shared,
  owned: s.owner_id === viewerId,
  createdAt: s.created_at,
  updatedAt: s.updated_at,
});

export const Snippets = {
  visibleTo(db: Db, userId: string) {
    return db.all<SnippetRow>('SELECT * FROM snippets WHERE owner_id = ? OR shared = 1 ORDER BY name', userId);
  },
  owned(db: Db, userId: string, id: string) {
    return db.get<SnippetRow>('SELECT * FROM snippets WHERE id = ? AND owner_id = ?', id, userId);
  },
  create(db: Db, s: { owner_id: string; name: string; command: string; description: string; tags: string; shared: number }) {
    const id = newId();
    const t = now();
    db.run(
      'INSERT INTO snippets (id, owner_id, name, command, description, tags, shared, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      s.owner_id,
      s.name,
      s.command,
      s.description,
      s.tags,
      s.shared,
      t,
      t,
    );
    return db.get<SnippetRow>('SELECT * FROM snippets WHERE id = ?', id)!;
  },
  update(db: Db, id: string, s: { name: string; command: string; description: string; tags: string; shared: number }) {
    db.run(
      'UPDATE snippets SET name = ?, command = ?, description = ?, tags = ?, shared = ?, updated_at = ? WHERE id = ?',
      s.name,
      s.command,
      s.description,
      s.tags,
      s.shared,
      now(),
      id,
    );
    return db.get<SnippetRow>('SELECT * FROM snippets WHERE id = ?', id)!;
  },
  delete(db: Db, userId: string, id: string) {
    return db.run('DELETE FROM snippets WHERE id = ? AND owner_id = ?', id, userId).changes;
  },
};

// ---------------------------------------------------------------- settings (global key/value)
export const Settings = {
  get<T>(db: Db, key: string, fallback: T): T {
    const r = db.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', key);
    return r ? parseJson<T>(r.value, fallback) : fallback;
  },
  set(db: Db, key: string, value: unknown) {
    db.run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, JSON.stringify(value));
  },
};
