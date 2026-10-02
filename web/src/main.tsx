import { render } from 'preact';
import { useEffect } from 'preact/hooks';
import './styles.css';
import { api, onSecurityRequirement, onUnauthorized } from './api';
import { applyTheme, authPhase, liveSessions, loadHosts, loadKeys, loadLiveSessions, loadMe, loadSnippets, loginBanner, me, toast } from './state';
import { EnrollScreen, LoginScreen, SetupScreen } from './components/Auth';
import { Shell } from './components/Shell';
import { fitAll, openTerminal, savedSessions, tabs } from './terminal/engine';

// Keep the app height in sync with the *visual* viewport so the on-screen keyboard
// never covers the terminal on phones.
function syncViewport() {
  const vv = window.visualViewport;
  const h = vv ? vv.height : window.innerHeight;
  document.documentElement.style.setProperty('--app-h', `${Math.round(h)}px`);
  if (vv && vv.offsetTop) window.scrollTo(0, 0);
  requestAnimationFrame(fitAll);
}
window.visualViewport?.addEventListener('resize', syncViewport);
window.visualViewport?.addEventListener('scroll', syncViewport);
window.addEventListener('resize', syncViewport);
syncViewport();

applyTheme();
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);

onUnauthorized(() => {
  if (authPhase.value === 'app') {
    toast('Your session expired — please sign in again', 'error');
    me.value = null;
    authPhase.value = 'login';
  }
});
onSecurityRequirement(() => void loadMe());

async function boot() {
  try {
    const state = await api.get<{ setupRequired: boolean; loginBanner: string }>('/api/auth/state');
    loginBanner.value = state.loginBanner;
    if (state.setupRequired) {
      authPhase.value = 'setup';
      return;
    }
  } catch {
    /* server unreachable: fall through to login, which shows errors */
  }
  const m = await loadMe();
  authPhase.value = m ? 'app' : 'login';
}

async function loadAppData() {
  await Promise.allSettled([loadHosts(), loadKeys(), loadSnippets(), loadLiveSessions()]);
  // Re-attach to sessions that were open in this browser before a reload.
  const live = new Set(liveSessions.value.map((s) => s.id));
  for (const s of savedSessions()) {
    if (!live.has(s.sessionId) || tabs.value.some((t) => t.sessionId === s.sessionId)) continue;
    const session = liveSessions.value.find((x) => x.id === s.sessionId)!;
    openTerminal({ id: session.hostId, name: session.hostName, color: null }, session.id, false);
  }
}

function App() {
  const phase = authPhase.value;
  const m = me.value;
  const blocked = !!m && (m.mustChangePassword || m.needs2faSetup);
  useEffect(() => {
    if (phase === 'app' && m && !blocked) void loadAppData();
  }, [phase, blocked]);

  if (phase === 'loading') return <div class="auth-wrap"><span class="spinner" /></div>;
  if (phase === 'setup') return <SetupScreen />;
  if (phase === 'login' || !m) return <LoginScreen />;
  if (blocked) return <EnrollScreen />;
  return <Shell />;
}

render(<App />, document.getElementById('app')!);
void boot();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
