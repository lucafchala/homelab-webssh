import { signal } from '@preact/signals';
import { useEffect, useRef, useState } from 'preact/hooks';
import { AlertTriangle, Bot, Check, Pencil, Play, Plus, Send, ShieldAlert, Square, TerminalSquare, X } from 'lucide-preact';
import { api, streamSse } from '../api';
import { aiSeed, confirmDialog, hostById, me, prefs, savePrefs, toast } from '../state';
import { activeController, activeTab, tabs } from '../terminal/engine';
import type { AiMessage, AiToolCall, ExecResult, Risk } from '../types';
import { classNames } from '../util';
import { insertIntoTerminal, Markdown, Segmented } from './common';

type Mode = 'chat' | 'agent' | 'generate';

interface ToolState {
  call: AiToolCall;
  valid: boolean;
  error?: string;
  risk?: { risk: Risk; reasons: string[] };
  status: 'pending' | 'running' | 'done' | 'rejected';
  result?: ExecResult;
  edited?: string;
}

interface Convo {
  messages: AiMessage[];
  tools: Record<string, ToolState>;
  /** Thinking summaries per assistant message index. */
  thinking: Record<number, string>;
  hostId: string | null;
}

const convo = signal<Convo>({ messages: [], tools: {}, thinking: {}, hostId: null });
const mode = signal<Mode>('chat');
const MAX_AGENT_STEPS = 12;

function currentHostId(): string | null {
  return tabs.value.find((t) => t.key === activeTab.value)?.hostId ?? null;
}

function toolResultText(r: ExecResult): string {
  const cap = (s: string) => (s.length > 16000 ? s.slice(0, 8000) + '\n…[truncated]…\n' + s.slice(-8000) : s);
  let out = `exit code: ${r.code ?? 'none'}${r.timedOut ? ' (timed out)' : ''}${r.signal ? ` signal ${r.signal}` : ''}`;
  if (r.stdout) out += `\n--- stdout ---\n${cap(r.stdout)}`;
  if (r.stderr) out += `\n--- stderr ---\n${cap(r.stderr)}`;
  if (!r.stdout && !r.stderr) out += '\n(no output)';
  if (r.truncated) out += '\n(output truncated)';
  return out;
}

function RiskBadge({ risk }: { risk?: { risk: Risk; reasons: string[] } }) {
  if (!risk) return null;
  const cls = risk.risk === 'read' ? 'green' : risk.risk === 'write' ? 'yellow' : 'red';
  const label = risk.risk === 'read' ? 'read-only' : risk.risk === 'write' ? 'changes state' : 'DANGEROUS';
  return (
    <span class={`badge ${cls}`} title={risk.reasons.join('; ')}>
      {risk.risk === 'dangerous' && <ShieldAlert size={11} />} {label}
    </span>
  );
}

export function AiPanel() {
  const c = convo.value;
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [streamText, setStreamText] = useState('');
  const [streamThinking, setStreamThinking] = useState('');
  const [error, setError] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const stepsRef = useRef(0);
  const bottomRef = useRef<HTMLDivElement>(null);
  const features = me.value?.features;
  const hostId = currentHostId();
  const host = hostById(hostId);

  useEffect(() => bottomRef.current?.scrollIntoView({ block: 'end' }), [c.messages.length, streamText, busy]);

  // Seeded requests (from Help "Ask AI", terminal "Explain", palette)
  useEffect(() => {
    const seed = aiSeed.value;
    if (!seed || busy) return;
    aiSeed.value = null;
    if (seed.mode) mode.value = seed.mode;
    void send(seed.text, seed.context);
  }, [aiSeed.value]);

  const patch = (p: Partial<Convo>) => (convo.value = { ...convo.value, ...p });

  async function stream(withContext?: string) {
    setBusy(true);
    setError('');
    setStreamText('');
    setStreamThinking('');
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    let thinking = '';
    let done: any = null;
    try {
      await streamSse(
        '/api/ai/chat',
        { mode: mode.value, hostId: convo.value.hostId, messages: convo.value.messages, terminalContext: withContext },
        (e) => {
          if (e.type === 'text') setStreamText((t) => t + e.delta);
          else if (e.type === 'thinking') {
            thinking += e.delta;
            setStreamThinking(thinking);
          } else if (e.type === 'error') setError(e.message);
          else if (e.type === 'done') {
            done = e;
            const msgs = [...convo.value.messages, e.message as AiMessage];
            const tools = { ...convo.value.tools };
            for (const tc of e.toolCalls ?? []) {
              tools[tc.id] = { call: { id: tc.id, name: tc.name, input: tc.input }, valid: tc.valid, error: tc.error, risk: tc.risk, status: 'pending' };
            }
            patch({ messages: msgs, tools, thinking: thinking ? { ...convo.value.thinking, [msgs.length - 1]: thinking } : convo.value.thinking });
          }
        },
        ctrl.signal,
      );
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError((err as Error).message);
    } finally {
      setBusy(false);
      setStreamText('');
      setStreamThinking('');
      abortRef.current = null;
    }
    // Follow-ups run after this turn has fully finished streaming.
    if (done) {
      // Invalid tool input: answer with an error result straight away so the model can retry.
      for (const tc of done.toolCalls ?? []) if (!tc.valid) await resolveTool(tc.id, 'error', tc.error);
      if (done.autoApproveReadOnly && prefsAutoApprove()) {
        for (const tc of done.toolCalls ?? []) if (tc.valid && tc.risk?.risk === 'read') await runTool(tc.id);
      }
    }
  }

  async function send(text: string, context?: string) {
    const t = text.trim();
    if (!t || busy) return;
    if (mode.value === 'agent' && !currentHostId()) {
      setError('Agent mode works on the host of the active terminal — open a terminal first.');
      return;
    }
    stepsRef.current = 0;
    const ctl = activeController();
    const ctx = context ?? (prefs.value.aiIncludeContext && ctl ? ctl.recentText(100) : undefined);
    patch({ messages: [...convo.value.messages, { role: 'user', content: t }], hostId: currentHostId() ?? convo.value.hostId });
    setInput('');
    await stream(ctx || undefined);
  }

  /** Append a tool result; when every pending call of the last turn is resolved, continue the loop. */
  async function resolveTool(id: string, outcome: 'done' | 'rejected' | 'error', text?: string, result?: ExecResult) {
    const cur = convo.value;
    const tools = { ...cur.tools, [id]: { ...cur.tools[id], status: outcome === 'error' ? 'done' : outcome, result } as ToolState };
    const content =
      outcome === 'rejected' ? 'The user declined to run this command.' : outcome === 'error' ? `Error: ${text ?? 'invalid tool call'}` : (text ?? '');
    const messages: AiMessage[] = [...cur.messages, { role: 'tool', toolCallId: id, content, isError: outcome !== 'done' }];
    patch({ tools, messages });
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant') as Extract<AiMessage, { role: 'assistant' }> | undefined;
    const pending = (lastAssistant?.toolCalls ?? []).filter((tc) => tools[tc.id]?.status === 'pending' || tools[tc.id]?.status === 'running');
    if (pending.length) return;
    const anyRan = (lastAssistant?.toolCalls ?? []).some((tc) => tools[tc.id]?.status === 'done');
    if (anyRan) {
      stepsRef.current++;
      if (stepsRef.current >= MAX_AGENT_STEPS) {
        setError(`Paused after ${MAX_AGENT_STEPS} steps — send a message to let the agent continue.`);
        return;
      }
      await stream();
    }
  }

  async function runTool(id: string, confirmDangerous = false) {
    const ts = convo.value.tools[id];
    if (!ts || ts.status !== 'pending') return;
    const command = ts.edited ?? String(ts.call.input.command ?? '');
    const hid = convo.value.hostId;
    if (!hid) return;
    if (ts.risk?.risk === 'dangerous' && !confirmDangerous) {
      const ok = await confirmDialog({
        title: 'Run a potentially destructive command?',
        message: `${command}\n\nFlagged because: ${ts.risk.reasons.join('; ')}`,
        danger: true,
        confirmText: 'Run it',
        typeToConfirm: hostById(hid)?.name ?? 'yes',
      });
      if (!ok) return;
      confirmDangerous = true;
    }
    convo.value = { ...convo.value, tools: { ...convo.value.tools, [id]: { ...ts, status: 'running' } } };
    try {
      const timeoutSec = Math.min(600, Math.max(1, Number(ts.call.input.timeout_seconds) || 60));
      const r = await api.post<ExecResult>(`/api/hosts/${hid}/exec`, { command, timeoutSec, source: 'ai', confirmDangerous });
      const note = ts.edited ? `(The user edited the command before running it. Actually ran: ${command})\n` : '';
      await resolveTool(id, 'done', note + toolResultText(r), r);
    } catch (err) {
      convo.value = { ...convo.value, tools: { ...convo.value.tools, [id]: { ...ts, status: 'pending' } } };
      toast((err as Error).message, 'error');
    }
  }

  const reset = () => {
    abortRef.current?.abort();
    convo.value = { messages: [], tools: {}, thinking: {}, hostId: currentHostId() };
    setError('');
  };

  if (!features?.ai) {
    return (
      <div class="col">
        <div class="alert info">
          The AI assistant is not configured. An admin can enable it under <b>Admin → Settings</b>: use <b>Ollama</b> for a free model running on your own hardware, or a Claude / OpenAI-compatible API key.
        </div>
        <p class="small dim">The offline Help panel covers everyday commands without any AI.</p>
      </div>
    );
  }

  const lastAssistantIdx = c.messages.map((m) => m.role).lastIndexOf('assistant');

  return (
    <div class="col" style={{ height: '100%', gap: 0 }}>
      <div class="col" style={{ paddingBottom: 8, gap: 6 }}>
        <div class="row between">
          <Segmented
            value={mode.value}
            onChange={(v) => (mode.value = v)}
            options={[
              { value: 'chat', label: 'Ask' },
              { value: 'generate', label: 'Command' },
              { value: 'agent', label: 'Agent' },
            ]}
          />
          <button class="sm ghost" onClick={reset} title="New conversation">
            <Plus size={14} /> New
          </button>
        </div>
        <div class="small faint">
          {mode.value === 'agent'
            ? `Agent proposes commands on ${host?.name ?? '— open a terminal —'}; nothing runs without your approval.`
            : mode.value === 'generate'
              ? 'Describe a task; get a command to insert into your terminal.'
              : 'Ask anything about your homelab.'}{' '}
          {features.aiModel && <span>({features.aiModel})</span>}
        </div>
      </div>

      <div class="chat grow" style={{ overflowY: 'auto', minHeight: 0, paddingBottom: 12 }}>
        {!c.messages.length && !busy && (
          <div class="empty small">
            <Bot size={32} />
            <div>
              Try: <i>"why is nginx returning 502?"</i>, <i>"set up a daily ZFS snapshot"</i>, or select an error in the terminal and press <b>Explain</b>.
            </div>
          </div>
        )}
        {c.messages.map((m, i) => {
          if (m.role === 'user') {
            return (
              <div key={i} class="msg user">
                {m.content}
              </div>
            );
          }
          if (m.role === 'tool') return null;
          return (
            <div key={i} class="msg assistant col">
              {c.thinking[i] && (
                <details>
                  <summary class="small faint" style={{ cursor: 'pointer' }}>
                    Reasoning
                  </summary>
                  <div class="thinking">{c.thinking[i]}</div>
                </details>
              )}
              {m.content && <Markdown text={m.content} onRun={(cmd) => runInTerminal(cmd)} />}
              {(m.toolCalls ?? []).map((tc) => {
                const ts = c.tools[tc.id];
                if (!ts) return null;
                return <ToolCard key={tc.id} ts={ts} canAct={i === lastAssistantIdx} onRun={() => runTool(tc.id)} onReject={() => resolveTool(tc.id, 'rejected')} onEdit={(v) => (convo.value = { ...convo.value, tools: { ...convo.value.tools, [tc.id]: { ...ts, edited: v } } })} />;
              })}
            </div>
          );
        })}
        {busy && (
          <div class="msg assistant col">
            {streamThinking && !streamText && <div class="thinking">{streamThinking.slice(-600)}</div>}
            {streamText ? <Markdown text={streamText} /> : <span class="row dim small"><span class="spinner" /> Thinking…</span>}
          </div>
        )}
        {error && <div class="alert error small">{error}</div>}
        <div ref={bottomRef} />
      </div>

      <div class="composer" style={{ margin: '0 -12px -12px' }}>
        <textarea
          value={input}
          placeholder={mode.value === 'agent' ? 'Tell the agent what to do…' : mode.value === 'generate' ? 'e.g. find files over 1 GB modified this week' : 'Ask a question…'}
          onInput={(e) => setInput(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
              e.preventDefault();
              void send(input);
            }
          }}
          rows={2}
        />
        <div class="row between">
          <label class="check small" title="Send the last 100 lines of the active terminal with your message">
            <input type="checkbox" checked={prefs.value.aiIncludeContext} onChange={(e) => savePrefs({ aiIncludeContext: e.currentTarget.checked })} />
            Include terminal output
          </label>
          {busy ? (
            <button class="sm" onClick={() => abortRef.current?.abort()}>
              <Square size={12} /> Stop
            </button>
          ) : (
            <button class="primary sm" onClick={() => send(input)} disabled={!input.trim()}>
              <Send size={14} /> Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function prefsAutoApprove(): boolean {
  try {
    return localStorage.getItem('webssh.ai.autoread') === '1';
  } catch {
    return false;
  }
}

function ToolCard({ ts, canAct, onRun, onReject, onEdit }: { ts: ToolState; canAct: boolean; onRun: () => void; onReject: () => void; onEdit: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const cmd = ts.edited ?? String(ts.call.input.command ?? '');
  const explanation = String(ts.call.input.explanation ?? '');
  const [auto, setAuto] = useState(prefsAutoApprove());
  return (
    <div class={classNames('tool-card', ts.risk?.risk === 'dangerous' && 'dangerous')}>
      <div class="tc-head">
        <TerminalSquare size={13} />
        <span class="grow">{explanation || 'Run command'}</span>
        <RiskBadge risk={ts.risk} />
      </div>
      {!ts.valid ? (
        <div class="alert error small" style={{ margin: 8 }}>
          {ts.error}
        </div>
      ) : editing ? (
        <div style={{ padding: 8 }}>
          <textarea class="code" value={cmd} onInput={(e) => onEdit(e.currentTarget.value)} rows={3} />
          <button class="sm mt" onClick={() => setEditing(false)}>
            Done
          </button>
        </div>
      ) : (
        <pre class="cmd mono">{cmd}</pre>
      )}
      {ts.risk?.risk === 'dangerous' && (
        <div class="small row" style={{ color: 'var(--red)', padding: '0 10px' }}>
          <AlertTriangle size={13} /> {ts.risk.reasons.join('; ')}
        </div>
      )}
      {ts.status === 'pending' && canAct && ts.valid && (
        <div class="tc-actions">
          <button class={ts.risk?.risk === 'dangerous' ? 'danger solid sm' : 'primary sm'} onClick={onRun}>
            <Play size={13} /> Run
          </button>
          <button class="sm" onClick={() => setEditing(!editing)}>
            <Pencil size={13} /> Edit
          </button>
          <button class="sm" onClick={() => (insertIntoTerminal(cmd), onReject())} title="Put it in your terminal to run yourself">
            <TerminalSquare size={13} /> In terminal
          </button>
          <button class="sm ghost" onClick={onReject}>
            <X size={13} /> Reject
          </button>
          {me.value?.features.aiAutoApproveReadOnly && (
            <label class="check small" style={{ marginLeft: 'auto' }} title="Run read-only commands (ls, cat, df, docker ps…) without asking">
              <input
                type="checkbox"
                checked={auto}
                onChange={(e) => {
                  setAuto(e.currentTarget.checked);
                  localStorage.setItem('webssh.ai.autoread', e.currentTarget.checked ? '1' : '0');
                }}
              />
              auto-run read-only
            </label>
          )}
        </div>
      )}
      {ts.status === 'running' && (
        <div class="tc-actions small dim">
          <span class="spinner" /> Running…
        </div>
      )}
      {ts.status === 'rejected' && <div class="tc-actions small faint">Not run.</div>}
      {ts.result && (
        <details open={ts.result.code !== 0}>
          <summary class="small" style={{ cursor: 'pointer', padding: '4px 10px' }}>
            {ts.result.code === 0 ? <Check size={12} color="var(--green)" /> : <X size={12} color="var(--red)" />} exit {ts.result.code ?? '?'} · {ts.result.durationMs} ms
          </summary>
          <div class="output">
            {ts.result.stdout}
            {ts.result.stderr && <span style={{ color: 'var(--red)' }}>{ts.result.stderr}</span>}
            {!ts.result.stdout && !ts.result.stderr && <span class="faint">(no output)</span>}
          </div>
        </details>
      )}
    </div>
  );
}

async function runInTerminal(cmd: string) {
  let risk: { risk: Risk; reasons: string[] } | null = null;
  try {
    risk = await api.post('/api/ai/classify', { command: cmd });
  } catch {
    /* ignore */
  }
  const ok = await confirmDialog({
    title: risk?.risk === 'dangerous' ? 'Run a potentially destructive command?' : 'Run in terminal?',
    message: `${cmd}${risk?.reasons.length ? `\n\nNote: ${risk.reasons.join('; ')}` : ''}`,
    danger: risk?.risk === 'dangerous',
    confirmText: 'Run',
  });
  if (ok) insertIntoTerminal(cmd, true);
}
