import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { Guards } from '../auth/guards.js';
import { Hosts, Keys, publicKeyRow } from '../db/models.js';
import { generateKey, inspectPrivateKey } from '../ssh/keys.js';
import { shq } from '../ssh/manager.js';
import { actor, badRequest, notFound, parse } from '../util/http.js';

const NAME = z.string().trim().min(1).max(100);

export function registerKeyRoutes(app: FastifyInstance, ctx: AppContext, guards: Guards) {
  const { db, vault, audit } = ctx;
  const pre = { preHandler: guards.user };

  app.get('/api/keys', pre, async (req) => Keys.byOwner(db, req.auth!.user.id).map(publicKeyRow));

  app.post('/api/keys/generate', pre, async (req) => {
    const body = parse(z.object({ name: NAME, type: z.enum(['ed25519', 'ecdsa', 'rsa']).default('ed25519') }), req.body);
    const user = req.auth!.user;
    const k = generateKey(body.type, `${user.username}@webssh`);
    const row = db.tx(() => {
      const created = Keys.create(db, {
        owner_id: user.id,
        name: body.name,
        type: k.type,
        public_key: k.publicKey,
        fingerprint: k.fingerprint,
        private_key_enc: 'pending',
        passphrase_enc: null,
      });
      db.run('UPDATE ssh_keys SET private_key_enc = ? WHERE id = ?', vault.encrypt(k.privateKey, `key:${created.id}`), created.id);
      return Keys.byId(db, created.id)!;
    });
    audit.write({ ...actor(req), action: 'key.generate', target: body.name, details: { type: k.type, fingerprint: k.fingerprint } });
    return publicKeyRow(row);
  });

  app.post('/api/keys/import', pre, async (req) => {
    const body = parse(z.object({ name: NAME, privateKey: z.string().min(1).max(20_000), passphrase: z.string().max(1024).optional() }), req.body);
    const user = req.auth!.user;
    let info;
    try {
      info = inspectPrivateKey(body.privateKey, body.passphrase);
    } catch (err) {
      throw badRequest((err as Error).message);
    }
    const row = db.tx(() => {
      const created = Keys.create(db, {
        owner_id: user.id,
        name: body.name,
        type: info.type,
        public_key: info.publicKey,
        fingerprint: info.fingerprint,
        private_key_enc: 'pending',
        passphrase_enc: null,
      });
      db.run(
        'UPDATE ssh_keys SET private_key_enc = ?, passphrase_enc = ? WHERE id = ?',
        vault.encrypt(body.privateKey.trim() + '\n', `key:${created.id}`),
        body.passphrase ? vault.encrypt(body.passphrase, `key:${created.id}`) : null,
        created.id,
      );
      return Keys.byId(db, created.id)!;
    });
    audit.write({ ...actor(req), action: 'key.import', target: body.name, details: { type: info.type, fingerprint: info.fingerprint } });
    return publicKeyRow(row);
  });

  app.patch('/api/keys/:id', pre, async (req) => {
    const { id } = req.params as { id: string };
    const { name } = parse(z.object({ name: NAME }), req.body);
    if (!Keys.rename(db, req.auth!.user.id, id, name)) throw notFound();
    return { ok: true };
  });

  app.delete('/api/keys/:id', pre, async (req) => {
    const { id } = req.params as { id: string };
    const k = Keys.byId(db, id);
    if (!k || k.owner_id !== req.auth!.user.id) throw notFound();
    const users = db.all<{ name: string }>('SELECT name FROM hosts WHERE key_id = ?', id);
    Keys.delete(db, req.auth!.user.id, id);
    // Hosts that used it fall back to asking for a password.
    db.run("UPDATE hosts SET auth_type = 'ask' WHERE key_id IS NULL AND auth_type = 'key'");
    audit.write({ ...actor(req), action: 'key.delete', target: k.name, details: { affectedHosts: users.map((u) => u.name) } });
    return { ok: true, affectedHosts: users.map((u) => u.name) };
  });

  /**
   * Like ssh-copy-id: append the public key to ~/.ssh/authorized_keys on a host
   * over the current (password-authenticated) connection. Idempotent.
   * Optionally switches the host to key authentication afterwards.
   */
  app.post('/api/keys/:id/install', pre, async (req) => {
    const { id } = req.params as { id: string };
    const body = parse(z.object({ hostId: z.string().max(64), switchHost: z.boolean().default(true) }), req.body);
    const user = req.auth!.user;
    const k = Keys.byId(db, id);
    if (!k || k.owner_id !== user.id) throw notFound('Key not found');
    const host = Hosts.accessible(db, user.id, body.hostId);
    if (!host) throw notFound('Host not found');
    const line = k.public_key.trim();
    if (!/^[a-z0-9-]+(@openssh\.com)? [A-Za-z0-9+/=]+( [\w@.+-]+)?$/.test(line)) throw badRequest('Unexpected public key format');
    const script =
      `umask 077; mkdir -p "$HOME/.ssh" && touch "$HOME/.ssh/authorized_keys" && ` +
      `chmod 700 "$HOME/.ssh" && chmod 600 "$HOME/.ssh/authorized_keys" && ` +
      `(grep -qxF ${shq(line)} "$HOME/.ssh/authorized_keys" && echo already-present || (echo ${shq(line)} >> "$HOME/.ssh/authorized_keys" && echo installed))`;
    const r = await ctx.ssh.run(user.id, host.id, script, { timeoutMs: 15_000 });
    const ok = r.code === 0;
    audit.write({ ...actor(req), action: 'key.install', target: `${k.name} → ${host.name}`, success: ok, details: { stderr: r.stderr.slice(0, 500) } });
    if (!ok) throw badRequest(`Could not install key: ${r.stderr.trim() || `exit code ${r.code}`}`);
    if (body.switchHost && host.owner_id === user.id) {
      Hosts.update(db, host.id, { auth_type: 'key', key_id: k.id, password_enc: null });
    }
    return { ok: true, result: r.stdout.trim(), switched: body.switchHost && host.owner_id === user.id };
  });
}
