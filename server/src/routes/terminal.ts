import type { FastifyInstance } from 'fastify';
import type { WebSocket, RawData } from 'ws';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import type { Guards } from '../auth/guards.js';
import type { AuthPrompt, HostKeyInfo, Interaction } from '../ssh/manager.js';
import { SshError } from '../ssh/manager.js';
import type { TerminalClient, TerminalSession } from '../ssh/terminals.js';
import { newId } from '../security/crypto.js';
import { actor, notFound } from '../util/http.js';

const Control = z.discriminatedUnion('type', [
  z.object({ type: z.literal('open'), hostId: z.string().min(1).max(64), cols: z.number().int(), rows: z.number().int() }),
  z.object({ type: z.literal('attach'), sessionId: z.string().min(1).max(64), cols: z.number().int().optional(), rows: z.number().int().optional() }),
  z.object({ type: z.literal('resize'), cols: z.number().int(), rows: z.number().int() }),
  z.object({ type: z.literal('input'), data: z.string().max(65536) }),
  z.object({ type: z.literal('answer'), requestId: z.string(), accept: z.boolean().optional(), responses: z.array(z.string().max(4096)).max(20).nullable().optional() }),
  z.object({ type: z.literal('close') }),
  z.object({ type: z.literal('ping') }),
]);

/**
 * Terminal WebSocket protocol
 *   client → server: JSON text frames (Control) and binary frames (raw keystrokes)
 *   server → client: JSON text frames (status/prompts/events) and binary frames (raw terminal output)
 */
export function registerTerminalRoutes(app: FastifyInstance, ctx: AppContext, guards: Guards) {
  app.get('/api/terminals', { preHandler: guards.user }, async (req) => ctx.terminals.listForUser(req.auth!.user.id));

  app.delete('/api/terminals/:id', { preHandler: guards.user }, async (req) => {
    const { id } = req.params as { id: string };
    const s = ctx.terminals.get(id);
    if (!s || s.userId !== req.auth!.user.id) throw notFound();
    s.close('Closed by user');
    ctx.audit.write({ ...actor(req), action: 'terminal.kill', target: s.host.name });
    return { ok: true };
  });

  app.get('/api/terminal/ws', { websocket: true, preHandler: guards.user }, (socket: WebSocket, req) => {
    const user = req.auth!.user;
    const sessionToken = req.auth!.session.id;
    let session: TerminalSession | null = null;
    const pending = new Map<string, (v: { accept?: boolean; responses?: string[] | null }) => void>();
    let alive = true;

    const client: TerminalClient = {
      id: newId(),
      sendJson: (msg) => {
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
      },
      sendData: (data) => {
        if (socket.readyState === socket.OPEN) socket.send(data, { binary: true });
      },
      bufferedAmount: () => socket.bufferedAmount,
      close: (code, reason) => {
        if (socket.readyState === socket.OPEN) socket.close(code ?? 1000, reason);
      },
    };

    const ask = <T>(msg: Record<string, unknown>, map: (v: { accept?: boolean; responses?: string[] | null }) => T, onClose: T): Promise<T> =>
      new Promise((resolve) => {
        if (!alive) return resolve(onClose);
        const requestId = newId();
        pending.set(requestId, (v) => resolve(map(v)));
        client.sendJson({ ...msg, requestId });
      });

    const interaction: Interaction = {
      confirmHostKey: (info: HostKeyInfo) => ask({ type: 'hostkey', ...info }, (v) => !!v.accept, false),
      prompt: (p: AuthPrompt) => ask({ type: 'prompt', ...p }, (v) => (v.responses ? v.responses : null), null),
      status: (message: string) => client.sendJson({ type: 'status', state: 'connecting', message }),
    };

    // Kill the socket if the login session that opened it is revoked or expired (logout, password
    // change, admin action); terminal activity counts as session activity for the idle timeout.
    let lastInputAt = 0;
    const sessionCheck = setInterval(() => {
      if (!ctx.sessions.check(sessionToken, Date.now() - lastInputAt < 60_000)) socket.close(4001, 'Signed out');
    }, 30_000);

    const heartbeat = setInterval(() => {
      if (socket.readyState === socket.OPEN) socket.ping();
    }, 25_000);

    socket.on('message', (raw: RawData, isBinary: boolean) => {
      if (isBinary) {
        lastInputAt = Date.now();
        session?.input(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer));
        return;
      }
      let msg: z.infer<typeof Control>;
      try {
        msg = Control.parse(JSON.parse(raw.toString()));
      } catch {
        client.sendJson({ type: 'error', code: 'BAD_MESSAGE', message: 'Malformed control message' });
        return;
      }
      switch (msg.type) {
        case 'open': {
          if (session) return;
          try {
            session = ctx.terminals.create(user, msg.hostId, msg.cols, msg.rows);
          } catch (err) {
            const e = err as SshError;
            client.sendJson({ type: 'error', code: e.code ?? 'CONNECT_FAILED', message: e.message });
            client.close(1000);
            return;
          }
          session.attachCreator(client);
          client.sendJson({ type: 'created', sessionId: session.id, hostId: session.host.id, hostName: session.host.name });
          void session.start(interaction);
          break;
        }
        case 'attach': {
          if (session) return;
          const s = ctx.terminals.get(msg.sessionId);
          if (!s || s.userId !== user.id || s.status === 'closed') {
            client.sendJson({ type: 'error', code: 'NOT_FOUND', message: 'That session has ended' });
            client.close(1000);
            return;
          }
          session = s;
          s.attach(client, msg.cols, msg.rows);
          break;
        }
        case 'resize':
          session?.resize(msg.cols, msg.rows);
          break;
        case 'input':
          lastInputAt = Date.now();
          session?.input(msg.data);
          break;
        case 'answer': {
          const r = pending.get(msg.requestId);
          if (r) {
            pending.delete(msg.requestId);
            r({ accept: msg.accept, responses: msg.responses ?? null });
          }
          break;
        }
        case 'close':
          session?.close('Closed by user');
          break;
        case 'ping':
          client.sendJson({ type: 'pong', t: Date.now() });
          break;
      }
    });

    socket.on('close', () => {
      alive = false;
      clearInterval(heartbeat);
      clearInterval(sessionCheck);
      for (const r of pending.values()) r({ accept: false, responses: null });
      pending.clear();
      session?.detach(client);
    });
    socket.on('error', () => socket.terminate());
  });
}
