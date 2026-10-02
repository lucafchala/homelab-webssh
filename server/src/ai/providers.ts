import { z } from 'zod';
import { streamAnthropic, testAnthropic } from './anthropic.js';
import { streamOpenAi, testOpenAi } from './openai.js';
import type { AiAssistantMessage, AiConfig, AiToolDef, StreamRequest } from './types.js';

export const RunCommandInput = z.object({
  command: z.string().min(1).max(10_000),
  explanation: z.string().max(2000).optional(),
  timeout_seconds: z.number().int().min(1).max(600).optional(),
});

export const RUN_COMMAND_TOOL: AiToolDef = {
  name: 'run_command',
  description:
    'Run a shell command on the host the user is connected to and get its exit code, stdout and stderr. ' +
    'The user sees every call and must approve it before it runs. Commands run non-interactively (no TTY, no stdin) ' +
    'over a separate SSH channel, not in the user\'s terminal, with a timeout (default 60 s). ' +
    'Use one focused command per call; avoid pagers, editors and anything that waits for input.',
  schema: RunCommandInput,
  jsonSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The exact shell command to execute (POSIX sh).' },
      explanation: { type: 'string', description: 'One short sentence telling the user what this command does and why.' },
      timeout_seconds: { type: 'integer', description: 'Optional timeout in seconds (1-600).', minimum: 1, maximum: 600 },
    },
    required: ['command', 'explanation'],
    additionalProperties: false,
  },
};

export type EffectiveAi = AiConfig & { autoApproveReadOnly: boolean };

export function streamChat(cfg: AiConfig, req: StreamRequest): Promise<AiAssistantMessage> {
  return cfg.provider === 'anthropic' ? streamAnthropic(cfg, req) : streamOpenAi(cfg, req);
}

export async function testAiProvider(cfg: AiConfig & { apiKey?: string }) {
  const started = Date.now();
  if (cfg.provider === 'anthropic' && !cfg.apiKey) return { ok: false, error: 'No API key configured' };
  try {
    const reply = cfg.provider === 'anthropic' ? await testAnthropic(cfg) : await testOpenAi(cfg);
    return { ok: true, provider: cfg.provider, model: cfg.model, reply: reply.slice(0, 200), latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, provider: cfg.provider, model: cfg.model, error: (err as Error).message };
  }
}
