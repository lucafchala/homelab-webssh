import { useEffect, useState } from 'preact/hooks';
import { Bot, ClipboardList, MonitorUp, Shield, Trash2, UserPlus, Users } from 'lucide-preact';
import { api } from '../api';
import { confirmDialog, loadMe, me, promptDialog, toast } from '../state';
import type { User } from '../types';
import { classNames, formatDate, timeAgo } from '../util';
import { Spinner, useAsync } from './common';

function UsersTab() {
  const { data, reload } = useAsync(() => api.get<User[]>('/api/admin/users'), []);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      toast(ok, 'success');
      reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const create = async () => {
    const r = await promptDialog({
      title: 'Add user',
      message: 'They must change the password at first sign-in and enrol 2FA if required.',
      fields: [
        { name: 'username', label: 'Username', required: true },
        { name: 'password', label: 'Temporary password', type: 'password', required: true },
        { name: 'role', label: 'Role (user / admin)', value: 'user', required: true },
      ],
      confirmText: 'Create',
    });
    if (r) await run(() => api.post('/api/admin/users', { username: r.username, password: r.password, role: r.role === 'admin' ? 'admin' : 'user' }), 'User created');
  };
  if (!data) return <Spinner />;
  return (
    <div class="col">
      <div class="row">
        <span class="grow dim small">{data.length} user(s)</span>
        <button class="primary" onClick={create}>
          <UserPlus size={15} /> Add user
        </button>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>User</th>
              <th>Role</th>
              <th class="hide-sm">2FA</th>
              <th class="hide-sm">Last sign-in</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {data.map((u) => (
              <tr key={u.id}>
                <td>
                  <b>{u.username}</b> {u.disabled && <span class="badge red">disabled</span>} {u.locked && <span class="badge yellow">locked</span>}
                  {u.id === me.value?.user.id && <span class="badge blue">you</span>}
                </td>
                <td>{u.role}</td>
                <td class="hide-sm">{u.totpEnabled || u.passkeys ? <span class="badge green">{[u.totpEnabled && 'TOTP', u.passkeys && `${u.passkeys} passkey`].filter(Boolean).join(' + ')}</span> : <span class="badge">none</span>}</td>
                <td class="small hide-sm">{timeAgo(u.lastLoginAt)}</td>
                <td class="nowrap" style={{ textAlign: 'right' }}>
                  {u.id !== me.value?.user.id && (
                    <>
                      <button class="sm ghost" onClick={() => run(() => api.patch(`/api/admin/users/${u.id}`, { role: u.role === 'admin' ? 'user' : 'admin' }), 'Role changed')}>
                        {u.role === 'admin' ? 'Make user' : 'Make admin'}
                      </button>
                      <button class="sm ghost" onClick={() => run(() => api.patch(`/api/admin/users/${u.id}`, { disabled: !u.disabled }), u.disabled ? 'Enabled' : 'Disabled')}>
                        {u.disabled ? 'Enable' : 'Disable'}
                      </button>
                    </>
                  )}
                  {u.locked && (
                    <button class="sm ghost" onClick={() => run(() => api.post(`/api/admin/users/${u.id}/unlock`), 'Unlocked')}>
                      Unlock
                    </button>
                  )}
                  <button
                    class="sm ghost"
                    onClick={async () => {
                      const r = await promptDialog({ title: `Reset password for ${u.username}`, fields: [{ name: 'password', label: 'New temporary password', type: 'password', required: true }] });
                      if (r) await run(() => api.post(`/api/admin/users/${u.id}/reset-password`, r), 'Password reset');
                    }}
                  >
                    Reset password
                  </button>
                  <button
                    class="sm ghost"
                    onClick={async () => {
                      if (await confirmDialog({ title: `Remove all 2FA methods of ${u.username}?`, message: 'Use when they lost their phone. They will re-enrol at next sign-in.', danger: true, confirmText: 'Reset 2FA' }))
                        await run(() => api.post(`/api/admin/users/${u.id}/reset-2fa`), '2FA reset');
                    }}
                  >
                    Reset 2FA
                  </button>
                  {u.id !== me.value?.user.id && (
                    <button
                      class="sm ghost icon danger"
                      onClick={async () => {
                        if (await confirmDialog({ title: `Delete ${u.username}?`, message: 'Their hosts, keys and snippets are deleted too.', danger: true, typeToConfirm: u.username, confirmText: 'Delete' }))
                          await run(() => api.del(`/api/admin/users/${u.id}`), 'Deleted');
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface AuditItem {
  id: number;
  ts: number;
  username: string | null;
  ip: string | null;
  action: string;
  target: string | null;
  success: boolean;
  details: Record<string, unknown> | null;
}

function AuditTab() {
  const [items, setItems] = useState<AuditItem[] | null>(null);
  const [q, setQ] = useState('');
  const [failed, setFailed] = useState(false);
  const load = async (before?: number) => {
    const params = new URLSearchParams({ limit: '100' });
    if (q) params.set('q', q);
    if (failed) params.set('failed', '1');
    if (before) params.set('before', String(before));
    const r = await api.get<AuditItem[]>(`/api/admin/audit?${params}`);
    setItems(before ? [...(items ?? []), ...r] : r);
  };
  useEffect(() => void load(), [failed]);
  return (
    <div class="col">
      <form class="row wrap" onSubmit={(e) => (e.preventDefault(), load())}>
        <input placeholder="Search user, IP, host, command…" value={q} onInput={(e) => setQ(e.currentTarget.value)} style={{ maxWidth: 320 }} />
        <button>Search</button>
        <label class="check small">
          <input type="checkbox" checked={failed} onChange={(e) => setFailed(e.currentTarget.checked)} /> Failures only
        </label>
      </form>
      {!items ? (
        <Spinner />
      ) : (
        <div class="table-wrap" style={{ maxHeight: '65vh' }}>
          <table class="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>User</th>
                <th>Action</th>
                <th>Target</th>
                <th class="hide-sm">IP</th>
                <th class="hide-sm">Details</th>
              </tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.id}>
                  <td class="small nowrap">{formatDate(a.ts)}</td>
                  <td class="small">{a.username ?? '–'}</td>
                  <td>
                    <span class={classNames('badge', !a.success ? 'red' : a.action.startsWith('auth') ? 'blue' : a.action.startsWith('exec') || a.action.startsWith('ai') ? 'purple' : '')}>{a.action}</span>
                  </td>
                  <td class="small truncate" style={{ maxWidth: 220 }} title={a.target ?? ''}>
                    {a.target}
                  </td>
                  <td class="small mono hide-sm">{a.ip}</td>
                  <td class="small mono hide-sm truncate" style={{ maxWidth: 320 }} title={a.details ? JSON.stringify(a.details) : ''}>
                    {a.details ? JSON.stringify(a.details) : ''}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {items && items.length >= 100 && (
        <button onClick={() => load(items[items.length - 1].id)} style={{ alignSelf: 'center' }}>
          Load older
        </button>
      )}
    </div>
  );
}

function LiveTab() {
  const { data, reload } = useAsync(() => api.get<{ id: string; username: string; hostName: string; createdAt: number; lastActivityAt: number; clients: number; recording: boolean; title: string }[]>('/api/admin/terminals'), []);
  if (!data) return <Spinner />;
  return (
    <div class="col">
      {!data.length && <div class="empty">No terminal sessions right now.</div>}
      {data.map((s) => (
        <div class="card row" key={s.id}>
          <div class="grow">
            <b>{s.username}</b> → {s.hostName} {s.recording && <span class="badge red">rec</span>}
            <div class="small faint">
              {s.title} · started {timeAgo(s.createdAt)} · active {timeAgo(s.lastActivityAt)} · {s.clients} viewer(s)
            </div>
          </div>
          <button
            class="danger sm"
            onClick={async () => {
              if (await confirmDialog({ title: `Terminate ${s.username}'s session on ${s.hostName}?`, danger: true, confirmText: 'Terminate' })) {
                await api.del(`/api/admin/terminals/${s.id}`);
                reload();
              }
            }}
          >
            Terminate
          </button>
        </div>
      ))}
    </div>
  );
}

interface AdminSettings {
  settings: {
    recording: 'off' | 'per-host' | 'all';
    loginBanner: string;
    allowUserHosts: boolean;
    ai: { provider: string; model: string; baseUrl: string; autoApproveReadOnly: boolean; maxTokens: number; apiKeySet: boolean; apiKeySource: string; effectiveModel: string; effectiveBaseUrl: string };
  };
  env: Record<string, unknown>;
}

function SettingsTab() {
  const { data, reload } = useAsync(() => api.get<AdminSettings>('/api/admin/settings'), []);
  const [ai, setAi] = useState<AdminSettings['settings']['ai'] & { apiKey?: string }>();
  const [general, setGeneral] = useState<{ recording: string; loginBanner: string; allowUserHosts: boolean }>();
  const [test, setTest] = useState<any>(null);
  const [testing, setTesting] = useState(false);
  useEffect(() => {
    if (data) {
      setAi({ ...data.settings.ai });
      setGeneral({ recording: data.settings.recording, loginBanner: data.settings.loginBanner, allowUserHosts: data.settings.allowUserHosts });
    }
  }, [data]);
  if (!data || !ai || !general) return <Spinner />;
  const save = async (body: unknown) => {
    try {
      await api.put('/api/admin/settings', body);
      toast('Settings saved', 'success');
      reload();
      await loadMe();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const presets: Record<string, { model: string; baseUrl: string; note: string }> = {
    ollama: { model: 'qwen2.5-coder:7b', baseUrl: 'http://ollama:11434/v1', note: 'Free & private: runs on your own hardware. Start the "ollama" profile in docker-compose and pull a model.' },
    anthropic: { model: 'claude-opus-5-5', baseUrl: '', note: 'Claude via the Anthropic API (paid, needs an API key from console.anthropic.com).' },
    openai: { model: '', baseUrl: 'https://api.openai.com/v1', note: 'Any OpenAI-compatible endpoint: OpenAI, OpenRouter (has free models), LM Studio, vLLM, LocalAI…' },
    none: { model: '', baseUrl: '', note: 'AI features are hidden. The offline help still works.' },
  };
  return (
    <div class="col gap-lg">
      <div class="card col">
        <h3>
          <Bot size={16} /> AI assistant
        </h3>
        <div class="form-grid">
          <label>
            Provider
            <select value={ai.provider} onChange={(e) => setAi({ ...ai, provider: e.currentTarget.value, model: '', baseUrl: presets[e.currentTarget.value]?.baseUrl ?? '' })}>
              <option value="none">Disabled</option>
              <option value="ollama">Ollama (free, local)</option>
              <option value="anthropic">Anthropic Claude</option>
              <option value="openai">OpenAI-compatible</option>
            </select>
          </label>
          {ai.provider !== 'none' && (
            <>
              <label>
                Model
                <input value={ai.model} onInput={(e) => setAi({ ...ai, model: e.currentTarget.value })} placeholder={presets[ai.provider]?.model || data.settings.ai.effectiveModel} />
              </label>
              <label>
                Base URL
                <input value={ai.baseUrl} onInput={(e) => setAi({ ...ai, baseUrl: e.currentTarget.value })} placeholder={presets[ai.provider]?.baseUrl || data.settings.ai.effectiveBaseUrl} />
              </label>
              <label>
                API key {data.settings.ai.apiKeySet && <span class="badge green">set ({data.settings.ai.apiKeySource})</span>}
                <input type="password" value={ai.apiKey ?? ''} onInput={(e) => setAi({ ...ai, apiKey: e.currentTarget.value })} placeholder={ai.provider === 'ollama' ? 'not needed' : data.settings.ai.apiKeySet ? '•••••• (unchanged)' : 'sk-…'} autoComplete="off" />
              </label>
              <label>
                Max tokens per reply
                <input type="number" value={ai.maxTokens} min={1024} max={64000} onInput={(e) => setAi({ ...ai, maxTokens: Number(e.currentTarget.value) })} />
              </label>
            </>
          )}
        </div>
        <div class="small dim">{presets[ai.provider]?.note}</div>
        {ai.provider !== 'none' && (
          <label class="check">
            <input type="checkbox" checked={ai.autoApproveReadOnly} onChange={(e) => setAi({ ...ai, autoApproveReadOnly: e.currentTarget.checked })} /> Let users opt in to auto-running read-only agent commands (ls, cat, df, docker ps…)
          </label>
        )}
        <div class="row">
          <button
            class="primary"
            onClick={() =>
              save({ ai: { provider: ai.provider, model: ai.model, baseUrl: ai.baseUrl, maxTokens: ai.maxTokens, autoApproveReadOnly: ai.autoApproveReadOnly, ...(ai.apiKey !== undefined && ai.apiKey !== '' ? { apiKey: ai.apiKey } : {}) } })
            }
          >
            Save AI settings
          </button>
          {ai.provider !== 'none' && (
            <button
              disabled={testing}
              onClick={async () => {
                setTesting(true);
                setTest(await api.post('/api/admin/settings/ai-test').catch((e: Error) => ({ ok: false, error: e.message })));
                setTesting(false);
              }}
            >
              {testing ? <span class="spinner" /> : null} Test
            </button>
          )}
          {data.settings.ai.apiKeySource === 'settings' && (
            <button class="ghost danger" onClick={() => save({ ai: { apiKey: '' } })}>
              Remove stored key
            </button>
          )}
        </div>
        {test && <div class={classNames('alert small', test.ok ? 'success' : 'error')}>{test.ok ? `OK — ${test.model} replied "${test.reply}" in ${test.latencyMs} ms` : test.error}</div>}
      </div>

      <div class="card col">
        <h3>
          <Shield size={16} /> General
        </h3>
        <div class="form-grid">
          <label>
            Session recording
            <select value={general.recording} onChange={(e) => setGeneral({ ...general, recording: e.currentTarget.value })}>
              <option value="off">Off</option>
              <option value="per-host">Per host (opt-in)</option>
              <option value="all">All sessions</option>
            </select>
          </label>
          <label class="check" style={{ alignSelf: 'end' }}>
            <input type="checkbox" checked={general.allowUserHosts} onChange={(e) => setGeneral({ ...general, allowUserHosts: e.currentTarget.checked })} /> Non-admin users may add their own hosts
          </label>
        </div>
        <label>
          Login banner (shown on the sign-in page)
          <textarea rows={3} value={general.loginBanner} onInput={(e) => setGeneral({ ...general, loginBanner: e.currentTarget.value })} placeholder="Authorized use only. All activity is logged." />
        </label>
        <button class="primary" style={{ alignSelf: 'flex-start' }} onClick={() => save(general)}>
          Save
        </button>
      </div>

      <div class="card col">
        <h3>Environment (read-only, set in .env)</h3>
        <table class="table">
          <tbody>
            {Object.entries(data.env).map(([k, v]) => (
              <tr key={k}>
                <td class="mono small">{k}</td>
                <td class="small">{Array.isArray(v) ? v.join(', ') || '—' : String(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function AdminPage() {
  const [tab, setTab] = useState<'users' | 'audit' | 'live' | 'settings'>('users');
  return (
    <div class="page">
      <div class="page-header">
        <h1>
          <Shield size={22} /> Admin
        </h1>
      </div>
      <div class="tabs-inline">
        <button class={tab === 'users' ? 'active' : ''} onClick={() => setTab('users')}>
          <Users size={14} /> Users
        </button>
        <button class={tab === 'audit' ? 'active' : ''} onClick={() => setTab('audit')}>
          <ClipboardList size={14} /> Audit log
        </button>
        <button class={tab === 'live' ? 'active' : ''} onClick={() => setTab('live')}>
          <MonitorUp size={14} /> Live sessions
        </button>
        <button class={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
          <Bot size={14} /> Settings & AI
        </button>
      </div>
      {tab === 'users' && <UsersTab />}
      {tab === 'audit' && <AuditTab />}
      {tab === 'live' && <LiveTab />}
      {tab === 'settings' && <SettingsTab />}
    </div>
  );
}
