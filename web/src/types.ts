export type Role = 'admin' | 'user';

export interface User {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  totpEnabled: boolean;
  passkeys: number;
  disabled: boolean;
  mustChangePassword: boolean;
  createdAt: number;
  lastLoginAt: number | null;
  locked: boolean;
  settings: Partial<UserPrefs>;
}

export interface Features {
  ai: boolean;
  aiProvider: string;
  aiModel: string | null;
  aiAutoApproveReadOnly: boolean;
  tldr: boolean;
  recording: 'off' | 'per-host' | 'all';
  allowUserHosts: boolean;
  require2fa: boolean;
  terminalGraceMinutes: number;
  maxUploadBytes: number;
}

export interface Me {
  user: User;
  csrf: string;
  mustChangePassword: boolean;
  needs2faSetup: boolean;
  features: Features;
}

export interface Host {
  id: string;
  name: string;
  hostname: string;
  port: number;
  username: string;
  authType: 'password' | 'key' | 'ask';
  hasPassword: boolean;
  keyId: string | null;
  jumpHostId: string | null;
  group: string;
  tags: string[];
  color: string | null;
  notes: string;
  macAddress: string | null;
  startupCommand: string | null;
  shared: boolean;
  record: boolean;
  useSudo: boolean;
  favorite: boolean;
  hostKey: { type: string | null; fingerprint: string; trustedAt: number | null } | null;
  lastConnectedAt: number | null;
  owned: boolean;
}

export interface SshKey {
  id: string;
  name: string;
  type: string;
  publicKey: string;
  fingerprint: string;
  hasPassphrase: boolean;
  createdAt: number;
}

export interface Snippet {
  id: string;
  name: string;
  command: string;
  description: string;
  tags: string[];
  shared: boolean;
  owned: boolean;
}

export interface LiveSession {
  id: string;
  hostId: string;
  hostName: string;
  title: string;
  status: string;
  createdAt: number;
  lastActivityAt: number;
  clients: number;
  recording: boolean;
  username?: string;
}

export interface UserPrefs {
  theme: 'dark' | 'light' | 'system';
  termTheme: string;
  fontSize: number;
  fontFamily: string;
  cursorStyle: 'block' | 'bar' | 'underline';
  cursorBlink: boolean;
  scrollback: number;
  copyOnSelect: boolean;
  rightClickPaste: boolean;
  bellNotify: boolean;
  keybar: 'auto' | 'always' | 'never';
  confirmClose: boolean;
  aiIncludeContext: boolean;
}

export const DEFAULT_PREFS: UserPrefs = {
  theme: 'dark',
  termTheme: 'webssh',
  fontSize: 14,
  fontFamily: '"JetBrains Mono", "Cascadia Code", "Fira Code", Menlo, Consolas, "DejaVu Sans Mono", monospace',
  cursorStyle: 'block',
  cursorBlink: true,
  scrollback: 5000,
  copyOnSelect: false,
  rightClickPaste: true,
  bellNotify: true,
  keybar: 'auto',
  confirmClose: true,
  aiIncludeContext: true,
};

export interface CommandHelp {
  name: string;
  category: string;
  summary: string;
  usage: string;
  options: [string, string][];
  examples: [string, string][];
  related?: string[];
  danger?: string;
}

export interface Recipe {
  id: string;
  title: string;
  category: string;
  steps: { text: string; command?: string }[];
  note?: string;
}

export interface KeySheet {
  id: string;
  title: string;
  sections: { title: string; keys: [string, string][] }[];
}

export interface HelpAnswer {
  query: string;
  confidence: 'high' | 'low' | 'none';
  command: CommandHelp | null;
  commands: CommandHelp[];
  recipes: Recipe[];
  keySheets: KeySheet[];
  lookupName: string | null;
  suggestAi: boolean;
}

export interface TldrPage {
  name: string;
  description: string;
  moreInfo: string | null;
  examples: { description: string; command: string }[];
  platform: string;
}

export type Risk = 'read' | 'write' | 'dangerous';

export interface AiToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export type AiMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: AiToolCall[]; raw?: { provider: string; model?: string; content: unknown } }
  | { role: 'tool'; toolCallId: string; content: string; isError?: boolean };

export interface ExecResult {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  durationMs: number;
  risk?: { risk: Risk; reasons: string[] };
}
