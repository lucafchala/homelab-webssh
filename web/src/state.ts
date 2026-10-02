import { computed, signal } from '@preact/signals';
import { api, setCsrf } from './api';
import { DEFAULT_PREFS, type Host, type LiveSession, type Me, type Snippet, type SshKey, type UserPrefs } from './types';

// ------------------------------------------------------------------ session / user
export const me = signal<Me | null>(null);
export const authPhase = signal<'loading' | 'setup' | 'login' | 'app'>('loading');
export const loginBanner = signal('');

export const prefs = signal<UserPrefs>({ ...DEFAULT_PREFS });

export async function loadMe(): Promise<Me | null> {
  try {
    const m = await api.get<Me>('/api/me');
    setCsrf(m.csrf);
    me.value = m;
    prefs.value = { ...DEFAULT_PREFS, ...(m.user.settings as Partial<UserPrefs>) };
    applyTheme();
    return m;
  } catch {
    me.value = null;
    return null;
  }
}

export async function savePrefs(patch: Partial<UserPrefs>) {
  prefs.value = { ...prefs.value, ...patch };
  applyTheme();
  try {
    await api.put('/api/me/settings', prefs.value);
  } catch (err) {
    toast(`Could not save settings: ${(err as Error).message}`, 'error');
  }
}

export function applyTheme() {
  const t = prefs.value.theme;
  const dark = t === 'dark' || (t === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#0d1117' : '#f6f8fa');
}

export const isAdmin = computed(() => me.value?.user.role === 'admin');

// ------------------------------------------------------------------ data
export const hosts = signal<Host[]>([]);
export const keys = signal<SshKey[]>([]);
export const snippets = signal<Snippet[]>([]);
export const liveSessions = signal<LiveSession[]>([]);

export async function loadHosts() {
  hosts.value = await api.get<Host[]>('/api/hosts');
}
export async function loadKeys() {
  keys.value = await api.get<SshKey[]>('/api/keys');
}
export async function loadSnippets() {
  snippets.value = await api.get<Snippet[]>('/api/snippets');
}
export async function loadLiveSessions() {
  liveSessions.value = await api.get<LiveSession[]>('/api/terminals');
}

export const hostById = (id: string | null | undefined) => hosts.value.find((h) => h.id === id);

// ------------------------------------------------------------------ navigation
export type View = 'hosts' | 'terminal' | 'files' | 'dashboard' | 'snippets' | 'keys' | 'recordings' | 'settings' | 'admin';
export const view = signal<View>('hosts');
export const sidePanel = signal<null | 'help' | 'ai'>(null);
export const drawerOpen = signal(false);
export const paletteOpen = signal(false);
/** Host targeted by Files / Dashboard views. */
export const focusHostId = signal<string | null>(null);
/** Text to pre-fill the help panel / AI panel with. */
export const helpQuery = signal('');
export const aiSeed = signal<{ text: string; mode?: 'chat' | 'agent' | 'generate'; context?: string } | null>(null);

export function go(v: View) {
  view.value = v;
  drawerOpen.value = false;
}

// ------------------------------------------------------------------ toasts
export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'success' | 'error';
}
export const toasts = signal<Toast[]>([]);
let toastId = 0;
export function toast(text: string, kind: Toast['kind'] = 'info', ms = 4000) {
  const id = ++toastId;
  toasts.value = [...toasts.value, { id, text, kind }];
  setTimeout(() => (toasts.value = toasts.value.filter((t) => t.id !== id)), kind === 'error' ? ms * 2 : ms);
}

// ------------------------------------------------------------------ dialogs (promise-based)
export interface DialogField {
  name: string;
  label: string;
  type?: 'text' | 'password' | 'textarea' | 'number';
  value?: string;
  placeholder?: string;
  required?: boolean;
}
export interface DialogSpec {
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  /** Require typing this exact text to enable the confirm button. */
  typeToConfirm?: string;
  fields?: DialogField[];
  resolve: (v: Record<string, string> | null) => void;
}
export const dialog = signal<DialogSpec | null>(null);

export function confirmDialog(spec: Omit<DialogSpec, 'resolve' | 'fields'>): Promise<boolean> {
  return new Promise((resolve) => {
    dialog.value = { ...spec, resolve: (v) => resolve(v !== null) };
  });
}

export function promptDialog(spec: Omit<DialogSpec, 'resolve'>): Promise<Record<string, string> | null> {
  return new Promise((resolve) => {
    dialog.value = { ...spec, resolve };
  });
}
