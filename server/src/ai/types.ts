import { z } from 'zod';

/** Provider-neutral conversation format exchanged with the browser. */
export const AiToolCallSchema = z.object({
  id: z.string().max(200),
  name: z.string().max(100),
  input: z.record(z.string(), z.unknown()),
});

export const AiMessageSchema = z.discriminatedUnion('role', [
  z.object({ role: z.literal('user'), content: z.string().max(100_000) }),
  z.object({
    role: z.literal('assistant'),
    content: z.string().max(200_000),
    toolCalls: z.array(AiToolCallSchema).max(20).optional(),
    /** Provider-native content (e.g. Anthropic blocks incl. thinking) echoed back unchanged on the next turn. */
    raw: z.object({ provider: z.string(), model: z.string().optional(), content: z.unknown() }).optional(),
  }),
  z.object({ role: z.literal('tool'), toolCallId: z.string().max(200), content: z.string().max(100_000), isError: z.boolean().optional() }),
]);

export type AiToolCall = z.infer<typeof AiToolCallSchema>;
export type AiMessage = z.infer<typeof AiMessageSchema>;
export type AiAssistantMessage = Extract<AiMessage, { role: 'assistant' }>;

export interface AiToolDef {
  name: string;
  description: string;
  schema: z.ZodObject;
  jsonSchema: Record<string, unknown>;
}

export type AiEvent =
  | { type: 'text'; delta: string }
  | { type: 'thinking'; delta: string }
  | { type: 'tool_call'; call: AiToolCall }
  | { type: 'done'; stopReason: string; message: AiAssistantMessage; usage?: { inputTokens?: number; outputTokens?: number } }
  | { type: 'error'; message: string };

export interface AiConfig {
  provider: 'anthropic' | 'openai' | 'ollama';
  model: string;
  baseUrl: string;
  apiKey?: string;
  maxTokens: number;
}

export interface StreamRequest {
  system: string;
  messages: AiMessage[];
  tools: AiToolDef[];
  signal: AbortSignal;
  onEvent: (e: AiEvent) => void;
}
