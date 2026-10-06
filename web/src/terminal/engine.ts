import { signal } from '@preact/signals';
import { Terminal, type IDisposable } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import { getTheme } from './themes';
import { applyModifiers } from './keys';
import { prefs, toast, view } from '../state';
import { checkAccessRedirect } from '../api';
import { isTouch } from '../util';
import type { Host } from '../types';

export type TabStatus = 'connecting' | 'ready' | 'reconnecting' | 'closed' | 'error';

export interface Tab {
  key: string;
  hostId: string;
  hostName: string;
  color: string | null;
  sessionId: string | null;
  title: string;
  status: TabStatus;
  message?: string;
  recording?: boolean;
  bell?: boolean;
}

export const tabs = signal<Tab[]>([]);
export const activeTab = signal<string | null>(null);
export const layout = signal<'tabs' | 'grid'>('tabs');
export const broadcastSet = signal<Set<string>>(new Set());
export const stickyCtrl = signal(false);
export const stickyAlt = signal(false);
export const stickyShift = signal(false);

/** Pending interactive question from a terminal connection (host key / password / 2FA prompt). */
export interface PendingPrompt {
  tabKey: string;
  requestId: string;
  kind: 'hostkey' | 'prompt';
  msg: any;
}
export const pendingPrompt = signal<PendingPrompt | null>(null);

const controllers = new Map<string, TerminalController>();
export const getController = (key: string) => controllers.get(key);
export const activeController = () => (activeTab.value ? controllers.get(activeTab.value) : undefined);

const STORAGE_KEY = 'webssh.tabs';
const encoder = new TextEncoder();

function updateTab(key: string, patch: Partial<Tab>) {
  tabs.value = tabs.value.map((t) => (t.key === key ? { ...t, ...patch } : t));
  persistTabs();
}

function persistTabs() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(tabs.value.filter((t) => t.sessionId && t.status !== 'closed').map((t) => ({ hostId: t.hostId, sessionId: t.sessionId }))));
  } catch {
    /* storage unavailable */
  }
}

export function savedSessions(): { hostId: string; sessionId: string }[] {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
  } catch {
    return [];
  }
}

function wsUrl() {
  return `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/api/terminal/ws`;
}

export class TerminalController {
  readonly el: HTMLDivElement;
  readonly term: Terminal;
  readonly fitAddon = new FitAddon();
  readonly search = new SearchAddon();
  private ws: WebSocket | null = null;
  private opened = false;
  private disposed = false;
  private sessionClosed = false;
  private retry = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private resizeTimer: ReturnType<typeof setTimeout> | null = null;
  private disposables: IDisposable[] = [];
  private webgl: WebglAddon | null = null;
  sessionId: string | null;
  /** Text typed into the shell once it is ready (e.g. "cd /path" from the file manager). */
  pendingInput: string | null = null;

  constructor(
    readonly key: string,
    readonly hostId: string,
    attachSessionId: string | null,
  ) {
    this.sessionId = attachSessionId;
    this.el = document.createElement('div');
    this.el.className = 'xterm-host';
    const p = prefs.value;
    this.term = new Terminal({
      fontSize: p.fontSize,
      fontFamily: p.fontFamily,
      cursorStyle: p.cursorStyle,
      cursorBlink: p.cursorBlink,
      scrollback: p.scrollback,
      theme: getTheme(p.termTheme),
      allowProposedApi: true,
      macOptionIsMeta: true,
      rightClickSelectsWord: false,
      smoothScrollDuration: 0,
      drawBoldTextInBrightColors: true,
    });
    this.term.loadAddon(this.fitAddon);
    this.term.loadAddon(this.search);
    this.term.loadAddon(new WebLinksAddon((_e, uri) => window.open(uri, '_blank', 'noopener,noreferrer')));
    const uni = new Unicode11Addon();
    this.term.loadAddon(uni);
    this.term.unicode.activeVersion = '11';

    this.disposables.push(
      this.term.onData((d) => this.onUserInput(d)),
      this.term.onBinary((d) => this.sendBytes(Uint8Array.from(d, (c) => c.charCodeAt(0) & 0xff))),
      this.term.onResize(({ cols, rows }) => this.scheduleResize(cols, rows)),
      this.term.onTitleChange((title) => updateTab(this.key, { title })),
      this.term.onBell(() => this.onBell()),
      this.term.onSelectionChange(() => {
        if (prefs.value.copyOnSelect && this.term.hasSelection()) void navigator.clipboard?.writeText(this.term.getSelection()).catch(() => {});
      }),
    );
    this.term.attachCustomKeyEventHandler((e) => this.keyHandler(e));
    this.el.addEventListener('contextmenu', (e) => {
      if (!prefs.value.rightClickPaste || isTouch()) return;
      e.preventDefault();
      if (this.term.hasSelection()) {
        void navigator.clipboard?.writeText(this.term.getSelection());
        this.term.clearSelection();
      } else void this.pasteFromClipboard();
    });
    controllers.set(key, this);
  }

  /** Attach the xterm DOM to a container (can be called again to move it). */
  mount(container: HTMLElement) {
    if (this.el.parentElement !== container) container.appendChild(this.el);
    if (!this.opened) {
      this.term.open(this.el);
      this.opened = true;
      const ta = this.term.textarea;
      if (ta) {
        ta.setAttribute('autocapitalize', 'off');
        ta.setAttribute('autocorrect', 'off');
        ta.setAttribute('autocomplete', 'off');
        ta.setAttribute('spellcheck', 'false');
        ta.setAttribute('enterkeyhint', 'send');
      }
      if (!isTouch()) {
        try {
          this.webgl = new WebglAddon();
          this.webgl.onContextLoss(() => {
            this.webgl?.dispose();
            this.webgl = null;
          });
          this.term.loadAddon(this.webgl);
        } catch {
          this.webgl = null; // DOM renderer fallback
        }
      }
      this.fit();
      this.connect();
    } else {
      this.fit();
    }
  }

  fit() {
    if (!this.opened || !this.el.isConnected || this.el.clientWidth === 0) return;
    try {
      this.fitAddon.fit();
    } catch {
      /* not visible */
    }
  }

  focus() {
    this.term.focus();
  }

  // ---------------------------------------------------------------- connection
  connect() {
    if (this.disposed) return;
    this.sessionClosed = false;
    updateTab(this.key, { status: this.sessionId ? (this.retry ? 'reconnecting' : 'connecting') : 'connecting', message: undefined });
    const ws = new WebSocket(wsUrl());
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      const { cols, rows } = this.term;
      if (this.sessionId) ws.send(JSON.stringify({ type: 'attach', sessionId: this.sessionId, cols, rows }));
      else ws.send(JSON.stringify({ type: 'open', hostId: this.hostId, cols, rows }));
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string') {
        this.term.write(new Uint8Array(ev.data as ArrayBuffer));
        return;
      }
      let msg: any;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      this.onControl(msg);
    };
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (this.disposed || this.sessionClosed) return;
      if (ev.code === 4001) {
        updateTab(this.key, { status: 'error', message: 'Signed out' });
        return;
      }
      if (this.sessionId) this.scheduleReconnect();
      else updateTab(this.key, { status: 'error', message: 'Connection failed' });
    };
  }

  private scheduleReconnect() {
    updateTab(this.key, { status: 'reconnecting', message: 'Connection lost — reconnecting…' });
    if (this.retry >= 2 && navigator.onLine) void checkAccessRedirect();
    const delay = Math.min(15_000, 1000 * 2 ** Math.min(this.retry, 4));
    this.retry++;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  /** Called on visibility/online events to reconnect immediately instead of waiting for backoff. */
  nudge() {
    const st = tabs.value.find((t) => t.key === this.key)?.status;
    if (st === 'reconnecting' && !this.ws) {
      if (this.retryTimer) clearTimeout(this.retryTimer);
      this.connect();
    }
  }

  private onControl(msg: any) {
    switch (msg.type) {
      case 'created':
        this.sessionId = msg.sessionId;
        updateTab(this.key, { sessionId: msg.sessionId });
        break;
      case 'status':
        updateTab(this.key, { status: this.sessionId && this.retry ? 'reconnecting' : 'connecting', message: msg.message });
        break;
      case 'ready':
        this.retry = 0;
        updateTab(this.key, { status: 'ready', message: undefined, recording: !!msg.recording });
        this.fit();
        if (this.pendingInput) {
          const text = this.pendingInput;
          this.pendingInput = null;
          // Give the login shell a moment to print its prompt.
          setTimeout(() => this.sendText(text), 400);
        }
        break;
      case 'attached':
        this.retry = 0;
        this.term.reset();
        updateTab(this.key, { status: msg.status === 'ready' ? 'ready' : 'connecting', message: undefined, recording: !!msg.recording, title: msg.title || '' });
        setTimeout(() => this.sendResize(), 50);
        break;
      case 'hostkey':
      case 'prompt':
        pendingPrompt.value = { tabKey: this.key, requestId: msg.requestId, kind: msg.type, msg };
        break;
      case 'title':
        if (msg.title) updateTab(this.key, { title: msg.title });
        break;
      case 'error':
        if (msg.code === 'NOT_FOUND' && this.sessionId) {
          this.sessionClosed = true;
          this.term.write(`\r\n\x1b[33m[session ended on the server]\x1b[0m\r\n`);
          updateTab(this.key, { status: 'closed', message: 'Session ended', sessionId: null });
          this.sessionId = null;
        } else {
          this.sessionClosed = true;
          this.term.write(`\r\n\x1b[31m${msg.message}\x1b[0m\r\n`);
          updateTab(this.key, { status: 'error', message: msg.message });
        }
        if (pendingPrompt.value?.tabKey === this.key) pendingPrompt.value = null;
        break;
      case 'closed':
        this.sessionClosed = true;
        this.term.write(`\r\n\x1b[90m[${msg.reason ?? 'session closed'}]\x1b[0m\r\n`);
        updateTab(this.key, { status: 'closed', message: msg.reason, sessionId: null });
        this.sessionId = null;
        break;
    }
  }

  answer(requestId: string, payload: { accept?: boolean; responses?: string[] | null }) {
    this.ws?.send(JSON.stringify({ type: 'answer', requestId, ...payload }));
  }

  /** Start a brand-new session for this tab (after it ended). */
  restart() {
    this.sessionId = null;
    this.retry = 0;
    this.ws?.close();
    this.ws = null;
    this.term.reset();
    this.connect();
  }

  // ---------------------------------------------------------------- input / output
  private onUserInput(data: string) {
    // One-shot modifiers armed on the key bar also apply to the bar's own keys (arrows, Home, F-keys, Tab).
    const { data: d, used } = applyModifiers(data, { ctrl: stickyCtrl.value, alt: stickyAlt.value, shift: stickyShift.value });
    if (used) {
      stickyCtrl.value = false;
      stickyAlt.value = false;
      stickyShift.value = false;
    }
    const targets = broadcastSet.value;
    if (targets.size > 1 && targets.has(this.key)) {
      for (const k of targets) controllers.get(k)?.sendBytes(encoder.encode(d));
    } else {
      this.sendBytes(encoder.encode(d));
    }
  }

  sendBytes(bytes: Uint8Array) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(bytes);
  }

  /** Type text into the shell as if the user typed it (no newline unless included). */
  sendText(text: string) {
    this.onUserInput(text);
  }

  /** Paste with bracketed-paste semantics handled by xterm. */
  paste(text: string) {
    this.term.paste(text);
  }

  async pasteFromClipboard() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) this.paste(text);
    } catch {
      toast('Clipboard access was blocked by the browser — use Ctrl/⌘+V or long-press → Paste', 'error');
    }
  }

  private scheduleResize(_cols: number, _rows: number) {
    if (this.resizeTimer) clearTimeout(this.resizeTimer);
    this.resizeTimer = setTimeout(() => this.sendResize(), 80);
  }

  private sendResize() {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'resize', cols: this.term.cols, rows: this.term.rows }));
  }

  private keyHandler(e: KeyboardEvent): boolean {
    if (e.type !== 'keydown') return true;
    const mod = e.ctrlKey || e.metaKey;
    // Ctrl+Shift+C / V → copy / paste (Ctrl+C stays SIGINT)
    if (mod && e.shiftKey && e.code === 'KeyC') {
      if (this.term.hasSelection()) void navigator.clipboard?.writeText(this.term.getSelection());
      return false;
    }
    if (mod && e.shiftKey && e.code === 'KeyV') {
      void this.pasteFromClipboard();
      e.preventDefault();
      return false;
    }
    // ⌘C on macOS copies when there is a selection
    if (e.metaKey && !e.shiftKey && e.code === 'KeyC' && this.term.hasSelection()) {
      void navigator.clipboard?.writeText(this.term.getSelection());
      return false;
    }
    // App-level shortcuts are handled by the global listener; don't send them to the shell.
    if (mod && e.shiftKey && ['KeyK', 'KeyP', 'KeyF', 'KeyH', 'KeyA'].includes(e.code)) return false;
    if (mod && (e.key === '=' || e.key === '+' || e.key === '-' || e.key === '0') && !e.shiftKey && e.ctrlKey) {
      return false;
    }
    return true;
  }

  private onBell() {
    if (activeTab.value !== this.key || view.value !== 'terminal' || document.hidden) {
      updateTab(this.key, { bell: true });
      if (document.hidden && prefs.value.bellNotify && 'Notification' in window && Notification.permission === 'granted') {
        const t = tabs.value.find((x) => x.key === this.key);
        new Notification(`🔔 ${t?.hostName ?? 'Terminal'}`, { body: t?.title || 'Bell / command finished', tag: this.key });
      }
    }
  }

  // ---------------------------------------------------------------- helpers
  /** Last N lines of the buffer as plain text (for help / AI context). */
  recentText(lines = 120): string {
    const buf = this.term.buffer.active;
    const end = buf.baseY + buf.cursorY + 1;
    const start = Math.max(0, end - lines);
    const out: string[] = [];
    for (let i = start; i < end; i++) out.push(buf.getLine(i)?.translateToString(true) ?? '');
    return out.join('\n').replace(/\n+$/, '');
  }

  selection(): string {
    return this.term.getSelection();
  }

  applyPrefs() {
    const p = prefs.value;
    this.term.options.fontSize = p.fontSize;
    this.term.options.fontFamily = p.fontFamily;
    this.term.options.cursorStyle = p.cursorStyle;
    this.term.options.cursorBlink = p.cursorBlink;
    this.term.options.scrollback = p.scrollback;
    this.term.options.theme = getTheme(p.termTheme);
    this.fit();
  }

  setFontSize(size: number) {
    this.term.options.fontSize = Math.max(8, Math.min(32, size));
    this.fit();
  }

  /** Close the WebSocket; `kill` also terminates the remote shell, otherwise it stays attachable. */
  dispose(kill: boolean) {
    this.disposed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (kill && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'close' }));
    const ws = this.ws;
    this.ws = null;
    setTimeout(() => ws?.close(), kill ? 200 : 0);
    for (const d of this.disposables) d.dispose();
    this.webgl?.dispose();
    this.term.dispose();
    this.el.remove();
    controllers.delete(this.key);
  }
}

// ------------------------------------------------------------------ tab operations
let tabSeq = 0;

export function openTerminal(host: Pick<Host, 'id' | 'name' | 'color'>, sessionId: string | null = null, focus = true, initialInput?: string): string {
  const key = `t${Date.now().toString(36)}${(tabSeq++).toString(36)}`;
  tabs.value = [...tabs.value, { key, hostId: host.id, hostName: host.name, color: host.color, sessionId, title: '', status: 'connecting' }];
  const ctrl = new TerminalController(key, host.id, sessionId);
  if (initialInput) ctrl.pendingInput = initialInput;
  if (focus || !activeTab.value) activeTab.value = key;
  view.value = 'terminal';
  return key;
}

/** Type a command into a terminal on `host`: reuse the active tab if it is on that host, else open a new one. */
export function runOnHost(host: Pick<Host, 'id' | 'name' | 'color'>, text: string) {
  const t = tabs.value.find((x) => x.key === activeTab.value);
  const c = t ? controllers.get(t.key) : undefined;
  if (t && c && t.hostId === host.id && t.status === 'ready') {
    view.value = 'terminal';
    c.sendText(text);
    c.focus();
  } else {
    openTerminal(host, null, true, text);
  }
}

export function closeTab(key: string, kill = true) {
  controllers.get(key)?.dispose(kill);
  const idx = tabs.value.findIndex((t) => t.key === key);
  tabs.value = tabs.value.filter((t) => t.key !== key);
  const b = new Set(broadcastSet.value);
  b.delete(key);
  broadcastSet.value = b;
  if (activeTab.value === key) activeTab.value = tabs.value[Math.max(0, idx - 1)]?.key ?? null;
  persistTabs();
}

export function activate(key: string) {
  activeTab.value = key;
  view.value = 'terminal';
  updateTab(key, { bell: false });
  requestAnimationFrame(() => {
    const c = controllers.get(key);
    c?.fit();
    if (!isTouch()) c?.focus();
  });
}

export function toggleBroadcast(key: string) {
  const s = new Set(broadcastSet.value);
  if (s.has(key)) s.delete(key);
  else s.add(key);
  broadcastSet.value = s;
}

export function applyPrefsToAll() {
  for (const c of controllers.values()) c.applyPrefs();
}

export function fitAll() {
  for (const c of controllers.values()) c.fit();
}

if (typeof window !== 'undefined') {
  const nudgeAll = () => {
    for (const c of controllers.values()) c.nudge();
  };
  document.addEventListener('visibilitychange', () => !document.hidden && nudgeAll());
  window.addEventListener('online', nudgeAll);
  window.addEventListener('focus', nudgeAll);
}

// Read-only hook for automated browser tests (only under WebDriver/Playwright).
if (typeof navigator !== 'undefined' && navigator.webdriver) {
  (window as unknown as { __webssh: unknown }).__webssh = {
    screen: () => activeController()?.recentText(300) ?? '',
  };
}
