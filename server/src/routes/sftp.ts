import path from 'node:path/posix';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { FileEntry, SFTPWrapper, Stats } from 'ssh2';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { Guards } from '../auth/guards.js';
import { Hosts, type HostRow } from '../db/models.js';
import { SshError, shq, type Lease } from '../ssh/manager.js';
import { randomToken } from '../security/crypto.js';
import { actor, badRequest, conflict, HttpError, notFound, parse } from '../util/http.js';

const MAX_EDIT_BYTES = 5 * 1024 * 1024;
const PathStr = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => !p.includes('\0'), 'Invalid path');

const S_IFMT = 0o170000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const S_IFREG = 0o100000;

function typeOf(mode: number): 'dir' | 'file' | 'link' | 'other' {
  const t = mode & S_IFMT;
  if (t === S_IFDIR) return 'dir';
  if (t === S_IFLNK) return 'link';
  if (t === S_IFREG) return 'file';
  return 'other';
}

function permString(mode: number): string {
  const t = typeOf(mode);
  const chars = 'rwxrwxrwx';
  let s = t === 'dir' ? 'd' : t === 'link' ? 'l' : t === 'file' ? '-' : '?';
  for (let i = 0; i < 9; i++) s += mode & (1 << (8 - i)) ? chars[i] : '-';
  return s;
}

// ---- promisified SFTP helpers
const p = {
  readdir: (s: SFTPWrapper, dir: string) => new Promise<FileEntry[]>((res, rej) => s.readdir(dir, (e, l) => (e ? rej(e) : res(l)))),
  stat: (s: SFTPWrapper, f: string) => new Promise<Stats>((res, rej) => s.stat(f, (e, st) => (e ? rej(e) : res(st)))),
  lstat: (s: SFTPWrapper, f: string) => new Promise<Stats>((res, rej) => s.lstat(f, (e, st) => (e ? rej(e) : res(st)))),
  realpath: (s: SFTPWrapper, f: string) => new Promise<string>((res, rej) => s.realpath(f, (e, r) => (e ? rej(e) : res(r)))),
  readlink: (s: SFTPWrapper, f: string) => new Promise<string>((res, rej) => s.readlink(f, (e, r) => (e ? rej(e) : res(r)))),
  mkdir: (s: SFTPWrapper, d: string) => new Promise<void>((res, rej) => s.mkdir(d, (e) => (e ? rej(e) : res()))),
  rmdir: (s: SFTPWrapper, d: string) => new Promise<void>((res, rej) => s.rmdir(d, (e) => (e ? rej(e) : res()))),
  unlink: (s: SFTPWrapper, f: string) => new Promise<void>((res, rej) => s.unlink(f, (e) => (e ? rej(e) : res()))),
  rename: (s: SFTPWrapper, a: string, b: string) => new Promise<void>((res, rej) => s.rename(a, b, (e) => (e ? rej(e) : res()))),
  posixRename: (s: SFTPWrapper, a: string, b: string) => new Promise<void>((res, rej) => s.ext_openssh_rename(a, b, (e) => (e ? rej(e) : res()))),
  chmod: (s: SFTPWrapper, f: string, mode: number) => new Promise<void>((res, rej) => s.chmod(f, mode, (e) => (e ? rej(e) : res()))),
  writeFile: (s: SFTPWrapper, f: string, data: Buffer, mode?: number) =>
    new Promise<void>((res, rej) => s.writeFile(f, data, mode !== undefined ? { mode } : {}, (e) => (e ? rej(e) : res()))),
  readFile: (s: SFTPWrapper, f: string) => new Promise<Buffer>((res, rej) => s.readFile(f, (e, d) => (e ? rej(e) : res(d)))),
};

function sftpError(err: unknown): HttpError {
  if (err instanceof HttpError) return err;
  if (err instanceof SshError) return new HttpError(err.code === 'NOT_FOUND' ? 404 : 502, err.message, err.code);
  const e = err as { code?: number; message?: string };
  // SFTP status codes: 2 = no such file, 3 = permission denied, 4 = failure
  if (e.code === 2) return new HttpError(404, 'No such file or directory', 'ENOENT');
  if (e.code === 3) return new HttpError(403, 'Permission denied', 'EACCES');
  return new HttpError(500, e.message || 'SFTP operation failed');
}

export function registerSftpRoutes(app: FastifyInstance, ctx: AppContext, guards: Guards) {
  const { db, audit } = ctx;
  const pre = { preHandler: guards.user };

  async function open(req: FastifyRequest): Promise<{ host: HostRow; lease: Lease; sftp: SFTPWrapper }> {
    const { hostId } = req.params as { hostId: string };
    const host = Hosts.accessible(db, req.auth!.user.id, hostId);
    if (!host) throw notFound('Host not found');
    let lease: Lease;
    try {
      lease = await ctx.ssh.lease(req.auth!.user.id, host.id);
    } catch (err) {
      throw sftpError(err);
    }
    try {
      return { host, lease, sftp: await lease.conn.sftp() };
    } catch (err) {
      lease.release();
      throw sftpError(err);
    }
  }

  async function withSftp<T>(req: FastifyRequest, fn: (s: SFTPWrapper, host: HostRow, lease: Lease) => Promise<T>): Promise<T> {
    const { host, lease, sftp } = await open(req);
    try {
      return await fn(sftp, host, lease);
    } catch (err) {
      throw sftpError(err);
    } finally {
      lease.release();
    }
  }

  // ---------------------------------------------------------------- browse
  app.get('/api/sftp/:hostId/list', pre, async (req) => {
    const q = parse(z.object({ path: PathStr.optional(), hidden: z.enum(['0', '1']).optional() }), req.query);
    return withSftp(req, async (sftp) => {
      const dir = await p.realpath(sftp, q.path || '.');
      const list = await p.readdir(sftp, dir);
      let linkChecks = 0;
      const entries = await Promise.all(
        list.map(async (f) => {
          let type = typeOf(f.attrs.mode);
          let target: string | null = null;
          if (type === 'link' && linkChecks++ < 300) {
            const full = path.join(dir, f.filename);
            try {
              target = await p.readlink(sftp, full);
              const st = await p.stat(sftp, full);
              type = typeOf(st.mode) === 'dir' ? 'dir' : 'file';
            } catch {
              /* dangling link */
            }
          }
          // longname looks like `ls -l`: perms links owner group size ...
          const parts = f.longname.split(/\s+/);
          return {
            name: f.filename,
            type,
            isLink: typeOf(f.attrs.mode) === 'link',
            target,
            size: f.attrs.size,
            mtime: f.attrs.mtime,
            mode: f.attrs.mode & 0o7777,
            perms: permString(f.attrs.mode),
            owner: parts[2] ?? String(f.attrs.uid),
            group: parts[3] ?? String(f.attrs.gid),
          };
        }),
      );
      const filtered = q.hidden === '0' ? entries.filter((e) => !e.name.startsWith('.')) : entries;
      filtered.sort((a, b) => (a.type === 'dir' ? 0 : 1) - (b.type === 'dir' ? 0 : 1) || a.name.localeCompare(b.name));
      return { path: dir, parent: dir === '/' ? null : path.dirname(dir), entries: filtered };
    });
  });

  app.get('/api/sftp/:hostId/stat', pre, async (req) => {
    const q = parse(z.object({ path: PathStr }), req.query);
    return withSftp(req, async (sftp) => {
      const st = await p.stat(sftp, q.path);
      return { path: q.path, type: typeOf(st.mode), size: st.size, mtime: st.mtime, mode: st.mode & 0o7777, perms: permString(st.mode) };
    });
  });

  // ---------------------------------------------------------------- download (file, or directory as tar.gz)
  app.get('/api/sftp/:hostId/download', pre, async (req, reply) => {
    const q = parse(z.object({ path: PathStr, inline: z.enum(['0', '1']).optional() }), req.query);
    const { host, lease, sftp } = await open(req);
    let released = false;
    const release = () => {
      if (!released) {
        released = true;
        lease.release();
      }
    };
    try {
      const st = await p.stat(sftp, q.path);
      const base = path.basename(q.path) || 'download';
      audit.write({ ...actor(req), action: 'sftp.download', target: `${host.name}:${q.path}` });
      if (typeOf(st.mode) === 'dir') {
        return await streamTar(reply, lease, q.path, base, release);
      }
      const stream = sftp.createReadStream(q.path);
      stream.on('close', release);
      stream.on('error', release);
      reply.raw.on('close', () => {
        stream.destroy();
        release();
      });
      reply.header('content-type', 'application/octet-stream');
      reply.header('content-length', String(st.size));
      reply.header('content-disposition', `${q.inline === '1' ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(base)}`);
      reply.header('x-content-type-options', 'nosniff');
      return reply.send(stream);
    } catch (err) {
      release();
      throw sftpError(err);
    }
  });

  async function streamTar(reply: FastifyReply, lease: Lease, dirPath: string, base: string, release: () => void) {
    const parent = path.dirname(dirPath);
    const cmd = `tar -czf - -C ${shq(parent)} -- ${shq(path.basename(dirPath))}`;
    const channel = await new Promise<import('ssh2').ClientChannel>((res, rej) => lease.conn.client.exec(cmd, (e, ch) => (e ? rej(e) : res(ch))));
    channel.on('close', release);
    channel.stderr.resume();
    reply.raw.on('close', () => {
      channel.close();
      release();
    });
    reply.header('content-type', 'application/gzip');
    reply.header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(base + '.tar.gz')}`);
    return reply.send(channel);
  }

  // ---------------------------------------------------------------- upload (multipart, one or more files)
  app.post('/api/sftp/:hostId/upload', pre, async (req) => {
    const q = parse(z.object({ path: PathStr, overwrite: z.enum(['0', '1']).optional() }), req.query);
    if (!req.isMultipart()) throw badRequest('Expected multipart/form-data');
    return withSftp(req, async (sftp, host) => {
      const dir = await p.realpath(sftp, q.path);
      const uploaded: { name: string; size: number }[] = [];
      for await (const part of req.files({ limits: { fileSize: ctx.config.maxUploadBytes } })) {
        const name = path.basename(part.filename.replace(/\\/g, '/'));
        if (!name || name === '.' || name === '..' || name.includes('\0')) {
          part.file.resume();
          throw badRequest('Invalid file name');
        }
        const target = path.join(dir, name);
        if (q.overwrite !== '1') {
          const exists = await p.lstat(sftp, target).then(
            () => true,
            () => false,
          );
          if (exists) {
            part.file.resume();
            throw conflict(`${name} already exists`, 'EXISTS');
          }
        }
        let size = 0;
        await new Promise<void>((resolve, reject) => {
          const ws = sftp.createWriteStream(target, { mode: 0o644 });
          part.file.on('data', (c: Buffer) => (size += c.length));
          part.file.on('error', reject);
          ws.on('error', reject);
          ws.on('close', () => resolve());
          part.file.pipe(ws);
        });
        if (part.file.truncated) {
          await p.unlink(sftp, target).catch(() => {});
          throw new HttpError(413, `${name} exceeds the upload limit`);
        }
        uploaded.push({ name, size });
        audit.write({ ...actor(req), action: 'sftp.upload', target: `${host.name}:${target}`, details: { size } });
      }
      return { ok: true, uploaded };
    });
  });

  // ---------------------------------------------------------------- text editor read/write
  app.get('/api/sftp/:hostId/read', pre, async (req) => {
    const q = parse(z.object({ path: PathStr, sudo: z.enum(['0', '1']).optional() }), req.query);
    return withSftp(req, async (sftp, host, lease) => {
      if (q.sudo === '1') {
        if (!host.use_sudo) throw badRequest('sudo is not enabled for this host');
        const r = await ctx.ssh.exec(lease.conn, `sudo -n stat -c %Y -- ${shq(q.path)} && sudo -n cat -- ${shq(q.path)}`, {
          timeoutMs: 20_000,
          maxBytes: MAX_EDIT_BYTES + 64,
        });
        if (r.code !== 0) throw badRequest(r.stderr.trim() || 'sudo read failed (passwordless sudo required)');
        const nl = r.stdout.indexOf('\n');
        const content = r.stdout.slice(nl + 1);
        if (r.truncated) throw new HttpError(413, 'File too large for the editor (max 5 MB)');
        return { path: q.path, content, mtime: Number(r.stdout.slice(0, nl)), size: Buffer.byteLength(content), binary: content.includes('\0') };
      }
      const st = await p.stat(sftp, q.path);
      if (typeOf(st.mode) !== 'file') throw badRequest('Not a regular file');
      if (st.size > MAX_EDIT_BYTES) throw new HttpError(413, 'File too large for the editor (max 5 MB) — download it instead');
      const buf = await p.readFile(sftp, q.path);
      const binary = buf.subarray(0, 8192).includes(0);
      return { path: q.path, content: binary ? '' : buf.toString('utf8'), mtime: st.mtime, size: st.size, mode: st.mode & 0o7777, binary };
    });
  });

  app.put('/api/sftp/:hostId/write', pre, async (req) => {
    const body = parse(
      z.object({
        path: PathStr,
        content: z.string().max(MAX_EDIT_BYTES),
        expectedMtime: z.number().int().optional(),
        create: z.boolean().default(false),
        sudo: z.boolean().default(false),
      }),
      req.body,
    );
    return withSftp(req, async (sftp, host, lease) => {
      const data = Buffer.from(body.content, 'utf8');
      if (body.sudo) {
        if (!host.use_sudo) throw badRequest('sudo is not enabled for this host');
        const r = await ctx.ssh.exec(lease.conn, `sudo -n tee -- ${shq(body.path)} > /dev/null`, { stdin: data, timeoutMs: 30_000 });
        if (r.code !== 0) throw badRequest(r.stderr.trim() || 'sudo write failed (passwordless sudo required)');
        audit.write({ ...actor(req), action: 'sftp.write', target: `${host.name}:${body.path}`, details: { sudo: true, size: data.length } });
        return { ok: true };
      }
      let st: Stats | null = null;
      try {
        st = await p.stat(sftp, body.path);
      } catch (err) {
        if ((err as { code?: number }).code !== 2 || !body.create) throw err;
      }
      if (st && body.expectedMtime !== undefined && st.mtime !== body.expectedMtime) {
        throw conflict('The file changed on the server since you opened it', 'MODIFIED');
      }
      const mode = st ? st.mode & 0o7777 : 0o644;
      // Atomic replace: write a temp file next to it, then rename over the original.
      const tmp = path.join(path.dirname(body.path), `.${path.basename(body.path)}.webssh-${randomToken(6)}`);
      try {
        await p.writeFile(sftp, tmp, data, mode);
        await p.chmod(sftp, tmp, mode).catch(() => {});
        await p.posixRename(sftp, tmp, body.path).catch(async () => {
          await p.unlink(sftp, body.path).catch(() => {});
          await p.rename(sftp, tmp, body.path);
        });
      } catch (err) {
        await p.unlink(sftp, tmp).catch(() => {});
        // Directory not writable but file is: fall back to an in-place write.
        if ((err as { code?: number }).code === 3 && st) await p.writeFile(sftp, body.path, data);
        else throw err;
      }
      const after = await p.stat(sftp, body.path);
      audit.write({ ...actor(req), action: 'sftp.write', target: `${host.name}:${body.path}`, details: { size: data.length } });
      return { ok: true, mtime: after.mtime, size: after.size };
    });
  });

  // ---------------------------------------------------------------- file operations
  app.post('/api/sftp/:hostId/mkdir', pre, async (req) => {
    const body = parse(z.object({ path: PathStr }), req.body);
    return withSftp(req, async (sftp, host) => {
      await p.mkdir(sftp, body.path);
      audit.write({ ...actor(req), action: 'sftp.mkdir', target: `${host.name}:${body.path}` });
      return { ok: true };
    });
  });

  app.post('/api/sftp/:hostId/touch', pre, async (req) => {
    const body = parse(z.object({ path: PathStr }), req.body);
    return withSftp(req, async (sftp, host) => {
      const exists = await p.lstat(sftp, body.path).then(
        () => true,
        () => false,
      );
      if (exists) throw conflict('A file with that name already exists', 'EXISTS');
      await p.writeFile(sftp, body.path, Buffer.alloc(0), 0o644);
      audit.write({ ...actor(req), action: 'sftp.create', target: `${host.name}:${body.path}` });
      return { ok: true };
    });
  });

  app.post('/api/sftp/:hostId/rename', pre, async (req) => {
    const body = parse(z.object({ from: PathStr, to: PathStr }), req.body);
    return withSftp(req, async (sftp, host) => {
      const exists = await p.lstat(sftp, body.to).then(
        () => true,
        () => false,
      );
      if (exists) throw conflict('Destination already exists', 'EXISTS');
      await p.rename(sftp, body.from, body.to);
      audit.write({ ...actor(req), action: 'sftp.rename', target: `${host.name}:${body.from}`, details: { to: body.to } });
      return { ok: true };
    });
  });

  app.post('/api/sftp/:hostId/chmod', pre, async (req) => {
    const body = parse(z.object({ path: PathStr, mode: z.string().regex(/^[0-7]{3,4}$/) }), req.body);
    return withSftp(req, async (sftp, host) => {
      await p.chmod(sftp, body.path, Number.parseInt(body.mode, 8));
      audit.write({ ...actor(req), action: 'sftp.chmod', target: `${host.name}:${body.path}`, details: { mode: body.mode } });
      return { ok: true };
    });
  });

  app.post('/api/sftp/:hostId/delete', pre, async (req) => {
    const body = parse(z.object({ paths: z.array(PathStr).min(1).max(500), recursive: z.boolean().default(false) }), req.body);
    for (const target of body.paths) {
      const norm = path.normalize(target);
      if (norm === '/' || norm === '.' || norm === '..') throw badRequest('Refusing to delete that path');
    }
    return withSftp(req, async (sftp, host) => {
      let count = 0;
      const removeTree = async (target: string, depth: number): Promise<void> => {
        if (depth > 64) throw badRequest('Directory tree too deep');
        const st = await p.lstat(sftp, target);
        if (typeOf(st.mode) === 'dir') {
          if (!body.recursive) {
            await p.rmdir(sftp, target);
          } else {
            for (const f of await p.readdir(sftp, target)) await removeTree(path.join(target, f.filename), depth + 1);
            await p.rmdir(sftp, target);
          }
        } else {
          await p.unlink(sftp, target);
        }
        count++;
        if (count > 100_000) throw badRequest('Too many files');
      };
      for (const target of body.paths) await removeTree(target, 0);
      audit.write({ ...actor(req), action: 'sftp.delete', target: `${host.name}:${body.paths.join(', ').slice(0, 500)}`, details: { recursive: body.recursive, count } });
      return { ok: true, count };
    });
  });
}
