import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Bot, Braces, CircleHelp, FolderOpen, Gauge, KeyRound, Search, Server, Settings, Shield, TerminalSquare, Video } from 'lucide-preact';
import type { ComponentChildren } from 'preact';
import { aiSeed, go, helpQuery, hosts, isAdmin, me, paletteOpen, sidePanel, snippets } from '../state';
import { activate, openTerminal, tabs } from '../terminal/engine';
import { openDashboard, openFiles } from './Hosts';
import { insertSnippet } from './Terminal';

interface Item {
  id: string;
  label: string;
  hint?: string;
  icon: ComponentChildren;
  kind: string;
  run: () => void;
}

export function Palette() {
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const close = () => {
    paletteOpen.value = false;
    setQ('');
    setSel(0);
  };

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    for (const t of tabs.value) out.push({ id: 'tab' + t.key, label: `${t.hostName}${t.title ? ` — ${t.title}` : ''}`, icon: <TerminalSquare size={15} />, kind: 'open tab', run: () => activate(t.key) });
    for (const h of hosts.value) {
      out.push({ id: 'ssh' + h.id, label: h.name, hint: `${h.username}@${h.hostname}`, icon: <Server size={15} />, kind: 'connect', run: () => openTerminal(h) });
      out.push({ id: 'files' + h.id, label: `Files: ${h.name}`, icon: <FolderOpen size={15} />, kind: 'files', run: () => openFiles(h) });
      out.push({ id: 'dash' + h.id, label: `Dashboard: ${h.name}`, icon: <Gauge size={15} />, kind: 'stats', run: () => openDashboard(h) });
    }
    for (const s of snippets.value) out.push({ id: 'snip' + s.id, label: s.name, hint: s.command, icon: <Braces size={15} />, kind: 'snippet', run: () => insertSnippet(s.command, false) });
    const views: [string, string, ComponentChildren, () => void][] = [
      ['Hosts', 'hosts', <Server size={15} />, () => go('hosts')],
      ['SSH keys', 'keys', <KeyRound size={15} />, () => go('keys')],
      ['Snippets', 'snippets', <Braces size={15} />, () => go('snippets')],
      ['Recordings', 'recordings', <Video size={15} />, () => go('recordings')],
      ['Settings', 'settings', <Settings size={15} />, () => go('settings')],
    ];
    if (isAdmin.value) views.push(['Admin', 'admin', <Shield size={15} />, () => go('admin')]);
    for (const [label, id, icon, run] of views) out.push({ id: 'view' + id, label, icon, kind: 'go to', run });
    return out;
  }, [hosts.value, tabs.value, snippets.value]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    let list = s ? items.filter((i) => `${i.label} ${i.hint ?? ''} ${i.kind}`.toLowerCase().includes(s)) : items.slice(0, 30);
    list = list.slice(0, 40);
    if (s) {
      // Local help first; AI only as an explicit, last option.
      list.push({ id: 'help', label: `Help: ${q}`, icon: <CircleHelp size={15} />, kind: 'offline help', run: () => ((helpQuery.value = q), (sidePanel.value = 'help')) });
      if (me.value?.features.ai) list.push({ id: 'ai', label: `Ask AI: ${q}`, icon: <Bot size={15} />, kind: 'ai', run: () => ((aiSeed.value = { text: q, mode: 'generate' }), (sidePanel.value = 'ai')) });
    }
    return list;
  }, [q, items]);

  useEffect(() => setSel(0), [q]);
  useEffect(() => {
    listRef.current?.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
  }, [sel]);

  if (!paletteOpen.value) return null;
  const choose = (i: Item | undefined) => {
    if (!i) return;
    close();
    i.run();
  };
  return (
    <div class="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div class="modal palette">
        <div style={{ position: 'relative' }}>
          <input
            autoFocus
            placeholder="Connect to a host, open files, run a snippet, search help…"
            value={q}
            onInput={(e) => setQ(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') (e.preventDefault(), setSel(Math.min(filtered.length - 1, sel + 1)));
              else if (e.key === 'ArrowUp') (e.preventDefault(), setSel(Math.max(0, sel - 1)));
              else if (e.key === 'Enter') choose(filtered[sel]);
              else if (e.key === 'Escape') close();
            }}
            style={{ paddingLeft: 40 }}
          />
          <Search size={16} style={{ position: 'absolute', left: 14, top: 17, color: 'var(--text-faint)' }} />
        </div>
        <div class="palette-list" ref={listRef}>
          {filtered.map((i, idx) => (
            <div key={i.id} class={`palette-item ${idx === sel ? 'sel' : ''}`} onMouseEnter={() => setSel(idx)} onClick={() => choose(i)}>
              {i.icon}
              <span class="truncate">{i.label}</span>
              {i.hint && <span class="faint small truncate mono">{i.hint}</span>}
              <span class="kind">{i.kind}</span>
            </div>
          ))}
          {!filtered.length && <div class="empty small">Nothing found</div>}
        </div>
      </div>
    </div>
  );
}
