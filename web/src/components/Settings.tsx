import { useState } from 'preact/hooks';
import { startRegistration } from '@simplewebauthn/browser';
import { Fingerprint, LogOut, Monitor, Palette, Settings, ShieldCheck, Trash2 } from 'lucide-preact';
import { api } from '../api';
import { confirmDialog, loadMe, me, prefs, promptDialog, savePrefs, toast } from '../state';
import type { UserPrefs } from '../types';
import { applyPrefsToAll } from '../terminal/engine';
import { TERMINAL_THEMES } from '../terminal/themes';
import { formatDate, timeAgo } from '../util';
import { ChangePasswordForm, guessDeviceName, logout, RecoveryCodes, SecondFactorSetup } from './Auth';
import { Segmented, useAsync } from './common';

function Appearance() {
  const p = prefs.value;
  const set = async (patch: Partial<UserPrefs>) => {
    await savePrefs(patch);
    applyPrefsToAll();
  };
  return (
    <div class="card col">
      <h3>
        <Palette size={16} /> Appearance & terminal
      </h3>
      <div class="form-grid">
        <label>
          App theme
          <Segmented
            value={p.theme}
            onChange={(v) => set({ theme: v })}
            options={[
              { value: 'dark', label: 'Dark' },
              { value: 'light', label: 'Light' },
              { value: 'system', label: 'System' },
            ]}
          />
        </label>
        <label>
          Terminal colours
          <select value={p.termTheme} onChange={(e) => set({ termTheme: e.currentTarget.value })}>
            {Object.entries(TERMINAL_THEMES).map(([k, t]) => (
              <option key={k} value={k}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          Font size ({p.fontSize}px)
          <input type="range" min={9} max={28} value={p.fontSize} onInput={(e) => set({ fontSize: Number(e.currentTarget.value) })} style={{ minHeight: 0 }} />
        </label>
        <label>
          Cursor
          <select value={p.cursorStyle} onChange={(e) => set({ cursorStyle: e.currentTarget.value as UserPrefs['cursorStyle'] })}>
            <option value="block">Block</option>
            <option value="bar">Bar</option>
            <option value="underline">Underline</option>
          </select>
        </label>
        <label class="span-2">
          Font family
          <input class="code" value={p.fontFamily} onChange={(e) => set({ fontFamily: e.currentTarget.value })} />
        </label>
        <label>
          Scrollback lines
          <input type="number" min={500} max={100000} value={p.scrollback} onChange={(e) => set({ scrollback: Number(e.currentTarget.value) || 5000 })} />
        </label>
        <label>
          Mobile key bar
          <select value={p.keybar} onChange={(e) => set({ keybar: e.currentTarget.value as UserPrefs['keybar'] })}>
            <option value="auto">On touch devices</option>
            <option value="always">Always</option>
            <option value="never">Never</option>
          </select>
        </label>
      </div>
      <div class="row wrap gap-lg">
        <label class="check">
          <input type="checkbox" checked={p.cursorBlink} onChange={(e) => set({ cursorBlink: e.currentTarget.checked })} /> Blinking cursor
        </label>
        <label class="check">
          <input type="checkbox" checked={p.copyOnSelect} onChange={(e) => set({ copyOnSelect: e.currentTarget.checked })} /> Copy on select
        </label>
        <label class="check">
          <input type="checkbox" checked={p.rightClickPaste} onChange={(e) => set({ rightClickPaste: e.currentTarget.checked })} /> Right-click copies / pastes
        </label>
        <label class="check">
          <input type="checkbox" checked={p.confirmClose} onChange={(e) => set({ confirmClose: e.currentTarget.checked })} /> Confirm before closing a session
        </label>
        <label class="check">
          <input
            type="checkbox"
            checked={p.bellNotify}
            onChange={async (e) => {
              const on = e.currentTarget.checked;
              if (on && 'Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
              await set({ bellNotify: on });
            }}
          />{' '}
          Notify on terminal bell when in background
        </label>
      </div>
      <div class="small faint">
        Tip: end long commands with <code>; printf '\a'</code> to get a notification when they finish.
      </div>
    </div>
  );
}

function Security() {
  const m = me.value!;
  const passkeys = useAsync(() => api.get<{ id: string; name: string; createdAt: number; lastUsedAt: number | null; backedUp: boolean }[]>('/api/me/passkeys'), [m.user.passkeys]);
  const sessions = useAsync(() => api.get<{ id: string; current: boolean; createdAt: number; lastSeenAt: number; ip: string; userAgent: string }[]>('/api/me/sessions'), []);
  const [enrolling, setEnrolling] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);

  const addPasskey = async () => {
    try {
      const opts = await api.post<any>('/api/me/passkeys/options');
      const response = await startRegistration({ optionsJSON: opts });
      const r = await promptDialog({ title: 'Name this passkey', fields: [{ name: 'name', label: 'Name', value: guessDeviceName() }] });
      await api.post('/api/me/passkeys/verify', { response, name: r?.name });
      toast('Passkey added', 'success');
      await loadMe();
      passkeys.reload();
    } catch (err) {
      const e = err as Error;
      if (e.name !== 'NotAllowedError') toast(e.message, 'error');
    }
  };
  const removePasskey = async (id: string, name: string) => {
    if (!(await confirmDialog({ title: `Remove passkey "${name}"?`, danger: true, confirmText: 'Remove' }))) return;
    try {
      await api.del(`/api/me/passkeys/${id}`);
      await loadMe();
      passkeys.reload();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const disableTotp = async () => {
    const r = await promptDialog({ title: 'Disable authenticator app', fields: [{ name: 'password', label: 'Confirm with your password', type: 'password', required: true }], danger: true, confirmText: 'Disable' });
    if (!r) return;
    try {
      await api.post('/api/me/totp/disable', r);
      await loadMe();
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const newCodes = async () => {
    const r = await promptDialog({ title: 'Generate new recovery codes', message: 'Old codes stop working.', fields: [{ name: 'password', label: 'Password', type: 'password', required: true }] });
    if (!r) return;
    try {
      setCodes((await api.post<{ recoveryCodes: string[] }>('/api/me/recovery-codes', r)).recoveryCodes);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  return (
    <>
      <div class="card col">
        <h3>
          <ShieldCheck size={16} /> Two-factor authentication
        </h3>
        <div class="row wrap">
          <span>Authenticator app:</span>
          {m.user.totpEnabled ? <span class="badge green">enabled</span> : <span class="badge">off</span>}
          {m.user.totpEnabled ? (
            <>
              <button class="sm" onClick={newCodes}>
                New recovery codes
              </button>
              <button class="sm danger" onClick={disableTotp}>
                Disable
              </button>
            </>
          ) : (
            <button class="sm primary" onClick={() => setEnrolling(true)}>
              Set up
            </button>
          )}
        </div>
        {codes && <RecoveryCodes codes={codes} />}
        {enrolling && !m.user.totpEnabled && <SecondFactorSetup onDone={() => setEnrolling(false)} />}
        <div class="row between mt">
          <b class="row">
            <Fingerprint size={15} /> Passkeys & security keys
          </b>
          <button class="sm" onClick={addPasskey}>
            Add passkey
          </button>
        </div>
        {passkeys.data?.map((p) => (
          <div class="row small" key={p.id}>
            <span class="grow">
              {p.name} {p.backedUp && <span class="badge">synced</span>}
            </span>
            <span class="faint">used {timeAgo(p.lastUsedAt)}</span>
            <button class="sm ghost icon" onClick={() => removePasskey(p.id, p.name)}>
              <Trash2 size={14} />
            </button>
          </div>
        ))}
        {!passkeys.data?.length && <div class="small faint">None yet. Passkeys let you sign in with Face ID / Touch ID / Windows Hello — phishing-proof.</div>}
      </div>

      <div class="card">
        <ChangePasswordForm />
      </div>

      <div class="card col">
        <div class="row between">
          <h3 style={{ margin: 0 }}>
            <Monitor size={16} /> Signed-in devices
          </h3>
          <button
            class="sm"
            onClick={async () => {
              const r = await api.post<{ revoked: number }>('/api/me/sessions/revoke-others');
              toast(`Signed out ${r.revoked} other session(s)`, 'success');
              sessions.reload();
            }}
          >
            Sign out other devices
          </button>
        </div>
        {sessions.data?.map((s) => (
          <div class="row small" key={s.id}>
            <div class="grow">
              <div class="truncate">{s.userAgent || 'Unknown device'}</div>
              <div class="faint">
                {s.ip} · signed in {formatDate(s.createdAt)} · active {timeAgo(s.lastSeenAt)}
              </div>
            </div>
            {s.current ? (
              <span class="badge green">this device</span>
            ) : (
              <button
                class="sm ghost icon"
                onClick={async () => {
                  await api.del(`/api/me/sessions/${s.id}`);
                  sessions.reload();
                }}
              >
                <LogOut size={14} />
              </button>
            )}
          </div>
        ))}
      </div>
    </>
  );
}

export function SettingsPage() {
  const m = me.value!;
  const [name, setName] = useState(m.user.displayName);
  return (
    <div class="page col gap-lg" style={{ maxWidth: 900 }}>
      <div class="page-header">
        <h1>
          <Settings size={22} /> Settings
        </h1>
        <button onClick={logout}>
          <LogOut size={16} /> Sign out
        </button>
      </div>
      <div class="card row wrap">
        <div class="grow">
          <b>{m.user.username}</b> <span class="badge">{m.user.role}</span>
          <div class="small faint">Last sign-in {formatDate(m.user.lastLoginAt)}</div>
        </div>
        <input value={name} onInput={(e) => setName(e.currentTarget.value)} style={{ width: 200 }} placeholder="Display name" />
        <button
          onClick={async () => {
            await api.put('/api/me/profile', { displayName: name });
            await loadMe();
            toast('Saved', 'success');
          }}
        >
          Save
        </button>
      </div>
      <Appearance />
      <Security />
      <div class="card small dim">
        Install WebSSH as an app: on iPhone use Safari → Share → <b>Add to Home Screen</b>; on Android/Chrome/Edge use the install icon in the address bar.
      </div>
    </div>
  );
}
