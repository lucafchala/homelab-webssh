import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { Guards } from '../auth/guards.js';
import { Hosts } from '../db/models.js';
import { AiMessageSchema, type AiEvent } from '../ai/types.js';
import { RUN_COMMAND_TOOL, RunCommandInput, streamChat } from '../ai/providers.js';
import { buildSystemPrompt, wrapTerminalContext } from '../ai/prompts.js';
import { classifyCommand } from '../ai/safety.js';
import { hostOsCache } from '../ssh/stats.js';
import { actor, badRequest, notFound, parse } from '../util/http.js';

const ChatRequest = z.object({
  mode: z.enum(['chat', 'agent', 'generate']).default('chat'),
  hostId: z.string().max(64).nullable().optional(),
  messages: z.array(AiMessageSchema).min(1).max(200),
  terminalContext: z.string().max(60_000).optional(),
});

export function registerAiRoutes(app: FastifyInstance, ctx: AppContext, guards: Guards) {
  app.post('/api/ai/classify', { preHandler: guards.user }, async (req) => {
    const { command } = parse(z.object({ command: z.string().max(10_000) }), req.body);
    return classifyCommand(command);
  });

  /**
   * Streams one assistant turn as Server-Sent Events. The browser owns the
   * conversation and the agent loop: when the model proposes run_command, the
   * user approves it, the browser executes it via /api/hosts/:id/exec and sends
   * the result back as a `tool` message in the next /api/ai/chat call.
   */
  app.post('/api/ai/chat', { preHandler: guards.user, config: { rateLimit: { max: 40, timeWindow: '1 minute' } }, bodyLimit: 2 * 1024 * 1024 }, async (req, reply) => {
    const body = parse(ChatRequest, req.body);
    const ai = ctx.settings.ai();
    if (!ai || (ai.provider !== 'ollama' && ai.provider !== 'openai' && !ai.apiKey)) throw badRequest('The AI assistant is not configured (Admin → Settings → AI)');
    const totalChars = body.messages.reduce((n, m) => n + m.content.length, 0);
    if (totalChars > 400_000) throw badRequest('Conversation too long — start a new one');

    let host = null;
    if (body.hostId) {
      host = Hosts.accessible(ctx.db, req.auth!.user.id, body.hostId);
      if (!host) throw notFound('Host not found');
    }
    if (body.mode === 'agent' && !host) throw badRequest('Agent mode needs a host — open a terminal first');

    const messages = [...body.messages];
    const lastUser = messages.map((m, i) => [m, i] as const).reverse().find(([m]) => m.role === 'user');
    if (body.terminalContext && lastUser) {
      const [m, i] = lastUser;
      messages[i] = { role: 'user', content: (m as { content: string }).content + wrapTerminalContext(body.terminalContext) };
    }

    const system = buildSystemPrompt(
      body.mode,
      host ? { name: host.name, username: host.username, hostname: host.hostname, os: hostOsCache.get(host.id) ?? null, sudo: !!host.use_sudo } : null,
    );

    const controller = new AbortController();
    req.raw.on('close', () => controller.abort());
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
      connection: 'keep-alive',
    });
    const send = (e: AiEvent | Record<string, unknown>) => {
      if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
    };
    const keepAlive = setInterval(() => reply.raw.write(': keep-alive\n\n'), 15_000);

    ctx.audit.write({ ...actor(req), action: `ai.${body.mode}`, target: host?.name ?? null, details: { provider: ai.provider, model: ai.model, messages: body.messages.length } });

    try {
      await streamChat(
        { provider: ai.provider, model: ai.model, baseUrl: ai.baseUrl, apiKey: ai.apiKey, maxTokens: ai.maxTokens },
        {
          system,
          messages,
          tools: body.mode === 'agent' ? [RUN_COMMAND_TOOL] : [],
          signal: controller.signal,
          onEvent: (e) => {
            if (e.type === 'done') {
              // Validate proposed commands and attach a risk classification for the approval UI.
              const calls = (e.message.toolCalls ?? []).map((c) => {
                const parsed = c.name === RUN_COMMAND_TOOL.name ? RunCommandInput.safeParse(c.input) : null;
                if (!parsed?.success) return { ...c, valid: false, error: `Invalid input for ${c.name}: ${JSON.stringify(c.input).slice(0, 500)}` };
                return { ...c, valid: true, risk: classifyCommand(parsed.data.command) };
              });
              send({ ...e, toolCalls: calls, autoApproveReadOnly: ai.autoApproveReadOnly });
            } else {
              send(e);
            }
          },
        },
      );
    } catch (err) {
      if (!controller.signal.aborted) {
        req.log.warn({ err: (err as Error).message }, 'ai request failed');
        send({ type: 'error', message: (err as Error).message || 'AI request failed' });
      }
    } finally {
      clearInterval(keepAlive);
      reply.raw.end();
    }
  });
}
