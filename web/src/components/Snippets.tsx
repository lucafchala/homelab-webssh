import { signal } from '@preact/signals';
import { useState } from 'preact/hooks';
import { Braces, Edit3, Play, Plus, Search, Server, TerminalSquare, Trash2 } from 'lucide-preact';
import { api } from '../api';
import { confirmDialog, hosts, isAdmin, loadSnippets, promptDialog, snippets, toast } from '../state';
import type { ExecResult, Snippet } from '../types';
import { classNames, fillSnippet, snippetVars } from '../util';
import { CopyButton, Empty, Modal } from './common';
import { insertSnippet } from './Terminal';

export const snippetPickerOpen = signal(false);

async function fillVars(command: string): Promise<string | null> {
  const vars = snippetVars(command);
  if (!vars.length) return command;
  const r = await promptDialog({ title: 'Snippet variables', fields: vars.map((v) => ({ name: v.name, label: v.name, value: v.def, required: true })), confirmText: 'Continue' });
  return r ? fillSnippet(command, r) : null;
}

/** Quick searchable picker used from the key bar / palette. */
export function SnippetPicker() {
  const [q, setQ] = useState('');
  if (!snippetPickerOpen.value) return null;
  const list = snippets.value.filter((s) => !q || `${s.name} ${s.command} ${s.tags.join(' ')}`.toLowerCase().includes(q.toLowerCase()));
  const close = () => (snippetPickerOpen.value = false);
  return (
    <Modal title="Snippets" icon={<Braces size={18} />} onClose={close}>
      <input autoFocus placeholder="Search snippets…" value={q} onInput={(e) => setQ(e.currentTarget.value)} class="mb" />
      {!snippets.value.length && <div class="empty small">No snippets yet — create them on the Snippets page.</div>}
      <div class="col">
        {list.map((s) => (
          <div key={s.id} class="card row" style={{ padding: 10 }}>
            <div class="grow" style={{ minWidth: 0 }}>
              <b>{s.name}</b>
              <pre class="small mono dim truncate">{s.command}</pre>
            </div>
            <button class="sm" onClick={() => (close(), insertSnippet(s.command, false))} title="Insert without running">
              <TerminalSquare size={14} />
            </button>
            <button class="sm primary" onClick={() => (close(), insertSnippet(s.command, true))} title="Run in terminal">
              <Play size={14} />
            </button>
          </div>
        ))}
      </div>
    </Modal>
  );
}

function SnippetForm({ s, onClose }: { s: Snippet | null; onClose: () => void }) {
  const [f, setF] = useState({ name: s?.name ?? '', command: s?.command ?? '', description: s?.description ?? '', tags: s?.tags.join(', ') ?? '', shared: s?.shared ?? false });
  const [error, setError] = useState('');
  const save = async () => {
    try {
      const body = { ...f, tags: f.tags.split(',').map((t) => t.trim()).filter(Boolean) };
      if (s) await api.put(`/api/snippets/${s.id}`, body);
      else await api.post('/api/snippets', body);
      await loadSnippets();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Modal
      title={s ? 'Edit snippet' : 'New snippet'}
      onClose={onClose}
      size="wide"
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button class="primary" onClick={save} disabled={!f.name.trim() || !f.command.trim()}>
            Save
          </button>
        </>
      }
    >
      <div class="col">
        {error && <div class="alert error">{error}</div>}
        <label>
          Name
          <input value={f.name} onInput={(e) => setF({ ...f, name: e.currentTarget.value })} autoFocus placeholder="Restart a compose stack" />
        </label>
        <label>
          Command
          <textarea class="code" rows={5} value={f.command} onInput={(e) => setF({ ...f, command: e.currentTarget.value })} placeholder="cd ~/docker/{{stack}} && docker compose pull && docker compose up -d" />
          <span class="field-help">
            Use <code>{'{{name}}'}</code> or <code>{'{{name:default}}'}</code> for values you're asked for when running it.
          </span>
        </label>
        <label>
          Description
          <input value={f.description} onInput={(e) => setF({ ...f, description: e.currentTarget.value })} />
        </label>
        <label>
          Tags
          <input value={f.tags} onInput={(e) => setF({ ...f, tags: e.currentTarget.value })} placeholder="docker, maintenance" />
        </label>
        {isAdmin.value && (
          <label class="check">
            <input type="checkbox" checked={f.shared} onChange={(e) => setF({ ...f, shared: e.currentTarget.checked })} /> Share with all users
          </label>
        )}
      </div>
    </Modal>
  );
}

function MultiRun({ s, onClose }: { s: Snippet; onClose: () => void }) {
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Record<string, { status: 'running' | 'done' | 'error'; r?: ExecResult; error?: string }>>({});
  const [running, setRunning] = useState(false);
  const run = async () => {
    const cmd = await fillVars(s.command);
    if (!cmd) return;
    const risk = await api.post<{ risk: string; reasons: string[] }>('/api/ai/classify', { command: cmd });
    let confirmDangerous = false;
    if (risk.risk === 'dangerous') {
      if (!(await confirmDialog({ title: 'Run a destructive command on several hosts?', message: `${cmd}\n\n${risk.reasons.join('; ')}`, danger: true, typeToConfirm: 'run', confirmText: 'Run' }))) return;
      confirmDangerous = true;
    }
    setRunning(true);
    const ids = [...sel];
    setResults(Object.fromEntries(ids.map((id) => [id, { status: 'running' as const }])));
    await Promise.all(
      ids.map(async (id) => {
        try {
          const r = await api.post<ExecResult>(`/api/hosts/${id}/exec`, { command: cmd, timeoutSec: 300, source: 'snippet', confirmDangerous });
          setResults((x) => ({ ...x, [id]: { status: 'done', r } }));
        } catch (err) {
          setResults((x) => ({ ...x, [id]: { status: 'error', error: (err as Error).message } }));
        }
      }),
    );
    setRunning(false);
  };
  return (
    <Modal
      title={`Run "${s.name}" on hosts`}
      icon={<Server size={18} />}
      onClose={onClose}
      size="wide"
      footer={
        <>
          <button onClick={onClose}>Close</button>
          <button class="primary" disabled={!sel.size || running} onClick={run}>
            <Play size={14} /> Run on {sel.size} host(s)
          </button>
        </>
      }
    >
      <pre class="card mono small mb">{s.command}</pre>
      <div class="row wrap mb">
        <button class="sm" onClick={() => setSel(new Set(hosts.value.map((h) => h.id)))}>
          All
        </button>
        <button class="sm" onClick={() => setSel(new Set())}>
          None
        </button>
        {hosts.value.map((h) => (
          <label class="check small card" key={h.id} style={{ padding: '4px 8px' }}>
            <input
              type="checkbox"
              checked={sel.has(h.id)}
              onChange={() => {
                const n = new Set(sel);
                if (n.has(h.id)) n.delete(h.id);
                else n.add(h.id);
                setSel(n);
              }}
            />
            {h.name}
          </label>
        ))}
      </div>
      <div class="small faint mb">Runs non-interactively over SSH (no TTY). Hosts must have been connected once so their host key is trusted.</div>
      <div class="col">
        {Object.entries(results).map(([id, res]) => (
          <details key={id} open class="card" style={{ padding: 8 }}>
            <summary class="row" style={{ cursor: 'pointer' }}>
              <span class={classNames('dot', res.status === 'running' ? 'yellow pulse' : res.status === 'error' || (res.r && res.r.code !== 0) ? 'red' : 'green')} />
              <b>{hosts.value.find((h) => h.id === id)?.name}</b>
              <span class="small faint">{res.r ? `exit ${res.r.code} · ${res.r.durationMs} ms` : res.error}</span>
            </summary>
            {res.r && (
              <pre class="log-view mt">
                {res.r.stdout}
                {res.r.stderr && <span style={{ color: 'var(--red)' }}>{res.r.stderr}</span>}
              </pre>
            )}
          </details>
        ))}
      </div>
    </Modal>
  );
}

export function SnippetsPage() {
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<Snippet | 'new' | null>(null);
  const [multi, setMulti] = useState<Snippet | null>(null);
  const list = snippets.value.filter((s) => !q || `${s.name} ${s.command} ${s.description} ${s.tags.join(' ')}`.toLowerCase().includes(q.toLowerCase()));
  const remove = async (s: Snippet) => {
    if (!(await confirmDialog({ title: `Delete "${s.name}"?`, danger: true, confirmText: 'Delete' }))) return;
    await api.del(`/api/snippets/${s.id}`);
    await loadSnippets();
  };
  return (
    <div class="page">
      <div class="page-header">
        <h1>
          <Braces size={22} /> Snippets
        </h1>
        <div style={{ position: 'relative' }}>
          <Search size={14} style={{ position: 'absolute', left: 9, top: 10, color: 'var(--text-faint)' }} />
          <input placeholder="Search…" value={q} onInput={(e) => setQ(e.currentTarget.value)} style={{ paddingLeft: 28, width: 200 }} />
        </div>
        <button class="primary" onClick={() => setEditing('new')}>
          <Plus size={16} /> New snippet
        </button>
      </div>
      {!snippets.value.length ? (
        <Empty icon={<Braces size={40} />} title="Save the commands you type all the time">
          Snippets can be inserted into any terminal, or run on several hosts at once (e.g. <code>apt list --upgradable</code> across your fleet).
          <div class="mt">
            <button
              onClick={async () => {
                const examples = [
                  { name: 'Update compose stack', command: 'cd {{dir:~/docker}} && docker compose pull && docker compose up -d && docker image prune -f', tags: ['docker'] },
                  { name: 'Disk usage overview', command: 'df -hT -x tmpfs -x devtmpfs && echo && sudo du -xh / -d 1 2>/dev/null | sort -h | tail -10', tags: ['disk'] },
                  { name: 'Listening ports', command: 'sudo ss -tulpn', tags: ['network'] },
                  { name: 'Follow service logs', command: 'journalctl -u {{service}} -f', tags: ['logs'] },
                  { name: 'System update (Debian/Ubuntu)', command: 'sudo apt update && sudo apt full-upgrade -y && sudo apt autoremove -y', tags: ['updates'] },
                  { name: 'ZFS health', command: 'zpool status -x && zfs list -o name,used,avail,compressratio', tags: ['zfs'] },
                ];
                for (const e of examples) await api.post('/api/snippets', { ...e, description: '' });
                await loadSnippets();
                toast('Added example snippets', 'success');
              }}
            >
              Add some useful examples
            </button>
          </div>
        </Empty>
      ) : (
        <div class="card-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))' }}>
          {list.map((s) => (
            <div class="card col" key={s.id}>
              <div class="row between">
                <b class="truncate">{s.name}</b>
                <div class="row" style={{ gap: 2 }}>
                  {s.shared && <span class="badge blue">shared</span>}
                  {s.owned && (
                    <>
                      <button class="sm ghost icon" onClick={() => setEditing(s)}>
                        <Edit3 size={14} />
                      </button>
                      <button class="sm ghost icon" onClick={() => remove(s)}>
                        <Trash2 size={14} />
                      </button>
                    </>
                  )}
                </div>
              </div>
              {s.description && <div class="small dim">{s.description}</div>}
              <pre class="mono small" style={{ background: 'var(--bg)', padding: 8, borderRadius: 6, maxHeight: 120, overflow: 'auto' }}>
                {s.command}
              </pre>
              <div class="row wrap">
                {s.tags.map((t) => (
                  <span class="badge" key={t}>
                    #{t}
                  </span>
                ))}
                <span class="grow" />
                <CopyButton text={s.command} />
                <button class="sm" onClick={() => insertSnippet(s.command, false)} title="Insert into the active terminal">
                  <TerminalSquare size={14} />
                </button>
                <button class="sm" onClick={() => setMulti(s)} title="Run on one or more hosts">
                  <Server size={14} /> Run on…
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {editing && <SnippetForm s={editing === 'new' ? null : editing} onClose={() => setEditing(null)} />}
      {multi && <MultiRun s={multi} onClose={() => setMulti(null)} />}
    </div>
  );
}
