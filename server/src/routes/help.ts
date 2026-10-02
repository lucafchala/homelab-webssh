import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { Guards } from '../auth/guards.js';
import { Hosts } from '../db/models.js';
import { CATEGORIES, COMMANDS } from '../help/commands.js';
import { getRecipe, RECIPES } from '../help/recipes.js';
import { KEY_SHEETS } from '../help/keys.js';
import { resolveHelp } from '../help/search.js';
import { fetchTldr } from '../help/tldr.js';
import { SshError, shq } from '../ssh/manager.js';
import { badRequest, HttpError, notFound, parse } from '../util/http.js';

const NAME = /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,63}$/;

export function registerHelpRoutes(app: FastifyInstance, ctx: AppContext, guards: Guards) {
  const pre = { preHandler: guards.user };

  /** Smart local-first lookup: commands, recipes and key sheets; says whether AI is worth it. */
  app.get('/api/help/search', pre, async (req) => {
    const { q } = parse(z.object({ q: z.string().max(500).default('') }), req.query);
    return resolveHelp(q);
  });

  app.get('/api/help/index', pre, async () => ({
    categories: CATEGORIES,
    commands: COMMANDS.map((c) => ({ name: c.name, category: c.category, summary: c.summary })),
    recipes: RECIPES.map((r) => ({ id: r.id, title: r.title, category: r.category })),
    keySheets: KEY_SHEETS.map((k) => ({ id: k.id, title: k.title })),
  }));

  app.get('/api/help/commands/:name', pre, async (req) => {
    const { name } = req.params as { name: string };
    const cmd = COMMANDS.find((c) => c.name === decodeURIComponent(name));
    if (!cmd) throw notFound('No offline page for that command');
    return cmd;
  });

  app.get('/api/help/recipes/:id', pre, async (req) => {
    const r = getRecipe((req.params as { id: string }).id);
    if (!r) throw notFound();
    return r;
  });

  app.get('/api/help/keys/:id', pre, async (req) => {
    const k = KEY_SHEETS.find((s) => s.id === (req.params as { id: string }).id);
    if (!k) throw notFound();
    return k;
  });

  app.get('/api/help/tldr/:name', pre, async (req) => {
    if (!ctx.config.tldr.enabled) throw notFound('tldr lookups are disabled');
    const { name } = req.params as { name: string };
    if (!NAME.test(name)) throw badRequest('Invalid command name');
    const page = await fetchTldr(ctx.config.tldr.baseUrl, name);
    if (!page) throw notFound(`No tldr page for "${name}"`);
    return page;
  });

  /** Read the man page (or --help output) for a command on the user's own host. */
  app.get('/api/help/man/:hostId/:name', pre, async (req) => {
    const { hostId, name } = req.params as { hostId: string; name: string };
    const { mode } = parse(z.object({ mode: z.enum(['man', 'help']).default('man') }), req.query);
    if (!NAME.test(name)) throw badRequest('Invalid command name');
    const host = Hosts.accessible(ctx.db, req.auth!.user.id, hostId);
    if (!host) throw notFound('Host not found');
    const n = shq(name);
    const cmd =
      mode === 'man'
        ? `export MANWIDTH=100 MANPAGER=cat PAGER=cat LC_ALL=C.UTF-8; (man -- ${n} 2>/dev/null | col -bx) || (type ${n} >/dev/null 2>&1 && help ${n} 2>/dev/null)`
        : `export LC_ALL=C.UTF-8; command -v -- ${n} >/dev/null 2>&1 && timeout 5 ${n} --help 2>&1 < /dev/null | head -400`;
    try {
      const r = await ctx.ssh.run(req.auth!.user.id, host.id, cmd, { timeoutMs: 15_000, maxBytes: 400_000 });
      const text = r.stdout.trim();
      if (!text) throw notFound(mode === 'man' ? `No manual entry for ${name} on ${host.name}` : `${name} is not installed on ${host.name}`);
      return { name, host: host.name, mode, text, truncated: r.truncated };
    } catch (err) {
      if (err instanceof HttpError) throw err;
      if (err instanceof SshError) throw new HttpError(err.code === 'NOT_FOUND' ? 404 : 409, err.message, err.code);
      throw err;
    }
  });
}
