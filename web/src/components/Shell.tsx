import { useEffect } from 'preact/hooks';
import {
  Bot, Braces, CircleHelp, Command, FolderOpen, Gauge, KeyRound, Menu, Server, Settings, Shield, TerminalSquare, Video, X,
} from 'lucide-preact';
import { drawerOpen, go, hosts, isAdmin, me, paletteOpen, sidePanel, view, type View } from '../state';
import { activeController, tabs } from '../terminal/engine';
import { classNames } from '../util';
import { DialogHost, Toasts } from './common';
import { editingHost, HostFormModal, HostList, HostsPage, ImportModal, importOpen } from './Hosts';
import { explainSelection, searchOpen, TerminalPage, TerminalPrompts, TerminalTopbar } from './Terminal';
import { FilesPage } from './Files';
import { DashboardPage } from './Dashboard';
import { SnippetPicker, SnippetsPage } from './Snippets';
import { KeysPage } from './Keys';
import { RecordingsPage } from './Recordings';
import { SettingsPage } from './Settings';
import { AdminPage } from './Admin';
import { HelpPanel } from './Help';
import { AiPanel } from './Ai';
import { Palette } from './Palette';

const NAV: { view: View; label: string; icon: preact.ComponentChildren; admin?: boolean }[] = [
  { view: 'hosts', label: 'Hosts', icon: <Server size={16} /> },
  { view: 'terminal', label: 'Terminals', icon: <TerminalSquare size={16} /> },
  { view: 'files', label: 'Files', icon: <FolderOpen size={16} /> },
  { view: 'dashboard', label: 'Dashboard', icon: <Gauge size={16} /> },
  { view: 'snippets', label: 'Snippets', icon: <Braces size={16} /> },
  { view: 'keys', label: 'SSH keys', icon: <KeyRound size={16} /> },
  { view: 'recordings', label: 'Recordings', icon: <Video size={16} /> },
  { view: 'settings', label: 'Settings', icon: <Settings size={16} /> },
  { view: 'admin', label: 'Admin', icon: <Shield size={16} />, admin: true },
];

function Sidebar() {
  return (
    <aside class={classNames('sidebar', drawerOpen.value && 'open')}>
      <div class="brand">
        <TerminalSquare size={20} color="var(--accent)" /> WebSSH
        <span class="grow" />
        <button class="ghost icon show-mobile" onClick={() => (drawerOpen.value = false)}>
          <X size={18} />
        </button>
      </div>
      <HostList onPick={() => (drawerOpen.value = false)} />
      <nav>
        {NAV.filter((n) => !n.admin || isAdmin.value).map((n) => (
          <button key={n.view} class={classNames('nav-item', view.value === n.view && 'active')} onClick={() => go(n.view)}>
            {n.icon} {n.label}
            {n.view === 'terminal' && tabs.value.length > 0 && <span class="badge count">{tabs.value.length}</span>}
          </button>
        ))}
      </nav>
    </aside>
  );
}

function Topbar() {
  const v = view.value;
  const title = NAV.find((n) => n.view === v)?.label ?? '';
  return (
    <header class="topbar">
      <button class="ghost icon show-mobile" onClick={() => (drawerOpen.value = true)} aria-label="Menu">
        <Menu size={18} />
      </button>
      {v === 'terminal' && tabs.value.length ? <TerminalTopbar /> : <b class="grow" style={{ paddingLeft: 6 }}>{title}</b>}
      <button class="ghost icon" title="Command palette (Ctrl+Shift+K)" onClick={() => (paletteOpen.value = true)}>
        <Command size={16} />
      </button>
      <button class={classNames('ghost icon', sidePanel.value === 'help' && 'active')} title="Command help (Ctrl+Shift+H)" onClick={() => (sidePanel.value = sidePanel.value === 'help' ? null : 'help')}>
        <CircleHelp size={16} />
      </button>
      {me.value?.features.ai && (
        <button class={classNames('ghost icon', sidePanel.value === 'ai' && 'active')} title="AI assistant (Ctrl+Shift+A)" onClick={() => (sidePanel.value = sidePanel.value === 'ai' ? null : 'ai')}>
          <Bot size={16} />
        </button>
      )}
    </header>
  );
}

function SidePanel() {
  const p = sidePanel.value;
  if (!p) return null;
  return (
    <aside class="side-panel">
      <div class="panel-head">
        {p === 'help' ? <CircleHelp size={16} /> : <Bot size={16} />}
        <b class="grow">{p === 'help' ? 'Command help' : 'AI assistant'}</b>
        {p === 'help' && activeController() && (
          <button class="sm ghost" onClick={() => explainSelection(false)} title="Look up the selected text">
            Look up selection
          </button>
        )}
        {p === 'ai' && activeController() && (
          <button class="sm ghost" onClick={() => explainSelection(true)} title="Explain the selection or the screen">
            Explain screen
          </button>
        )}
        <button class="ghost icon" onClick={() => (sidePanel.value = null)} aria-label="Close panel">
          <X size={16} />
        </button>
      </div>
      <div class="panel-body" style={p === 'ai' ? { display: 'flex', flexDirection: 'column' } : undefined}>
        {p === 'help' ? <HelpPanel /> : <AiPanel />}
      </div>
    </aside>
  );
}

function BottomNav() {
  const items: [View | 'help' | 'ai', string, preact.ComponentChildren][] = [
    ['hosts', 'Hosts', <Server size={20} />],
    ['terminal', 'Terminal', <TerminalSquare size={20} />],
    ['files', 'Files', <FolderOpen size={20} />],
    ['help', 'Help', <CircleHelp size={20} />],
  ];
  if (me.value?.features.ai) items.push(['ai', 'AI', <Bot size={20} />]);
  return (
    <nav class="bottom-nav">
      {items.map(([k, label, icon]) => (
        <button
          key={k}
          class={classNames((k === sidePanel.value || (k === view.value && !sidePanel.value)) && 'active')}
          onClick={() => {
            if (k === 'help' || k === 'ai') sidePanel.value = sidePanel.value === k ? null : k;
            else {
              sidePanel.value = null;
              go(k);
            }
          }}
        >
          {icon}
          {label}
          {k === 'terminal' && tabs.value.length > 0 && <span class="badge" style={{ position: 'absolute', marginLeft: 28, marginTop: -8, padding: '0 5px' }}>{tabs.value.length}</span>}
        </button>
      ))}
    </nav>
  );
}

function Page() {
  switch (view.value) {
    case 'terminal':
      return <TerminalPage />;
    case 'files':
      return <FilesPage />;
    case 'dashboard':
      return <DashboardPage />;
    case 'snippets':
      return <SnippetsPage />;
    case 'keys':
      return <KeysPage />;
    case 'recordings':
      return <RecordingsPage />;
    case 'settings':
      return <SettingsPage />;
    case 'admin':
      return isAdmin.value ? <AdminPage /> : <HostsPage />;
    default:
      return <HostsPage />;
  }
}

export function Shell() {
  // Global keyboard shortcuts
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod || !e.shiftKey) return;
      if (e.code === 'KeyK' || e.code === 'KeyP') {
        e.preventDefault();
        paletteOpen.value = !paletteOpen.value;
      } else if (e.code === 'KeyH') {
        e.preventDefault();
        explainSelection(false);
      } else if (e.code === 'KeyA' && me.value?.features.ai) {
        e.preventDefault();
        sidePanel.value = sidePanel.value === 'ai' ? null : 'ai';
      } else if (e.code === 'KeyF' && view.value === 'terminal') {
        e.preventDefault();
        searchOpen.set(true);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, []);

  const isTerminal = view.value === 'terminal' && tabs.value.length > 0;
  return (
    <div class="shell">
      <Sidebar />
      {drawerOpen.value && <div class="drawer-backdrop show-mobile" onClick={() => (drawerOpen.value = false)} />}
      <main class="main">
        <Topbar />
        <div class="content" style={isTerminal ? { overflow: 'hidden', display: 'flex', flexDirection: 'column' } : undefined}>
          <Page />
        </div>
        {/* In the terminal view the key bar replaces the bottom nav; the menu button still reaches everything. */}
        {!(isTerminal && hosts.value.length) && <BottomNav />}
      </main>
      <SidePanel />
      {editingHost.value && <HostFormModal key={editingHost.value === 'new' ? 'new' : editingHost.value.id} />}
      {importOpen.value && <ImportModal />}
      <TerminalPrompts />
      <SnippetPicker />
      <Palette />
      <DialogHost />
      <Toasts />
    </div>
  );
}
