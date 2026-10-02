import { useState } from 'preact/hooks';
import { startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { Fingerprint, KeyRound, LogOut, ShieldCheck, TerminalSquare } from 'lucide-preact';
import { api, ApiError } from '../api';
import { authPhase, loadMe, loginBanner, me } from '../state';
import { CopyButton } from './common';

function Logo() {
  return (
    <div class="logo">
      <TerminalSquare size={28} color="var(--accent)" />
      WebSSH
    </div>
  );
}

function Banner() {
  return loginBanner.value ? (
    <div class="alert info small" style={{ whiteSpace: 'pre-wrap', marginBottom: 12 }}>
      {loginBanner.value}
    </div>
  ) : null;
}

const passkeySupported = () => typeof window !== 'undefined' && !!window.PublicKeyCredential;

async function afterLogin() {
  const m = await loadMe();
  if (m) authPhase.value = 'app';
}

export function SetupScreen() {
  const [form, setForm] = useState({ token: '', username: 'admin', password: '', confirm: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: Event) => {
    e.preventDefault();
    setError('');
    if (form.password !== form.confirm) return setError('Passwords do not match');
    setBusy(true);
    try {
      await api.post('/api/auth/setup', { token: form.token.trim(), username: form.username, password: form.password });
      await afterLogin();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="auth-wrap">
      <div class="auth-card">
        <Logo />
        <h2>First-time setup</h2>
        <p class="dim small">
          Create the administrator account. The one-time <b>setup token</b> is printed in the server logs (<code>docker compose logs webssh</code>).
        </p>
        <form onSubmit={submit}>
          {error && <div class="alert error">{error}</div>}
          <label>
            Setup token
            <input class="code" value={form.token} onInput={(e) => setForm({ ...form, token: e.currentTarget.value })} autoComplete="off" required autoFocus />
          </label>
          <label>
            Username
            <input value={form.username} onInput={(e) => setForm({ ...form, username: e.currentTarget.value })} autoComplete="username" required />
          </label>
          <label>
            Password
            <input type="password" value={form.password} onInput={(e) => setForm({ ...form, password: e.currentTarget.value })} autoComplete="new-password" required />
            <span class="field-help">12+ characters with 3 of: lower, upper, digit, symbol — or a 16+ character passphrase.</span>
          </label>
          <label>
            Confirm password
            <input type="password" value={form.confirm} onInput={(e) => setForm({ ...form, confirm: e.currentTarget.value })} autoComplete="new-password" required />
          </label>
          <button class="primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create admin account'}
          </button>
        </form>
      </div>
    </div>
  );
}

export function LoginScreen() {
  const [stage, setStage] = useState<'password' | 'mfa'>('password');
  const [mfa, setMfa] = useState<{ totp: boolean; passkey: boolean }>({ totp: false, passkey: false });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setError('');
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      const e = err as Error;
      if (e.name === 'NotAllowedError') setError('Passkey request was cancelled or timed out');
      else setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const submitPassword = (e: Event) => {
    e.preventDefault();
    void run(async () => {
      const r = await api.post<{ ok?: boolean; mfa?: { totp: boolean; passkey: boolean } }>('/api/auth/login', { username, password });
      setPassword('');
      if (r.mfa) {
        setMfa(r.mfa);
        setStage('mfa');
        if (r.mfa.passkey && !r.mfa.totp && passkeySupported()) void usePasskeyMfa();
      } else await afterLogin();
    });
  };

  const submitCode = (e: Event) => {
    e.preventDefault();
    void run(async () => {
      await api.post('/api/auth/mfa/totp', { code: code.trim() });
      await afterLogin();
    });
  };

  const usePasskeyMfa = () =>
    run(async () => {
      const opts = await api.post<any>('/api/auth/mfa/passkey/options');
      const response = await startAuthentication({ optionsJSON: opts });
      await api.post('/api/auth/mfa/passkey/verify', { response });
      await afterLogin();
    });

  const passwordless = () =>
    run(async () => {
      const opts = await api.post<any>('/api/auth/passkey/options');
      const response = await startAuthentication({ optionsJSON: opts });
      await api.post('/api/auth/passkey/verify', { response });
      await afterLogin();
    });

  return (
    <div class="auth-wrap">
      <div class="auth-card">
        <Logo />
        <Banner />
        {stage === 'password' ? (
          <form onSubmit={submitPassword}>
            {error && <div class="alert error">{error}</div>}
            <label>
              Username
              <input value={username} onInput={(e) => setUsername(e.currentTarget.value)} autoComplete="username webauthn" autoCapitalize="off" required autoFocus />
            </label>
            <label>
              Password
              <input type="password" value={password} onInput={(e) => setPassword(e.currentTarget.value)} autoComplete="current-password" required />
            </label>
            <button class="primary" disabled={busy}>
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
            {passkeySupported() && (
              <>
                <div class="divider">or</div>
                <button type="button" onClick={passwordless} disabled={busy}>
                  <Fingerprint size={16} /> Sign in with a passkey
                </button>
              </>
            )}
          </form>
        ) : (
          <form onSubmit={submitCode}>
            <h3 class="row">
              <ShieldCheck size={18} /> Two-factor authentication
            </h3>
            {error && <div class="alert error">{error}</div>}
            {mfa.totp && (
              <>
                <label>
                  Code from your authenticator app (or a recovery code)
                  <input
                    class="otp-input"
                    value={code}
                    onInput={(e) => setCode(e.currentTarget.value)}
                    inputMode="text"
                    autoComplete="one-time-code"
                    placeholder="123456"
                    maxLength={11}
                    autoFocus
                    required
                  />
                </label>
                <button class="primary" disabled={busy || code.trim().length < 6}>
                  Verify
                </button>
              </>
            )}
            {mfa.passkey && passkeySupported() && (
              <button type="button" onClick={usePasskeyMfa} disabled={busy}>
                <KeyRound size={16} /> Use a passkey / security key
              </button>
            )}
            {!mfa.totp && (
              <label>
                Or a recovery code
                <input value={code} onInput={(e) => setCode(e.currentTarget.value)} placeholder="xxxxx-xxxxx" />
              </label>
            )}
            {!mfa.totp && code && (
              <button class="primary" disabled={busy}>
                Use recovery code
              </button>
            )}
            <button type="button" class="ghost" onClick={() => (setStage('password'), setCode(''), setError(''))}>
              Back
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

/** Shown when the server requires a password change and/or 2FA enrolment before using the app. */
export function EnrollScreen() {
  const m = me.value!;
  return (
    <div class="auth-wrap">
      <div class="auth-card" style={{ maxWidth: 480 }}>
        <Logo />
        {m.mustChangePassword ? <ChangePasswordForm /> : <SecondFactorSetup />}
        <button class="ghost mt" onClick={logout}>
          <LogOut size={16} /> Sign out
        </button>
      </div>
    </div>
  );
}

export async function logout() {
  try {
    await api.post('/api/auth/logout');
  } catch {
    /* ignore */
  }
  location.reload();
}

export function ChangePasswordForm({ onDone }: { onDone?: () => void }) {
  const [f, setF] = useState({ current: '', next: '', confirm: '' });
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const submit = async (e: Event) => {
    e.preventDefault();
    setError('');
    if (f.next !== f.confirm) return setError('New passwords do not match');
    try {
      const r = await api.post<{ revokedSessions: number }>('/api/me/password', { current: f.current, next: f.next });
      setOk(`Password changed${r.revokedSessions ? `; signed out ${r.revokedSessions} other session(s)` : ''}.`);
      setF({ current: '', next: '', confirm: '' });
      await loadMe();
      onDone?.();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <form onSubmit={submit} class="col">
      <h3>Change password</h3>
      {error && <div class="alert error">{error}</div>}
      {ok && <div class="alert success">{ok}</div>}
      <label>
        Current password
        <input type="password" value={f.current} onInput={(e) => setF({ ...f, current: e.currentTarget.value })} autoComplete="current-password" required />
      </label>
      <label>
        New password
        <input type="password" value={f.next} onInput={(e) => setF({ ...f, next: e.currentTarget.value })} autoComplete="new-password" required />
      </label>
      <label>
        Confirm new password
        <input type="password" value={f.confirm} onInput={(e) => setF({ ...f, confirm: e.currentTarget.value })} autoComplete="new-password" required />
      </label>
      <button class="primary">Change password</button>
    </form>
  );
}

export function RecoveryCodes({ codes }: { codes: string[] }) {
  return (
    <div class="col">
      <div class="alert warn small">Save these one-time recovery codes somewhere safe (password manager). Each works once if you lose your authenticator.</div>
      <div class="recovery-codes">
        {codes.map((c) => (
          <span key={c}>{c}</span>
        ))}
      </div>
      <div class="row">
        <CopyButton text={codes.join('\n')} label="Copy all" />
      </div>
    </div>
  );
}

export function SecondFactorSetup({ onDone }: { onDone?: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; qr: string; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const startTotp = async () => {
    setError('');
    try {
      setSetup(await api.post('/api/me/totp/setup'));
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const enable = async (e: Event) => {
    e.preventDefault();
    setError('');
    try {
      const r = await api.post<{ recoveryCodes: string[] }>('/api/me/totp/enable', { code });
      setCodes(r.recoveryCodes);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const addPasskey = async () => {
    setError('');
    setBusy(true);
    try {
      const opts = await api.post<any>('/api/me/passkeys/options');
      const response = await startRegistration({ optionsJSON: opts });
      await api.post('/api/me/passkeys/verify', { response, name: guessDeviceName() });
      await loadMe();
      onDone?.();
    } catch (err) {
      const e = err as Error;
      setError(e.name === 'NotAllowedError' ? 'Passkey creation was cancelled' : e instanceof ApiError ? e.message : e.message);
    } finally {
      setBusy(false);
    }
  };

  if (codes) {
    return (
      <div class="col">
        <h3 class="row">
          <ShieldCheck size={18} color="var(--green)" /> Two-factor authentication enabled
        </h3>
        <RecoveryCodes codes={codes} />
        <button class="primary" onClick={async () => (await loadMe(), onDone?.())}>
          I saved them — continue
        </button>
      </div>
    );
  }

  return (
    <div class="col">
      <h3 class="row">
        <ShieldCheck size={18} /> Secure your account
      </h3>
      <p class="dim small">This server requires a second factor. Use an authenticator app (Aegis, 2FAS, Google Authenticator, 1Password…) and/or a passkey (Face ID, Touch ID, Windows Hello, YubiKey).</p>
      {error && <div class="alert error">{error}</div>}
      {!setup ? (
        <div class="col">
          <button class="primary" onClick={startTotp}>
            <ShieldCheck size={16} /> Set up authenticator app
          </button>
          {passkeySupported() && (
            <button onClick={addPasskey} disabled={busy}>
              <Fingerprint size={16} /> Add a passkey
            </button>
          )}
        </div>
      ) : (
        <form onSubmit={enable} class="col">
          <div class="center" style={{ background: '#fff', borderRadius: 8, padding: 8, alignSelf: 'center' }}>
            <img src={setup.qr} width={200} height={200} alt="TOTP QR code" />
          </div>
          <div class="small dim">
            Can't scan? Enter this key manually: <code style={{ wordBreak: 'break-all' }}>{setup.secret}</code> <CopyButton text={setup.secret} />
          </div>
          <a class="small" href={setup.uri}>
            Open in authenticator app on this device
          </a>
          <label>
            Enter the 6-digit code to confirm
            <input class="otp-input" value={code} onInput={(e) => setCode(e.currentTarget.value)} inputMode="numeric" autoComplete="one-time-code" maxLength={6} autoFocus required />
          </label>
          <button class="primary" disabled={code.length !== 6}>
            Enable
          </button>
        </form>
      )}
    </div>
  );
}

export function guessDeviceName(): string {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android' : /Mac/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Device';
  const br = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return `${os}${br ? ' · ' + br : ''}`;
}
