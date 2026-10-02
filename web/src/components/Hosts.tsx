import { useMemo, useState } from 'preact/hooks';
import { signal } from '@preact/signals';
import {
  ChevronDown, ChevronRight, Edit3, FileUp, FolderOpen, Gauge, Plus, Power, Search, Server, Share2, Star, TerminalSquare, Trash2, Wifi, Zap,
} from 'lucide-preact';
import { api } from '../api';
import { confirmDialog, focusHostId, go, hosts, isAdmin, keys, loadHosts, loadKeys, me, toast } from '../state';
import type { Host } from '../types';
import { classNames, hostLabel, timeAgo } from '../util';
import { openTerminal, tabs } from '../terminal/engine';
import { Empty, Modal, Spinner } from './common';

export const editingHost = signal<Host | 'new' | null>(null);
export const importOpen = signal(false);

const COLORS = ['', '#2f81f7', '#3fb950', '#d29922', '#f85149', '#a371f7', '#db61a2', '#39c5cf', '#f0883e'];

function collapsedGroups(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem('webssh.collapsed') ?? '[]'));
  } catch {
    return new Set();
  }
}

export function openFiles(h: Host) {
  focusHostId.value = h.id;
  go('files');
}
export function openDashboard(h: Host) {
  focusHostId.value = h.id;
  go('dashboard');
}

export async function wakeHost(h: Host) {
  try {
    const r = await api.post<{ targets: string[] }>(`/api/hosts/${h.id}/wol`);
    toast(`Magic packet sent to ${h.macAddress} (${r.targets.join(', ')})`, 'success');
  } catch (err) {
    toast((err as Error).message, 'error');
  }
}

/** Sidebar host list: search, favourites, collapsible groups. */
export function HostList({ onPick }: { onPick?: () => void }) {
  const [q, setQ] = useState('');
  const [collapsed, setCollapsed] = useState(collapsedGroups);
  const openCount = (id: string) => tabs.value.filter((t) => t.hostId === id && t.status !== 'closed').length;
  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return hosts.value.filter((h) => !s || [h.name, h.hostname, h.username, h.group, ...h.tags].some((x) => x.toLowerCase().includes(s)));
  }, [q, hosts.value]);
  const groups = useMemo(() => {
    const m = new Map<string, Host[]>();
    const favs = filtered.filter((h) => h.favorite);
    if (favs.length) m.set('★ Favorites', favs);
    for (const h of filtered) {
      if (h.favorite) continue;
      const g = h.group || 'Hosts';
      m.set(g, [...(m.get(g) ?? []), h]);
    }
    return [...m];
  }, [filtered]);

  const toggle = (g: string) => {
    const n = new Set(collapsed);
    if (n.has(g)) n.delete(g);
    else n.add(g);
    setCollapsed(n);
    localStorage.setItem('webssh.collapsed', JSON.stringify([...n]));
  };

  return (
    <>
      <div class="search row">
        <div class="grow" style={{ position: 'relative' }}>
          <Search size={14} style={{ position: 'absolute', left: 9, top: 10, color: 'var(--text-faint)' }} />
          <input placeholder="Search hosts…" value={q} onInput={(e) => setQ(e.currentTarget.value)} style={{ paddingLeft: 28 }} />
        </div>
        {me.value?.features.allowUserHosts && (
          <button class="icon" title="Add host" onClick={() => (editingHost.value = 'new')}>
            <Plus size={16} />
          </button>
        )}
      </div>
      <div class="host-list">
        {!hosts.value.length && (
          <div class="empty small">
            No hosts yet.
            <br />
            <button class="mt primary sm" onClick={() => (editingHost.value = 'new')}>
              <Plus size={14} /> Add your first host
            </button>
          </div>
        )}
        {groups.map(([g, list]) => (
          <div key={g}>
            <div class="group-label" onClick={() => toggle(g)}>
              {collapsed.has(g) && !q ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
              {g} <span class="faint">({list.length})</span>
            </div>
            {(!collapsed.has(g) || q) &&
              list.map((h) => (
                <div
                  key={h.id}
                  class="host-item"
                  onClick={() => {
                    openTerminal(h);
                    onPick?.();
                  }}
                  title={`Open terminal: ${hostLabel(h)}`}
                >
                  <span class="host-color" style={{ background: h.color || 'transparent' }} />
                  <div class="grow">
                    <div class="name truncate row" style={{ gap: 6 }}>
                      {h.name}
                      {openCount(h.id) > 0 && <span class="dot green" title={`${openCount(h.id)} open`} />}
                      {h.shared && <Share2 size={11} class="faint" />}
                    </div>
                    <div class="sub truncate">{hostLabel(h)}</div>
                  </div>
                  <div class="actions" onClick={(e) => e.stopPropagation()}>
                    <button class="sm ghost icon" title="Files" onClick={() => (openFiles(h), onPick?.())}>
                      <FolderOpen size={14} />
                    </button>
                    <button class="sm ghost icon" title="Dashboard" onClick={() => (openDashboard(h), onPick?.())}>
                      <Gauge size={14} />
                    </button>
                    {(h.owned || isAdmin.value) && (
                      <button class="sm ghost icon" title="Edit" onClick={() => (editingHost.value = h)}>
                        <Edit3 size={14} />
                      </button>
                    )}
                  </div>
                </div>
              ))}
          </div>
        ))}
      </div>
    </>
  );
}

/** Home page: host cards with quick actions. */
export function HostsPage() {
  const [q, setQ] = useState('');
  const list = hosts.value.filter((h) => !q || `${h.name} ${h.hostname} ${h.group} ${h.tags.join(' ')}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <div class="page">
      <div class="page-header">
        <h1>
          <Server size={22} /> Hosts
        </h1>
        <input placeholder="Filter…" value={q} onInput={(e) => setQ(e.currentTarget.value)} style={{ width: 200 }} />
        {me.value?.features.allowUserHosts && (
          <>
            <button onClick={() => (importOpen.value = true)}>
              <FileUp size={16} /> <span class="hide-mobile">Import ~/.ssh/config</span>
            </button>
            <button class="primary" onClick={() => (editingHost.value = 'new')}>
              <Plus size={16} /> Add host
            </button>
          </>
        )}
      </div>
      {!hosts.value.length ? (
        <Empty icon={<Server size={40} />} title="Add your first server">
          Add a host (IP or hostname), then connect. Tip: generate an SSH key under <b>Keys</b> and use "Install on host" to switch to key login.
        </Empty>
      ) : (
        <div class="card-grid">
          {list.map((h) => (
            <div class="card" key={h.id} style={{ borderTop: h.color ? `3px solid ${h.color}` : undefined }}>
              <div class="row between">
                <h3 class="truncate" style={{ margin: 0 }}>
                  {h.favorite && <Star size={14} fill="var(--yellow)" color="var(--yellow)" />}
                  {h.name}
                </h3>
                {h.group && <span class="badge">{h.group}</span>}
              </div>
              <div class="dim small mono truncate mt">{hostLabel(h)}</div>
              <div class="row wrap small mt" style={{ gap: 4 }}>
                <span class="badge">{h.authType === 'key' ? 'key' : h.authType === 'password' ? 'password' : 'ask'}</span>
                {h.jumpHostId && <span class="badge purple">via jump</span>}
                {h.shared && <span class="badge blue">shared</span>}
                {h.record && <span class="badge red">recorded</span>}
                {!h.hostKey && <span class="badge yellow">host key not verified</span>}
                {h.tags.map((t) => (
                  <span key={t} class="badge">
                    #{t}
                  </span>
                ))}
              </div>
              <div class="faint small mt">Last connected {timeAgo(h.lastConnectedAt)}</div>
              <div class="row wrap mt">
                <button class="primary sm" onClick={() => openTerminal(h)}>
                  <TerminalSquare size={14} /> Connect
                </button>
                <button class="sm" onClick={() => openFiles(h)}>
                  <FolderOpen size={14} /> Files
                </button>
                <button class="sm" onClick={() => openDashboard(h)}>
                  <Gauge size={14} /> Stats
                </button>
                {h.macAddress && (
                  <button class="sm" title="Wake-on-LAN" onClick={() => wakeHost(h)}>
                    <Zap size={14} />
                  </button>
                )}
                {(h.owned || isAdmin.value) && (
                  <button class="sm ghost icon" title="Edit" onClick={() => (editingHost.value = h)}>
                    <Edit3 size={14} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

type FormState = {
  name: string;
  hostname: string;
  port: string;
  username: string;
  authType: 'password' | 'key' | 'ask';
  password: string;
  keyId: string;
  jumpHostId: string;
  group: string;
  tags: string;
  color: string;
  notes: string;
  macAddress: string;
  startupCommand: string;
  shared: boolean;
  record: boolean;
  useSudo: boolean;
  favorite: boolean;
};

function initialForm(h: Host | null): FormState {
  return {
    name: h?.name ?? '',
    hostname: h?.hostname ?? '',
    port: String(h?.port ?? 22),
    username: h?.username ?? 'root',
    authType: h?.authType ?? (keys.value.length ? 'key' : 'password'),
    password: '',
    keyId: h?.keyId ?? keys.value[0]?.id ?? '',
    jumpHostId: h?.jumpHostId ?? '',
    group: h?.group ?? '',
    tags: h?.tags.join(', ') ?? '',
    color: h?.color ?? '',
    notes: h?.notes ?? '',
    macAddress: h?.macAddress ?? '',
    startupCommand: h?.startupCommand ?? '',
    shared: h?.shared ?? false,
    record: h?.record ?? false,
    useSudo: h?.useSudo ?? false,
    favorite: h?.favorite ?? false,
  };
}

export function HostFormModal() {
  const target = editingHost.value;
  const existing = target && target !== 'new' ? target : null;
  const [f, setF] = useState<FormState>(() => initialForm(existing));
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [test, setTest] = useState<any>(null);
  const [testing, setTesting] = useState(false);
  const set = (patch: Partial<FormState>) => setF({ ...f, ...patch });
  const close = () => (editingHost.value = null);
  const groups = [...new Set(hosts.value.map((h) => h.group).filter(Boolean))];

  const payload = () => ({
    name: f.name.trim() || f.hostname.trim(),
    hostname: f.hostname.trim(),
    port: Number(f.port) || 22,
    username: f.username.trim(),
    authType: f.authType,
    password: f.authType === 'password' ? (f.password ? f.password : existing?.hasPassword ? undefined : '') : undefined,
    keyId: f.authType === 'key' ? f.keyId || null : null,
    jumpHostId: f.jumpHostId || null,
    group: f.group.trim(),
    tags: f.tags.split(',').map((t) => t.trim()).filter(Boolean),
    color: f.color || null,
    notes: f.notes,
    macAddress: f.macAddress.trim() || null,
    startupCommand: f.startupCommand.trim() || null,
    shared: f.shared,
    record: f.record,
    useSudo: f.useSudo,
    favorite: f.favorite,
  });

  const save = async (andConnect: boolean) => {
    setError('');
    setBusy(true);
    try {
      const h = existing ? await api.put<Host>(`/api/hosts/${existing.id}`, payload()) : await api.post<Host>('/api/hosts', payload());
      await loadHosts();
      toast(`Saved ${h.name}`, 'success');
      close();
      if (andConnect) openTerminal(h);
      return h;
    } catch (err) {
      setError((err as Error).message);
      return null;
    } finally {
      setBusy(false);
    }
  };

  const runTest = async (trustFingerprint?: string) => {
    if (!existing) return;
    setTesting(true);
    try {
      const r = await api.post(`/api/hosts/${existing.id}/test`, trustFingerprint ? { trustFingerprint } : {});
      setTest(r);
      if ((r as any).ok) await loadHosts();
    } catch (err) {
      setTest({ ok: false, message: (err as Error).message });
    } finally {
      setTesting(false);
    }
  };

  const remove = async () => {
    if (!existing) return;
    if (!(await confirmDialog({ title: `Delete ${existing.name}?`, message: 'Its saved credentials are removed. Open terminals to it are closed.', danger: true, confirmText: 'Delete' }))) return;
    await api.del(`/api/hosts/${existing.id}`);
    await loadHosts();
    close();
  };

  const resetKey = async () => {
    if (!existing) return;
    if (
      !(await confirmDialog({
        title: 'Reset pinned host key?',
        message: 'Only do this if you know why the key changed (e.g. you reinstalled the server). You will be asked to verify the new fingerprint on next connect.',
        danger: true,
        confirmText: 'Reset',
      }))
    )
      return;
    await api.post(`/api/hosts/${existing.id}/reset-hostkey`);
    await loadHosts();
    toast('Host key reset', 'success');
  };

  return (
    <Modal
      title={existing ? `Edit ${existing.name}` : 'Add host'}
      icon={<Server size={18} />}
      onClose={close}
      size="wide"
      footer={
        <>
          {existing && (
            <button class="danger" onClick={remove} style={{ marginRight: 'auto' }}>
              <Trash2 size={14} /> Delete
            </button>
          )}
          <button onClick={close}>Cancel</button>
          <button onClick={() => save(false)} disabled={busy}>
            Save
          </button>
          <button class="primary" onClick={() => save(true)} disabled={busy}>
            Save & connect
          </button>
        </>
      }
    >
      <div class="col gap-lg">
        {error && <div class="alert error">{error}</div>}
        <div class="form-grid">
          <label>
            Hostname or IP *
            <input value={f.hostname} onInput={(e) => set({ hostname: e.currentTarget.value })} placeholder="192.168.1.10 or nas.lan" autoFocus={!existing} autoCapitalize="off" />
          </label>
          <label>
            Port
            <input type="number" value={f.port} onInput={(e) => set({ port: e.currentTarget.value })} min={1} max={65535} />
          </label>
          <label>
            Username *
            <input value={f.username} onInput={(e) => set({ username: e.currentTarget.value })} autoCapitalize="off" />
          </label>
          <label>
            Display name
            <input value={f.name} onInput={(e) => set({ name: e.currentTarget.value })} placeholder={f.hostname || 'My server'} />
          </label>
        </div>

        <div class="form-grid">
          <label>
            Authentication
            <select value={f.authType} onChange={(e) => set({ authType: e.currentTarget.value as FormState['authType'] })}>
              <option value="key">SSH key (recommended)</option>
              <option value="password">Saved password (encrypted)</option>
              <option value="ask">Ask every time</option>
            </select>
          </label>
          {f.authType === 'key' && (
            <label>
              Key
              <select value={f.keyId} onChange={(e) => set({ keyId: e.currentTarget.value })}>
                {!keys.value.length && <option value="">No keys — create one under Keys</option>}
                {keys.value.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name} ({k.type})
                  </option>
                ))}
              </select>
            </label>
          )}
          {f.authType === 'password' && (
            <label>
              Password
              <input type="password" value={f.password} onInput={(e) => set({ password: e.currentTarget.value })} placeholder={existing?.hasPassword ? '•••••• (unchanged)' : ''} autoComplete="new-password" />
            </label>
          )}
          <label>
            Jump host (bastion)
            <select value={f.jumpHostId} onChange={(e) => set({ jumpHostId: e.currentTarget.value })}>
              <option value="">— direct connection —</option>
              {hosts.value
                .filter((h) => h.id !== existing?.id)
                .map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name}
                  </option>
                ))}
            </select>
          </label>
        </div>

        <div class="form-grid">
          <label>
            Group
            <input list="host-groups" value={f.group} onInput={(e) => set({ group: e.currentTarget.value })} placeholder="e.g. Proxmox, NAS, Pis" />
            <datalist id="host-groups">
              {groups.map((g) => (
                <option key={g} value={g} />
              ))}
            </datalist>
          </label>
          <label>
            Tags (comma separated)
            <input value={f.tags} onInput={(e) => set({ tags: e.currentTarget.value })} placeholder="docker, media" />
          </label>
          <label>
            Wake-on-LAN MAC
            <input value={f.macAddress} onInput={(e) => set({ macAddress: e.currentTarget.value })} placeholder="aa:bb:cc:dd:ee:ff" class="code" />
          </label>
          <label>
            Color
            <div class="row" style={{ gap: 4 }}>
              {COLORS.map((c) => (
                <button
                  key={c || 'none'}
                  type="button"
                  class={classNames('sm icon', f.color === c && 'active')}
                  style={{ background: c || 'transparent', width: 26, minWidth: 26 }}
                  onClick={() => set({ color: c })}
                  title={c || 'none'}
                >
                  {!c && '∅'}
                </button>
              ))}
            </div>
          </label>
        </div>

        <label>
          Startup command (runs after login)
          <input class="code" value={f.startupCommand} onInput={(e) => set({ startupCommand: e.currentTarget.value })} placeholder="tmux new -As main" />
          <span class="field-help">Tip: "tmux new -As main" gives you a persistent session that survives everything.</span>
        </label>

        <label>
          Notes
          <textarea value={f.notes} onInput={(e) => set({ notes: e.currentTarget.value })} rows={2} />
        </label>

        <div class="row wrap gap-lg">
          <label class="check">
            <input type="checkbox" checked={f.favorite} onChange={(e) => set({ favorite: e.currentTarget.checked })} /> Favorite
          </label>
          <label class="check" title="Allow sudo -n for service management, file editing and power actions">
            <input type="checkbox" checked={f.useSudo} onChange={(e) => set({ useSudo: e.currentTarget.checked })} /> Use passwordless sudo for admin actions
          </label>
          {me.value?.features.recording === 'per-host' && (
            <label class="check">
              <input type="checkbox" checked={f.record} onChange={(e) => set({ record: e.currentTarget.checked })} /> Record terminal sessions
            </label>
          )}
          {isAdmin.value && (
            <label class="check">
              <input type="checkbox" checked={f.shared} onChange={(e) => set({ shared: e.currentTarget.checked })} /> Share with all users
            </label>
          )}
        </div>

        {existing && (
          <div class="card">
            <h3>
              <Wifi size={16} /> Connection & host key
            </h3>
            {existing.hostKey ? (
              <p class="small">
                Pinned host key: <code>{existing.hostKey.type}</code> <code style={{ wordBreak: 'break-all' }}>{existing.hostKey.fingerprint}</code>
                <br />
                <span class="faint">Verify on the server with: </span>
                <code>ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub</code>
              </p>
            ) : (
              <p class="small dim">The host key is not verified yet. Test the connection to see its fingerprint and pin it.</p>
            )}
            <div class="row wrap">
              <button onClick={() => runTest()} disabled={testing}>
                {testing ? <Spinner /> : <Power size={14} />} Test connection
              </button>
              {existing.hostKey && (
                <button class="danger" onClick={resetKey}>
                  Reset pinned key
                </button>
              )}
            </div>
            {test && (
              <div class={classNames('alert mt small', test.ok ? 'success' : 'error')}>
                {test.ok ? (
                  <>
                    Connected in {test.latencyMs} ms
                    <pre class="mono">{test.output}</pre>
                  </>
                ) : (
                  <>
                    {test.message}
                    {test.code === 'HOST_KEY_UNKNOWN' && test.hostKey && (
                      <div class="mt">
                        Server presented <code>{test.hostKey.keyType}</code> <code style={{ wordBreak: 'break-all' }}>{test.hostKey.fingerprint}</code>
                        <div class="row mt">
                          <button class="primary sm" onClick={() => runTest(test.hostKey.fingerprint)}>
                            Trust this fingerprint
                          </button>
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}

export function ImportModal() {
  const [text, setText] = useState('');
  const [keyId, setKeyId] = useState('');
  const [group, setGroup] = useState('Imported');
  const [result, setResult] = useState<string>('');
  const [error, setError] = useState('');
  const close = () => (importOpen.value = false);
  const run = async () => {
    setError('');
    try {
      const r = await api.post<{ created: number; skipped: string[] }>('/api/hosts/import', { config: text, keyId: keyId || null, group });
      setResult(`Imported ${r.created} host(s).${r.skipped.length ? ` Skipped existing: ${r.skipped.join(', ')}` : ''}`);
      await loadHosts();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  if (!keys.value.length) void loadKeys();
  return (
    <Modal
      title="Import from ~/.ssh/config"
      onClose={close}
      size="wide"
      footer={
        <>
          <button onClick={close}>Close</button>
          <button class="primary" onClick={run} disabled={!text.trim()}>
            Import
          </button>
        </>
      }
    >
      <div class="col">
        <p class="dim small">
          Paste your OpenSSH client config. <code>Host</code>, <code>HostName</code>, <code>User</code>, <code>Port</code> and <code>ProxyJump</code> are imported; wildcard entries are skipped. Private key files are not uploaded — pick a key stored in WebSSH, or hosts will ask for a password.
        </p>
        {error && <div class="alert error">{error}</div>}
        {result && <div class="alert success">{result}</div>}
        <textarea class="code" rows={12} value={text} onInput={(e) => setText(e.currentTarget.value)} placeholder={'Host nas\n  HostName 192.168.1.10\n  User admin\n\nHost pve\n  HostName 192.168.1.2\n  User root'} />
        <div class="form-grid">
          <label>
            Authenticate with key
            <select value={keyId} onChange={(e) => setKeyId(e.currentTarget.value)}>
              <option value="">Ask for password</option>
              {keys.value.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Group
            <input value={group} onInput={(e) => setGroup(e.currentTarget.value)} />
          </label>
        </div>
      </div>
    </Modal>
  );
}
