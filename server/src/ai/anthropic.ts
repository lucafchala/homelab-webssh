import Anthropic from '@anthropic-ai/sdk';
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessageParam,
  BetaMessageStreamParams,
  BetaTool,
  BetaToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages';
import type { AiAssistantMessage, AiConfig, AiMessage, AiToolCall, StreamRequest } from './types.js';

/** Models that run adaptive thinking (Claude 4.6 and later). Older ones get no thinking config. */
function supportsAdaptiveThinking(model: string): boolean {
  return /^claude-(opus|sonnet)-4-[6-9]|^claude-(opus|sonnet|fable|mythos)-[5-9]/.test(model);
}

/** Models that accept server-side refusal fallbacks (`fallbacks: "default"`). */
function supportsDefaultFallback(model: string): boolean {
  return /^claude-(opus-5(-5)?|sonnet-5-5|fable-5-1)$/.test(model);
}

function isOfficialEndpoint(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname === 'api.anthropic.com';
  } catch {
    return false;
  }
}

export function toAnthropicMessages(messages: AiMessage[]): BetaMessageParam[] {
  const out: BetaMessageParam[] = [];
  const pushUserBlocks = (blocks: BetaContentBlockParam[]) => {
    const last = out[out.length - 1];
    if (last?.role === 'user' && Array.isArray(last.content)) {
      // tool_result blocks must come first in a user turn; text goes after them.
      (last.content as BetaContentBlockParam[]).push(...blocks);
    } else {
      out.push({ role: 'user', content: blocks });
    }
  };
  for (const m of messages) {
    if (m.role === 'user') {
      pushUserBlocks([{ type: 'text', text: m.content || '(empty)' }]);
    } else if (m.role === 'tool') {
      const block: BetaToolResultBlockParam = { type: 'tool_result', tool_use_id: m.toolCallId, content: m.content, is_error: m.isError || undefined };
      pushUserBlocks([block]);
    } else if (m.raw?.provider === 'anthropic' && Array.isArray(m.raw.content)) {
      // Echo the original blocks unchanged (thinking blocks, signatures, fallback blocks …).
      out.push({ role: 'assistant', content: m.raw.content as BetaContentBlockParam[] });
    } else {
      const blocks: BetaContentBlockParam[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const c of m.toolCalls ?? []) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.input });
      out.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: '(no content)' }] });
    }
  }
  return out;
}

export async function streamAnthropic(cfg: AiConfig, req: StreamRequest): Promise<AiAssistantMessage> {
  const client = new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl, maxRetries: 2 });
  const tools: BetaTool[] = req.tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.jsonSchema as BetaTool.InputSchema,
    // Stream tool input as generated; we validate it ourselves before anything runs.
    eager_input_streaming: true,
  }));

  const params: BetaMessageStreamParams = {
    model: cfg.model,
    max_tokens: cfg.maxTokens,
    system: req.system,
    messages: toAnthropicMessages(req.messages),
    cache_control: { type: 'ephemeral' },
    ...(tools.length ? { tools } : {}),
    ...(supportsAdaptiveThinking(cfg.model) ? { thinking: { type: 'adaptive', display: 'summarized' } } : {}),
    // Server-side fallback: if a safety classifier declines, the API retries on Anthropic's recommended model.
    ...(supportsDefaultFallback(cfg.model) && isOfficialEndpoint(cfg.baseUrl) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' } : {}),
  };

  const stream = client.beta.messages.stream(params, { signal: req.signal });

  let message;
  try {
    for await (const event of stream) {
      if (event.type === 'content_block_delta') {
        if (event.delta.type === 'text_delta') req.onEvent({ type: 'text', delta: event.delta.text });
        else if (event.delta.type === 'thinking_delta') req.onEvent({ type: 'thinking', delta: event.delta.thinking });
      }
    }
    message = await stream.finalMessage();
  } catch (err) {
    if (err instanceof Anthropic.AuthenticationError) throw new Error('Anthropic rejected the API key (401) — check AI settings');
    if (err instanceof Anthropic.RateLimitError) throw new Error('Anthropic rate limit reached — try again shortly');
    if (err instanceof Anthropic.NotFoundError) throw new Error(`Model "${cfg.model}" not found — check AI settings`);
    if (err instanceof Anthropic.APIError) throw new Error(`Anthropic API error ${err.status ?? ''}: ${err.message}`);
    throw err;
  }

  if (message.stop_reason === 'refusal') {
    throw new Error('The model declined this request.');
  }
  const toolCalls: AiToolCall[] = [];
  let text = '';
  for (const block of message.content as BetaContentBlock[]) {
    if (block.type === 'text') text += block.text;
    else if (block.type === 'tool_use') toolCalls.push({ id: block.id, name: block.name, input: (block.input ?? {}) as Record<string, unknown> });
  }
  if (message.stop_reason === 'max_tokens' && toolCalls.length) {
    throw new Error('The response was cut off (max tokens) while proposing a command — raise "Max tokens" in AI settings.');
  }
  const out: AiAssistantMessage = {
    role: 'assistant',
    content: text,
    toolCalls: toolCalls.length ? toolCalls : undefined,
    raw: { provider: 'anthropic', model: message.model, content: message.content },
  };
  req.onEvent({
    type: 'done',
    stopReason: message.stop_reason ?? 'end_turn',
    message: out,
    usage: { inputTokens: message.usage?.input_tokens, outputTokens: message.usage?.output_tokens },
  });
  return out;
}

export async function testAnthropic(cfg: AiConfig): Promise<string> {
  const client = new Anthropic({ apiKey: cfg.apiKey, baseURL: cfg.baseUrl, maxRetries: 0 });
  const msg = await client.messages.create({
    model: cfg.model,
    max_tokens: 2000,
    messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
  });
  if (msg.stop_reason === 'refusal') return '(refused)';
  return msg.content.map((b) => (b.type === 'text' ? b.text : '')).join('').trim();
}
