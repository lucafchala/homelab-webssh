import fs from 'node:fs';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { Guards } from '../auth/guards.js';
import { publicSnippet, Snippets } from '../db/models.js';
import { actor, forbidden, notFound, parse } from '../util/http.js';

const SnippetInput = z.object({
  name: z.string().trim().min(1).max(100),
  command: z.string().min(1).max(20_000),
  description: z.string().max(2000).default(''),
  tags: z.array(z.string().trim().min(1).max(32)).max(20).default([]),
  shared: z.boolean().default(false),
});

export function registerSnippetRoutes(app: FastifyInstance, ctx: AppContext, guards: Guards) {
  const { db, audit } = ctx;
  const pre = { preHandler: guards.user };

  app.get('/api/snippets', pre, async (req) => Snippets.visibleTo(db, req.auth!.user.id).map((s) => publicSnippet(s, req.auth!.user.id)));

  app.post('/api/snippets', pre, async (req) => {
    const b = parse(SnippetInput, req.body);
    const s = Snippets.create(db, {
      owner_id: req.auth!.user.id,
      name: b.name,
      command: b.command,
      description: b.description,
      tags: JSON.stringify(b.tags),
      shared: b.shared && req.auth!.user.role === 'admin' ? 1 : 0,
    });
    audit.write({ ...actor(req), action: 'snippet.create', target: b.name });
    return publicSnippet(s, req.auth!.user.id);
  });

  app.put('/api/snippets/:id', pre, async (req) => {
    const { id } = req.params as { id: string };
    const existing = Snippets.owned(db, req.auth!.user.id, id);
    if (!existing) throw notFound();
    const b = parse(SnippetInput, req.body);
    const s = Snippets.update(db, id, {
      name: b.name,
      command: b.command,
      description: b.description,
      tags: JSON.stringify(b.tags),
      shared: b.shared && req.auth!.user.role === 'admin' ? 1 : 0,
    });
    return publicSnippet(s, req.auth!.user.id);
  });

  app.delete('/api/snippets/:id', pre, async (req) => {
    const { id } = req.params as { id: string };
    if (!Snippets.delete(db, req.auth!.user.id, id)) throw notFound();
    audit.write({ ...actor(req), action: 'snippet.delete', target: id });
    return { ok: true };
  });

  // ------------------------------------------------------------------ session recordings
  app.get('/api/recordings', pre, async (req) => {
    const all = (req.query as { all?: string }).all === '1' && req.auth!.user.role === 'admin';
    return ctx.recorder.list(all ? null : req.auth!.user.id);
  });

  app.get('/api/recordings/:id', pre, async (req, reply) => {
    const { id } = req.params as { id: string };
    const r = ctx.recorder.get(id);
    if (!r) throw notFound();
    if (r.user_id !== req.auth!.user.id && req.auth!.user.role !== 'admin') throw forbidden();
    const file = ctx.recorder.file(id);
    if (!fs.existsSync(file)) throw notFound('Recording file missing');
    reply.header('content-type', 'application/x-asciicast');
    reply.header('content-disposition', `attachment; filename="session-${id}.cast"`);
    return reply.send(fs.createReadStream(file));
  });

  app.delete('/api/recordings/:id', pre, async (req) => {
    const { id } = req.params as { id: string };
    const r = ctx.recorder.get(id);
    if (!r) throw notFound();
    if (r.user_id !== req.auth!.user.id && req.auth!.user.role !== 'admin') throw forbidden();
    if (!r.ended_at) throw forbidden('Recording is still in progress');
    ctx.recorder.delete(id);
    audit.write({ ...actor(req), action: 'recording.delete', target: id });
    return { ok: true };
  });
}
