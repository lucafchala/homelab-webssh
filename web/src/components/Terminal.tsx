import { useEffect, useRef, useState } from 'preact/hooks';
import {
  ArrowDown, ArrowUp, Bot, ChevronLeft, ChevronRight, CircleHelp, Clipboard, Columns2, Keyboard, LayoutGrid, Minus, MonitorUp, Plus, Radio, RotateCw, Search, Square, X,
} from 'lucide-preact';
import {
  activate, activeController, activeTab, broadcastSet, closeTab, getController, layout, openTerminal, pendingPrompt, stickyAlt, stickyCtrl, tabs, toggleBroadcast, type Tab,
} from '../terminal/engine';
import { aiSeed, confirmDialog, helpQuery, hostById, hosts, liveSessions, loadLiveSessions, me, prefs, savePrefs, sidePanel } from '../state';
import { classNames, fillSnippet, isTouch, snippetVars, timeAgo } from '../util';
import { Modal } from './common';
import { promptDialog } from '../state';
import { snippetPickerOpen } from './Snippets';

export async function requestCloseTab(t: Tab) {
  if (prefs.value.confirmClose && t.status === 'ready') {
    const ok = await confirmDialog({
      title: `Close ${t.hostName}?`,
      message: 'This ends the remote shell. To keep it running in the background, use "Detach" in the tab menu instead.',
      confirmText: 'Close session',
      danger: true,
    });
    if (!ok) return;
  }
  closeTab(t.key, true);
}

function TabStrip() {
  const [menu, setMenu] = useState<string | null>(null);
  return (
    <div class="term-tabs">
      {tabs.value.map((t) => (
        <div
          key={t.key}
          class={classNames('term-tab', activeTab.value === t.key && 'active', t.bell && 'bell')}
          onClick={() => activate(t.key)}
          onAuxClick={(e) => e.button === 1 && requestCloseTab(t)}
          onContextMenu={(e) => {
            e.preventDefault();
            setMenu(menu === t.key ? null : t.key);
          }}
          title={`${t.hostName}${t.title ? ` — ${t.title}` : ''}`}
          style={{ borderTop: t.color ? `2px solid ${t.color}` : undefined }}
        >
          <span class={classNames('dot', t.status === 'ready' ? 'green' : t.status === 'connecting' || t.status === 'reconnecting' ? 'yellow pulse' : 'red')} />
          {broadcastSet.value.has(t.key) && <Radio size={12} class="bc" />}
          <span class="label truncate grow">{t.hostName}</span>
          <button class="sm ghost icon close" onClick={(e) => (e.stopPropagation(), requestCloseTab(t))} aria-label="Close tab">
            <X size={13} />
          </button>
          {menu === t.key && (
            <div class="card" style={{ position: 'fixed', zIndex: 50, marginTop: 60, padding: 4, minWidth: 180 }} onClick={(e) => e.stopPropagation()} onMouseLeave={() => setMenu(null)}>
              <button class="ghost nav-item" onClick={() => (closeTab(t.key, false), setMenu(null))}>
                Detach (keep running)
              </button>
              <button class="ghost nav-item" onClick={() => (getController(t.key)?.restart(), setMenu(null))}>
                Reconnect / new shell
              </button>
              <button class="ghost nav-item" onClick={() => (toggleBroadcast(t.key), setMenu(null))}>
                {broadcastSet.value.has(t.key) ? 'Remove from broadcast' : 'Add to broadcast group'}
              </button>
              <button class="ghost nav-item" onClick={() => (openTerminal({ id: t.hostId, name: t.hostName, color: t.color }), setMenu(null))}>
                Duplicate
              </button>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

/** Topbar controls for the terminal view. */
export function TerminalTopbar() {
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const c = activeController();
  const fs = prefs.value.fontSize;
  return (
    <>
      <TabStrip />
      <div class="term-toolbar">
        <button class="ghost icon hide-mobile" title="Detached sessions (attach from any device)" onClick={() => (void loadLiveSessions(), setSessionsOpen(true))}>
          <MonitorUp size={16} />
        </button>
        <button class={classNames('ghost icon hide-mobile', layout.value === 'grid' && 'active')} title="Grid / split view" onClick={() => (layout.value = layout.value === 'grid' ? 'tabs' : 'grid')}>
          {layout.value === 'grid' ? <Square size={16} /> : <LayoutGrid size={16} />}
        </button>
        <button
          class={classNames('ghost icon hide-mobile', broadcastSet.value.size > 1 && 'active')}
          title="Broadcast input to several terminals (right-click tabs to add)"
          onClick={() => {
            if (broadcastSet.value.size > 1) broadcastSet.value = new Set();
            else broadcastSet.value = new Set(tabs.value.map((t) => t.key));
          }}
        >
          <Radio size={16} />
        </button>
        <button class="ghost icon hide-mobile" title="Smaller font" onClick={() => savePrefs({ fontSize: Math.max(8, fs - 1) }).then(() => c?.applyPrefs())}>
          <Minus size={16} />
        </button>
        <button class="ghost icon hide-mobile" title="Larger font" onClick={() => savePrefs({ fontSize: Math.min(32, fs + 1) }).then(() => c?.applyPrefs())}>
          <Plus size={16} />
        </button>
      </div>
      {sessionsOpen && <SessionsModal onClose={() => setSessionsOpen(false)} />}
    </>
  );
}

export function SessionsModal({ onClose }: { onClose: () => void }) {
  const attachedIds = new Set(tabs.value.map((t) => t.sessionId));
  return (
    <Modal title="Running sessions" icon={<MonitorUp size={18} />} onClose={onClose}>
      <p class="dim small">
        Sessions keep running for {me.value?.features.terminalGraceMinutes ?? 30} minutes after you disconnect. Attach from any device — start on your PC, continue on your phone.
      </p>
      {!liveSessions.value.length && <div class="empty">No running sessions.</div>}
      <div class="col">
        {liveSessions.value.map((s) => (
          <div class="card row" key={s.id}>
            <div class="grow">
              <b>{s.hostName}</b> {s.title && <span class="dim">— {s.title}</span>}
              <div class="small faint">
                started {timeAgo(s.createdAt)} · active {timeAgo(s.lastActivityAt)} · {s.clients} viewer(s) {s.recording && '· recording'}
              </div>
            </div>
            {attachedIds.has(s.id) ? (
              <span class="badge green">open here</span>
            ) : (
              <button
                class="primary sm"
                onClick={() => {
                  const h = hostById(s.hostId);
                  openTerminal({ id: s.hostId, name: s.hostName, color: h?.color ?? null }, s.id);
                  onClose();
                }}
              >
                Attach
              </button>
            )}
          </div>
        ))}
      </div>
    </Modal>
  );
}

function Pane({ t, showTitle }: { t: Tab; showTitle: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const c = getController(t.key);
    if (!c || !ref.current) return;
    c.mount(ref.current);
    const ro = new ResizeObserver(() => c.fit());
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [t.key]);
  const c = getController(t.key);
  const focused = activeTab.value === t.key;
  return (
    <div class={classNames('term-pane', focused && 'focused')} onMouseDown={() => activeTab.value !== t.key && (activeTab.value = t.key)}>
      {showTitle && (
        <div class="pane-title" onClick={() => activate(t.key)}>
          <span class={classNames('dot', t.status === 'ready' ? 'green' : 'yellow')} />
          {t.hostName} {t.title && <span class="faint truncate">— {t.title}</span>}
        </div>
      )}
      <div class="term-container" ref={ref} />
      {t.status !== 'ready' && (
        <div class="term-overlay" style={{ background: t.status === 'connecting' ? 'transparent' : undefined, pointerEvents: t.status === 'connecting' ? 'none' : undefined }}>
          {t.status === 'connecting' ? (
            <div class="card small dim" style={{ position: 'absolute', top: 12, right: 16 }}>
              <span class="spinner" /> {t.message ?? 'Connecting…'}
            </div>
          ) : t.status === 'reconnecting' ? (
            <div class="card">
              <span class="spinner" /> <b>Reconnecting…</b>
              <p class="small dim mt">Your shell is still running on the server. We'll re-attach as soon as the network is back.</p>
              <button onClick={() => c?.nudge()}>Retry now</button>
            </div>
          ) : (
            <div class="card">
              <b>{t.status === 'closed' ? 'Session ended' : 'Connection failed'}</b>
              {t.message && <p class="small dim mt">{t.message}</p>}
              <div class="row center mt">
                <button class="primary" onClick={() => c?.restart()}>
                  <RotateCw size={14} /> Reconnect
                </button>
                <button onClick={() => closeTab(t.key, false)}>Close tab</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SearchBar({ onClose }: { onClose: () => void }) {
  const [q, setQ] = useState('');
  const c = activeController();
  const find = (dir: 'next' | 'prev') => {
    if (!c || !q) return;
    const opts = { caseSensitive: false, decorations: { matchOverviewRuler: '#d29922', activeMatchColorOverviewRuler: '#f85149', matchBackground: '#d2992266', activeMatchBackground: '#f8514966' } };
    if (dir === 'next') c.search.findNext(q, opts);
    else c.search.findPrevious(q, opts);
  };
  return (
    <div class="term-search">
      <input
        autoFocus
        placeholder="Search scrollback…"
        value={q}
        onInput={(e) => setQ(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') find(e.shiftKey ? 'prev' : 'next');
          if (e.key === 'Escape') onClose();
        }}
      />
      <button class="sm icon" onClick={() => find('prev')} title="Previous">
        <ArrowUp size={14} />
      </button>
      <button class="sm icon" onClick={() => find('next')} title="Next">
        <ArrowDown size={14} />
      </button>
      <button class="sm icon ghost" onClick={() => (c?.search.clearDecorations(), onClose())}>
        <X size={14} />
      </button>
    </div>
  );
}

export const searchOpen = { value: false, set: (_: boolean) => {} };

export function TerminalPage() {
  const [search, setSearch] = useState(false);
  searchOpen.set = setSearch;
  const list = tabs.value;
  useEffect(() => {
    requestAnimationFrame(() => {
      for (const t of list) getController(t.key)?.fit();
    });
  }, [layout.value, list.length, sidePanel.value]);

  if (!list.length) {
    return (
      <div class="page">
        <div class="empty">
          <h3>No open terminals</h3>
          <p class="dim">Pick a host to connect.</p>
          <div class="row wrap center mt">
            {hosts.value.slice(0, 8).map((h) => (
              <button key={h.id} onClick={() => openTerminal(h)}>
                {h.name}
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }
  const grid = layout.value === 'grid' && list.length > 1;
  const n = list.length;
  const cols = grid ? (n <= 2 ? n : n <= 4 ? 2 : 3) : 1;
  const rows = grid ? Math.ceil(n / cols) : 1;
  const showKeybar = prefs.value.keybar === 'always' || (prefs.value.keybar === 'auto' && isTouch());

  return (
    <div class="term-area" style={{ ['--term-bg' as string]: 'var(--bg)' }}>
      {search && <SearchBar onClose={() => setSearch(false)} />}
      <div class="term-grid" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`, gridTemplateRows: `repeat(${rows}, minmax(0, 1fr))` }}>
        {list.map((t) => (
          <div key={t.key} style={{ display: grid || activeTab.value === t.key ? 'contents' : 'none' }}>
            {(grid || activeTab.value === t.key) && <Pane t={t} showTitle={grid} />}
          </div>
        ))}
      </div>
      {showKeybar && <KeyBar onSearch={() => setSearch(true)} />}
    </div>
  );
}

// ------------------------------------------------------------------ mobile key bar
const ESC = '\x1b';
function arrow(c: string) {
  const ctrl = activeController();
  const app = ctrl?.term.modes.applicationCursorKeysMode;
  return app ? `${ESC}O${c}` : `${ESC}[${c}`;
}

export function KeyBar({ onSearch }: { onSearch: () => void }) {
  const [page, setPage] = useState(0);
  const send = (s: string) => {
    const c = activeController();
    if (!c) return;
    c.sendText(s);
  };
  const keepFocus = (e: Event) => e.preventDefault(); // don't steal focus → keyboard stays open
  const k = (label: preact.ComponentChildren, seq: string | (() => string), title?: string) => (
    <button onMouseDown={keepFocus} onTouchStart={() => {}} onClick={() => send(typeof seq === 'function' ? seq() : seq)} title={title}>
      {label}
    </button>
  );
  const pages = [
    <>
      {k('Esc', ESC)}
      {k('Tab', '\t')}
      <button class={stickyCtrl.value ? 'on' : ''} onMouseDown={keepFocus} onClick={() => (stickyCtrl.value = !stickyCtrl.value)}>
        Ctrl
      </button>
      <button class={stickyAlt.value ? 'on' : ''} onMouseDown={keepFocus} onClick={() => (stickyAlt.value = !stickyAlt.value)}>
        Alt
      </button>
      {k('←', () => arrow('D'))}
      {k('↑', () => arrow('A'))}
      {k('↓', () => arrow('B'))}
      {k('→', () => arrow('C'))}
      {k('^C', '\x03', 'Interrupt')}
      {k('^D', '\x04', 'EOF / logout')}
      {k('^Z', '\x1a', 'Suspend')}
      {k('^L', '\x0c', 'Clear')}
      {k('^R', '\x12', 'History search')}
      {k('|', '|')}
      {k('~', '~')}
      {k('/', '/')}
      {k('-', '-')}
    </>,
    <>
      {k('Home', `${ESC}[H`)}
      {k('End', `${ESC}[F`)}
      {k('PgUp', `${ESC}[5~`)}
      {k('PgDn', `${ESC}[6~`)}
      {k('Del', `${ESC}[3~`)}
      {['_', ':', ';', '=', '$', '&', '*', '>', '<', '"', "'", '`', '\\', '{', '}', '[', ']', '(', ')', '!', '#', '%', '^'].map((ch) => k(ch, ch))}
    </>,
    <>
      {['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12'].map((n) => {
        const codes: Record<string, string> = {
          '1': `${ESC}OP`, '2': `${ESC}OQ`, '3': `${ESC}OR`, '4': `${ESC}OS`, '5': `${ESC}[15~`, '6': `${ESC}[17~`,
          '7': `${ESC}[18~`, '8': `${ESC}[19~`, '9': `${ESC}[20~`, '10': `${ESC}[21~`, '11': `${ESC}[23~`, '12': `${ESC}[24~`,
        };
        return k(`F${n}`, codes[n]);
      })}
      {k('^A', '\x01', 'tmux/screen prefix, line start')}
      {k('^B', '\x02', 'tmux prefix')}
      {k('^E', '\x05', 'End of line')}
      {k('^W', '\x17', 'Delete word')}
      {k('^U', '\x15', 'Delete to line start')}
    </>,
  ];
  return (
    <div class="keybar" role="toolbar" aria-label="Extra keys">
      <button onMouseDown={keepFocus} onClick={() => setPage((page + pages.length - 1) % pages.length)} title="Previous keys">
        <ChevronLeft size={16} />
      </button>
      {pages[page]}
      <button onMouseDown={keepFocus} onClick={() => setPage((page + 1) % pages.length)} title="More keys">
        <ChevronRight size={16} />
      </button>
      <button onMouseDown={keepFocus} onClick={() => activeController()?.pasteFromClipboard()} title="Paste">
        <Clipboard size={16} />
      </button>
      <button onMouseDown={keepFocus} onClick={onSearch} title="Search">
        <Search size={16} />
      </button>
      <button onMouseDown={keepFocus} onClick={() => runSnippetPicker()} title="Snippets">
        {'{ }'}
      </button>
      <button
        onMouseDown={keepFocus}
        onClick={() => {
          const sel = activeController()?.selection();
          helpQuery.value = sel?.trim().split('\n')[0] ?? '';
          sidePanel.value = 'help';
        }}
        title="Help"
      >
        <CircleHelp size={16} />
      </button>
      {me.value?.features.ai && (
        <button onMouseDown={keepFocus} onClick={() => (sidePanel.value = 'ai')} title="AI assistant">
          <Bot size={16} />
        </button>
      )}
      <button
        onClick={() => {
          const c = activeController();
          if (!c) return;
          const ta = c.term.textarea;
          if (document.activeElement === ta) ta?.blur();
          else c.focus();
        }}
        title="Show / hide keyboard"
      >
        <Keyboard size={16} />
      </button>
      <button onMouseDown={keepFocus} onClick={() => savePrefs({ fontSize: Math.max(8, prefs.value.fontSize - 1) }).then(() => activeController()?.applyPrefs())}>
        A−
      </button>
      <button onMouseDown={keepFocus} onClick={() => savePrefs({ fontSize: Math.min(32, prefs.value.fontSize + 1) }).then(() => activeController()?.applyPrefs())}>
        A+
      </button>
      <button onMouseDown={keepFocus} onClick={() => (layout.value = layout.value === 'grid' ? 'tabs' : 'grid')} title="Layout" class="hide-mobile">
        <Columns2 size={16} />
      </button>
    </div>
  );
}

/** Quick snippet picker for the active terminal (fills {{variables}}). */
export function runSnippetPicker() {
  snippetPickerOpen.value = true;
}

export async function insertSnippet(command: string, run: boolean) {
  const vars = snippetVars(command);
  let values: Record<string, string> = {};
  if (vars.length) {
    const r = await promptDialog({ title: 'Snippet variables', fields: vars.map((v) => ({ name: v.name, label: v.name, value: v.def, required: true })), confirmText: run ? 'Run' : 'Insert' });
    if (!r) return;
    values = r;
  }
  const cmd = fillSnippet(command, values);
  const c = activeController();
  if (!c) return;
  c.sendText(cmd.replace(/\n/g, '\r') + (run ? '\r' : ''));
  c.focus();
}

// ------------------------------------------------------------------ host key / auth prompts from the SSH connection
export function TerminalPrompts() {
  const p = pendingPrompt.value;
  const [values, setValues] = useState<string[]>([]);
  useEffect(() => setValues([]), [p?.requestId]);
  if (!p) return null;
  const c = getController(p.tabKey);
  const done = (payload: { accept?: boolean; responses?: string[] | null }) => {
    c?.answer(p.requestId, payload);
    pendingPrompt.value = null;
    setTimeout(() => c?.focus(), 50);
  };
  if (p.kind === 'hostkey') {
    const m = p.msg;
    return (
      <Modal
        title="Verify host key"
        onClose={() => done({ accept: false })}
        footer={
          <>
            <button onClick={() => done({ accept: false })}>Cancel</button>
            <button class="primary" onClick={() => done({ accept: true })}>
              Trust & connect
            </button>
          </>
        }
      >
        <p>
          First connection to <b>{m.hostName}</b>. The server identifies itself with this key:
        </p>
        <pre class="card mono small" style={{ wordBreak: 'break-all' }}>
          {m.keyType}
          {'\n'}
          {m.fingerprint}
        </pre>
        <p class="small dim mt">
          To be sure you're talking to the right machine, compare it on the server's console with <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code>. Once trusted, WebSSH refuses to connect if the key ever changes.
        </p>
      </Modal>
    );
  }
  const m = p.msg as { hostName: string; title: string; instructions: string; prompts: { prompt: string; echo: boolean }[] };
  const submit = (e?: Event) => {
    e?.preventDefault();
    done({ responses: m.prompts.map((_, i) => values[i] ?? '') });
  };
  return (
    <Modal
      title={m.title || 'Authentication'}
      onClose={() => done({ responses: null })}
      footer={
        <>
          <button onClick={() => done({ responses: null })}>Cancel</button>
          <button class="primary" onClick={() => submit()}>
            Continue
          </button>
        </>
      }
    >
      <form onSubmit={submit} class="col">
        <div class="dim small">{m.hostName}</div>
        {m.instructions && <p style={{ whiteSpace: 'pre-wrap' }}>{m.instructions}</p>}
        {m.prompts.map((pr, i) => (
          <label key={i}>
            {pr.prompt}
            <input
              type={pr.echo ? 'text' : 'password'}
              autoFocus={i === 0}
              value={values[i] ?? ''}
              autoComplete={pr.echo ? 'one-time-code' : 'current-password'}
              onInput={(e) => {
                const v = [...values];
                v[i] = e.currentTarget.value;
                setValues(v);
              }}
            />
          </label>
        ))}
        <button type="submit" class="hidden" />
      </form>
    </Modal>
  );
}

/** Explain helper used by toolbar buttons: local help for a command, AI for arbitrary output. */
export function explainSelection(useAi: boolean) {
  const c = activeController();
  const sel = c?.selection().trim() ?? '';
  if (!useAi) {
    helpQuery.value = sel.split('\n')[0] ?? '';
    sidePanel.value = 'help';
    return;
  }
  aiSeed.value = { text: sel ? `Explain this:\n\n${sel}` : 'Explain what is on my terminal screen and whether anything looks wrong.', mode: 'chat', context: sel ? undefined : c?.recentText(80) };
  sidePanel.value = 'ai';
}
