import type { AiAssistantMessage, AiConfig, AiMessage, AiToolCall, StreamRequest } from './types.js';

/**
 * Minimal client for OpenAI-compatible chat completions with streaming + tools.
 * Works with Ollama (http://host:11434/v1), LM Studio, vLLM, LocalAI, OpenRouter and OpenAI.
 */
type OaiMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export function toOpenAiMessages(system: string, messages: AiMessage[]): OaiMessage[] {
  const out: OaiMessage[] = [{ role: 'system', content: system }];
  for (const m of messages) {
    if (m.role === 'user') out.push({ role: 'user', content: m.content });
    else if (m.role === 'tool') out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
    else
      out.push({
        role: 'assistant',
        content: m.content || null,
        tool_calls: m.toolCalls?.length
          ? m.toolCalls.map((c) => ({ id: c.id, type: 'function' as const, function: { name: c.name, arguments: JSON.stringify(c.input) } }))
          : undefined,
      });
  }
  return out;
}

function headers(cfg: AiConfig): Record<string, string> {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (cfg.apiKey) h.authorization = `Bearer ${cfg.apiKey}`;
  return h;
}

async function* sseLines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (line.startsWith('data:')) yield line.slice(5).trim();
    }
  }
  if (buf.trim().startsWith('data:')) yield buf.trim().slice(5).trim();
}

export async function streamOpenAi(cfg: AiConfig, req: StreamRequest): Promise<AiAssistantMessage> {
  const body = {
    model: cfg.model,
    stream: true,
    max_tokens: cfg.maxTokens,
    messages: toOpenAiMessages(req.system, req.messages),
    ...(req.tools.length
      ? { tools: req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.jsonSchema } })) }
      : {}),
  };
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, { method: 'POST', headers: headers(cfg), body: JSON.stringify(body), signal: req.signal });
  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '');
    throw new Error(`AI endpoint returned ${res.status}: ${text.slice(0, 300)}`);
  }
  let content = '';
  let finish = 'stop';
  const partial = new Map<number, { id: string; name: string; args: string }>();
  let usage: { inputTokens?: number; outputTokens?: number } | undefined;
  for await (const data of sseLines(res.body)) {
    if (data === '[DONE]') break;
    let chunk: {
      choices?: { delta?: { content?: string; reasoning_content?: string; reasoning?: string; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[];
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      error?: { message?: string };
    };
    try {
      chunk = JSON.parse(data);
    } catch {
      continue;
    }
    if (chunk.error) throw new Error(chunk.error.message ?? 'AI endpoint error');
    if (chunk.usage) usage = { inputTokens: chunk.usage.prompt_tokens, outputTokens: chunk.usage.completion_tokens };
    const choice = chunk.choices?.[0];
    if (!choice) continue;
    const d = choice.delta ?? {};
    const reasoning = d.reasoning_content ?? d.reasoning;
    if (reasoning) req.onEvent({ type: 'thinking', delta: reasoning });
    if (d.content) {
      content += d.content;
      req.onEvent({ type: 'text', delta: d.content });
    }
    for (const tc of d.tool_calls ?? []) {
      const i = tc.index ?? partial.size;
      const cur = partial.get(i) ?? { id: '', name: '', args: '' };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      if (tc.function?.arguments) cur.args += tc.function.arguments;
      partial.set(i, cur);
    }
    if (choice.finish_reason) finish = choice.finish_reason;
  }
  const toolCalls: AiToolCall[] = [];
  for (const [i, p] of [...partial.entries()].sort((a, b) => a[0] - b[0])) {
    let input: Record<string, unknown> = {};
    try {
      input = p.args ? JSON.parse(p.args) : {};
    } catch {
      input = { __invalid_json: p.args };
    }
    toolCalls.push({ id: p.id || `call_${Date.now()}_${i}`, name: p.name, input });
  }
  if (finish === 'length' && toolCalls.length) throw new Error('The response was cut off (max tokens) while proposing a command.');
  const message: AiAssistantMessage = { role: 'assistant', content, toolCalls: toolCalls.length ? toolCalls : undefined };
  req.onEvent({ type: 'done', stopReason: toolCalls.length ? 'tool_use' : finish, message, usage });
  return message;
}

export async function testOpenAi(cfg: AiConfig): Promise<string> {
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: headers(cfg),
    body: JSON.stringify({ model: cfg.model, max_tokens: 200, messages: [{ role: 'user', content: 'Reply with exactly: OK' }] }),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
  const j = JSON.parse(text) as { choices?: { message?: { content?: string } }[] };
  return j.choices?.[0]?.message?.content?.trim() ?? '';
}
