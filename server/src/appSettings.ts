import { z } from 'zod';
import type { Config } from './config.js';
import type { Db } from './db/index.js';
import { Settings } from './db/models.js';
import type { Vault } from './security/crypto.js';

export const AI_PROVIDERS = ['none', 'anthropic', 'openai', 'ollama'] as const;
export type AiProvider = (typeof AI_PROVIDERS)[number];

export const DEFAULT_MODELS: Record<Exclude<AiProvider, 'none'>, string> = {
  anthropic: 'claude-opus-5-5',
  openai: 'gpt-4.1-mini',
  ollama: 'qwen2.5-coder:7b',
};

export const DEFAULT_BASE_URLS: Record<Exclude<AiProvider, 'none'>, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com/v1',
  ollama: 'http://localhost:11434/v1',
};

/** Admin-editable runtime settings stored in the DB (env provides defaults). */
export const AppSettingsSchema = z.object({
  recording: z.enum(['off', 'per-host', 'all']).default('per-host'),
  loginBanner: z.string().max(2000).default(''),
  allowUserHosts: z.boolean().default(true),
  ai: z
    .object({
      provider: z.enum(AI_PROVIDERS).default('none'),
      model: z.string().max(200).default(''),
      baseUrl: z.string().max(500).default(''),
      /** Encrypted in DB; never returned to clients. */
      apiKeyEnc: z.string().nullable().default(null),
      autoApproveReadOnly: z.boolean().default(false),
      maxTokens: z.number().int().min(1024).max(64000).default(16000),
    })
    .default({ provider: 'none', model: '', baseUrl: '', apiKeyEnc: null, autoApproveReadOnly: false, maxTokens: 16000 }),
});

export type AppSettings = z.infer<typeof AppSettingsSchema>;

export class AppSettingsStore {
  private cache: AppSettings | null = null;

  constructor(
    private readonly db: Db,
    private readonly config: Config,
    private readonly vault: Vault,
  ) {}

  get(): AppSettings {
    if (this.cache) return this.cache;
    const stored = Settings.get<Partial<AppSettings> | null>(this.db, 'app', null);
    const base = AppSettingsSchema.parse(stored ?? {});
    if (!stored?.ai) {
      // First boot: seed AI settings from environment.
      base.ai.provider = this.config.ai.provider;
      base.ai.model = this.config.ai.model ?? '';
      base.ai.baseUrl = this.config.ai.baseUrl ?? '';
    }
    this.cache = base;
    return base;
  }

  save(next: AppSettings): AppSettings {
    const parsed = AppSettingsSchema.parse(next);
    Settings.set(this.db, 'app', parsed);
    this.cache = parsed;
    return parsed;
  }

  /** Effective AI configuration (API key: DB value wins, then env). */
  ai() {
    const s = this.get().ai;
    const provider = s.provider;
    if (provider === 'none') return null;
    const apiKey = s.apiKeyEnc ? this.vault.decryptString(s.apiKeyEnc, 'ai-key') : this.config.ai.apiKey && this.config.ai.provider === provider ? this.config.ai.apiKey : undefined;
    return {
      provider,
      model: s.model || DEFAULT_MODELS[provider],
      baseUrl: (s.baseUrl || DEFAULT_BASE_URLS[provider]).replace(/\/+$/, ''),
      apiKey,
      autoApproveReadOnly: s.autoApproveReadOnly,
      maxTokens: s.maxTokens,
      apiKeySource: s.apiKeyEnc ? 'settings' : apiKey ? 'env' : 'none',
    } as const;
  }

  /** Version safe to send to admins: secrets replaced by flags. */
  publicView() {
    const s = this.get();
    const ai = this.ai();
    return {
      recording: s.recording,
      loginBanner: s.loginBanner,
      allowUserHosts: s.allowUserHosts,
      ai: {
        provider: s.ai.provider,
        model: s.ai.model,
        baseUrl: s.ai.baseUrl,
        autoApproveReadOnly: s.ai.autoApproveReadOnly,
        maxTokens: s.ai.maxTokens,
        apiKeySet: !!ai?.apiKey,
        apiKeySource: ai?.apiKeySource ?? 'none',
        effectiveModel: ai?.model ?? '',
        effectiveBaseUrl: ai?.baseUrl ?? '',
      },
    };
  }
}
