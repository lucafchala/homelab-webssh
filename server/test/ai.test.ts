import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../src/config.js';
import { buildApp } from '../src/app.js';
import type { AppContext } from '../src/context.js';
import { freePort } from './helpers/sshd.js';
import { Client } from './helpers/client.js';

/** Fake LLM endpoints speaking the Anthropic Messages SSE and OpenAI chat-completions SSE formats. */
function startMockLlm() {
  const requests: { path: string; headers: http.IncomingHttpHeaders; body: any }[] = [];
  const server = http.createServer((req, res) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      const body = data ? JSON.parse(data) : null;
      requests.push({ path: req.url ?? '', headers: req.headers, body });
      const sse = (events: [string | null, unknown][]) => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (const [name, payload] of events) res.write(`${name ? `event: ${name}\n` : ''}data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`);
        res.end();
      };
      if (req.url?.startsWith('/v1/messages')) {
        const hasToolResult = JSON.stringify(body.messages).includes('tool_result');
        const msg = { id: 'msg_1', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } };
        if (!hasToolResult) {
          return sse([
            ['message_start', { type: 'message_start', message: msg }],
            ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } }],
            ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'User wants disk usage.' } }],
            ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig123' } }],
            ['content_block_stop', { type: 'content_block_stop', index: 0 }],
            ['content_block_start', { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }],
            ['content_block_delta', { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Let me check.' } }],
            ['content_block_stop', { type: 'content_block_stop', index: 1 }],
            ['content_block_start', { type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 'toolu_1', name: 'run_command', input: {} } }],
            ['content_block_delta', { type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"command": "df -h", "explanation": "Show disk usage"}' } }],
            ['content_block_stop', { type: 'content_block_stop', index: 2 }],
            ['message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 30 } }],
            ['message_stop', { type: 'message_stop' }],
          ]);
        }
        return sse([
          ['message_start', { type: 'message_start', message: msg }],
          ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
          ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Root is 40% full.' } }],
          ['content_block_stop', { type: 'content_block_stop', index: 0 }],
          ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }],
          ['message_stop', { type: 'message_stop' }],
        ]);
      }
      if (req.url?.endsWith('/chat/completions')) {
        const chunk = (delta: unknown, finish: string | null = null) => ({ id: 'c1', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: finish }] });
        if (!body.stream) {
          res.writeHead(200, { 'content-type': 'application/json' });
          return res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }] }));
        }
        if (body.tools) {
          return sse([
            [null, chunk({ role: 'assistant', content: 'Restarting it.' })],
            [null, chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'run_command', arguments: '{"command": "sudo systemctl ' } }] })],
            [null, chunk({ tool_calls: [{ index: 0, function: { arguments: 'reboot", "explanation": "reboot"}' } }] })],
            [null, chunk({}, 'tool_calls')],
            [null, '[DONE]'],
          ]);
        }
        return sse([[null, chunk({ content: 'Use ' })], [null, chunk({ content: '`df -h`.' })], [null, chunk({}, 'stop')], [null, '[DONE]']]);
      }
      res.writeHead(404).end();
    });
  });
  return { server, requests };
}

describe('AI assistant (mock providers)', () => {
  let app: FastifyInstance;
  let ctx: AppContext;
  let base = '';
  let dataDir = '';
  let client: Client;
  let hostId = '';
  const mock = startMockLlm();
  let mockUrl = '';

  beforeAll(async () => {
    const mockPort = await freePort();
    await new Promise<void>((r) => mock.server.listen(mockPort, '127.0.0.1', () => r()));
    mockUrl = `http://127.0.0.1:${mockPort}`;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'webssh-ai-'));
    const port = await freePort();
    base = `http://127.0.0.1:${port}`;
    const config = loadConfig({ NODE_ENV: 'test', DATA_DIR: dataDir, PUBLIC_URL: base, SETUP_TOKEN: 'tok', LOG_LEVEL: 'warn', REQUIRE_2FA: 'false', TLDR_ENABLED: 'false' });
    ({ app, ctx } = await buildApp(config, { logger: false, webDist: '/nonexistent' }));
    await app.listen({ host: '127.0.0.1', port });
    client = new Client(base);
    await client.post('/api/auth/setup', { token: 'tok', username: 'admin', password: 'Correct-Horse-Battery-9' });
    await client.refreshCsrf();
    const h = await client.post('/api/hosts', { name: 'nas', hostname: '127.0.0.1', port: 22, username: 'root', authType: 'ask' });
    hostId = h.json.id;
  });

  afterAll(async () => {
    await app?.close();
    ctx?.db.close();
    mock.server.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  async function chat(body: unknown) {
    const res = await fetch(base + '/api/ai/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: base, cookie: client.cookieHeader(), 'x-csrf-token': client.csrf },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return {
      status: res.status,
      events: text
        .split('\n\n')
        .filter((b) => b.startsWith('data:'))
        .map((b) => JSON.parse(b.slice(5))),
    };
  }

  it('is disabled until configured', async () => {
    const r = await chat({ mode: 'chat', messages: [{ role: 'user', content: 'hi' }] });
    expect(r.status).toBe(400);
  });

  it('Anthropic: streams thinking + text, proposes a classified tool call, and round-trips raw content', async () => {
    const save = await client.put('/api/admin/settings', { ai: { provider: 'anthropic', model: 'claude-opus-5-5', baseUrl: mockUrl, apiKey: 'sk-ant-test' } });
    expect(save.json.ai.apiKeySet).toBe(true);
    expect(JSON.stringify(save.json)).not.toContain('sk-ant-test');

    const r1 = await chat({ mode: 'agent', hostId, messages: [{ role: 'user', content: 'how full is my disk?' }], terminalContext: '\x1b[32muser@nas\x1b[0m:~$ ' });
    expect(r1.status).toBe(200);
    expect(r1.events.filter((e) => e.type === 'thinking').map((e) => e.delta).join('')).toBe('User wants disk usage.');
    expect(r1.events.filter((e) => e.type === 'text').map((e) => e.delta).join('')).toBe('Let me check.');
    const done = r1.events.find((e) => e.type === 'done');
    expect(done.stopReason).toBe('tool_use');
    expect(done.toolCalls[0]).toMatchObject({ id: 'toolu_1', name: 'run_command', valid: true, risk: { risk: 'read' } });
    expect(done.message.raw.provider).toBe('anthropic');

    const req = mock.requests.at(-1)!;
    expect(req.headers['x-api-key']).toBe('sk-ant-test');
    expect(req.body.model).toBe('claude-opus-5-5');
    expect(req.body.thinking).toEqual({ type: 'adaptive', display: 'summarized' });
    expect(req.body.tools[0]).toMatchObject({ name: 'run_command', eager_input_streaming: true });
    expect(req.body.cache_control).toEqual({ type: 'ephemeral' });
    // Fallbacks are only requested from the official API endpoint, not custom base URLs.
    expect(req.body.fallbacks).toBeUndefined();
    expect(req.body.system).toContain('Agent mode');
    expect(req.body.system).toContain('"nas"');
    const lastUser = JSON.stringify(req.body.messages.at(-1));
    expect(lastUser).toContain('<terminal>');
    expect(lastUser).not.toContain('\\u001b');

    // Second turn: tool result goes back; the raw assistant blocks (incl. thinking signature) are echoed unchanged.
    const r2 = await chat({
      mode: 'agent',
      hostId,
      messages: [
        { role: 'user', content: 'how full is my disk?' },
        done.message,
        { role: 'tool', toolCallId: 'toolu_1', content: 'exit code: 0\n/dev/sda1 40% /' },
      ],
    });
    expect(r2.events.find((e) => e.type === 'done').message.content).toBe('Root is 40% full.');
    const req2 = mock.requests.at(-1)!;
    const assistant = req2.body.messages[1];
    expect(assistant.role).toBe('assistant');
    expect(assistant.content[0]).toMatchObject({ type: 'thinking', signature: 'sig123' });
    expect(req2.body.messages[2].content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'toolu_1' });
  });

  it('OpenAI-compatible (Ollama/LM Studio/…): streams text and flags dangerous tool calls', async () => {
    await client.put('/api/admin/settings', { ai: { provider: 'openai', model: 'qwen2.5-coder:7b', baseUrl: mockUrl + '/v1', apiKey: '' } });
    const r = await chat({ mode: 'chat', messages: [{ role: 'user', content: 'disk usage?' }] });
    expect(r.events.filter((e) => e.type === 'text').map((e) => e.delta).join('')).toBe('Use `df -h`.');

    const a = await chat({ mode: 'agent', hostId, messages: [{ role: 'user', content: 'reboot it' }] });
    const done = a.events.find((e) => e.type === 'done');
    expect(done.toolCalls[0]).toMatchObject({ name: 'run_command', valid: true, risk: { risk: 'dangerous' } });
    expect(mock.requests.at(-1)!.body.tools[0].function.name).toBe('run_command');

    // The exec endpoint refuses the dangerous command without explicit confirmation.
    const exec = await client.post(`/api/hosts/${hostId}/exec`, { command: 'sudo systemctl reboot', source: 'ai' });
    expect(exec.status).toBe(428);
  });

  it('admin test endpoint reports provider health', async () => {
    const t = await client.post('/api/admin/settings/ai-test');
    expect(t.json).toMatchObject({ ok: true, reply: 'OK' });
  });

  it('agent mode requires a host', async () => {
    const r = await chat({ mode: 'agent', messages: [{ role: 'user', content: 'x' }] });
    expect(r.status).toBe(400);
  });
});
