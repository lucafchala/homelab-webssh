import { useEffect, useState } from 'preact/hooks';
import {
  Activity, Box, Cpu, Gauge, HardDrive, MemoryStick, Network, Package, Play, Power, PowerOff, RefreshCw, RotateCw, ScrollText, Server, Square, TerminalSquare, Thermometer, Zap,
} from 'lucide-preact';
import { api } from '../api';
import { confirmDialog, hostById, hosts, toast } from '../state';
import { openTerminal, runOnHost } from '../terminal/engine';
import { classNames, formatBytes, formatDuration } from '../util';
import { Empty, Modal, Spinner } from './common';
import { useFocusHost } from './Files';
import { wakeHost } from './Hosts';

interface Stats {
  hostname: string;
  os: string;
  kernel: string;
  arch: string;
  uptimeSec: number | null;
  load: number[] | null;
  cpu: { cores: number | null; model: string | null; usagePct: number | null };
  memory: { totalKb: number; availableKb: number; usedPct: number; swapTotalKb: number; swapUsedKb: number } | null;
  disks: { fs: string; mount: string; sizeKb: number; usedKb: number; availKb: number; usedPct: number }[];
  net: { iface: string; rxBps: number; txBps: number; rxBytes: number; txBytes: number }[];
  temps: { name: string; celsius: number }[];
  processes: { pid: number; user: string; cpu: number; mem: number; command: string }[];
  usersLoggedIn: number | null;
  ips: string[];
  features: string[];
  rebootRequired: boolean;
}

function Bar({ pct }: { pct: number }) {
  return (
    <div class={classNames('progress', pct > 90 ? 'crit' : pct > 75 && 'warn')}>
      <div style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} />
    </div>
  );
}

function errorBox(err: string, code: string | undefined, hostId: string) {
  const h = hostById(hostId);
  return (
    <div class="alert error">
      {err}
      {(code === 'HOST_KEY_UNKNOWN' || code === 'AUTH_FAILED') && h && (
        <div class="mt">
          <button class="primary sm" onClick={() => openTerminal(h)}>
            <TerminalSquare size={14} /> Open a terminal to connect first
          </button>
        </div>
      )}
    </div>
  );
}

export function DashboardPage() {
  const [hostId, setHostId] = useFocusHost();
  const [tab, setTab] = useState<'overview' | 'docker' | 'services' | 'updates'>('overview');
  const host = hostById(hostId);
  if (!hosts.value.length) return <Empty title="No hosts" icon={<Gauge size={40} />} />;
  return (
    <div class="page">
      <div class="page-header">
        <h1>
          <Gauge size={22} /> Dashboard
        </h1>
        <select value={hostId ?? ''} onChange={(e) => setHostId(e.currentTarget.value)} style={{ width: 'auto', minWidth: 160 }}>
          {hosts.value.map((h) => (
            <option key={h.id} value={h.id}>
              {h.name}
            </option>
          ))}
        </select>
        {host && (
          <>
            <button class="primary" onClick={() => openTerminal(host)}>
              <TerminalSquare size={15} /> Terminal
            </button>
            {host.macAddress && (
              <button onClick={() => wakeHost(host)} title="Wake-on-LAN">
                <Zap size={15} /> Wake
              </button>
            )}
            <PowerMenu hostId={host.id} name={host.name} />
          </>
        )}
      </div>
      <div class="tabs-inline">
        {(['overview', 'docker', 'services', 'updates'] as const).map((t) => (
          <button key={t} class={tab === t ? 'active' : ''} onClick={() => setTab(t)}>
            {t === 'overview' ? 'Overview' : t === 'docker' ? 'Containers' : t === 'services' ? 'Services' : 'Updates'}
          </button>
        ))}
      </div>
      {hostId && tab === 'overview' && <Overview hostId={hostId} />}
      {hostId && tab === 'docker' && <Docker hostId={hostId} />}
      {hostId && tab === 'services' && <Services hostId={hostId} />}
      {hostId && tab === 'updates' && <Updates hostId={hostId} />}
    </div>
  );
}

function PowerMenu({ hostId, name }: { hostId: string; name: string }) {
  const act = async (action: 'reboot' | 'poweroff') => {
    const ok = await confirmDialog({
      title: action === 'reboot' ? `Reboot ${name}?` : `Shut down ${name}?`,
      message: action === 'poweroff' ? 'You will need physical access or Wake-on-LAN to turn it back on.' : 'All sessions on that host will drop.',
      danger: true,
      typeToConfirm: name,
      confirmText: action === 'reboot' ? 'Reboot' : 'Shut down',
    });
    if (!ok) return;
    try {
      await api.post(`/api/hosts/${hostId}/power`, { action });
      toast(`${name}: ${action} requested`, 'success');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  return (
    <>
      <button class="icon" title="Reboot" onClick={() => act('reboot')}>
        <RotateCw size={15} />
      </button>
      <button class="icon danger" title="Shut down" onClick={() => act('poweroff')}>
        <PowerOff size={15} />
      </button>
    </>
  );
}

function Overview({ hostId }: { hostId: string }) {
  const [s, setS] = useState<Stats | null>(null);
  const [err, setErr] = useState<{ message: string; code?: string } | null>(null);
  const [auto, setAuto] = useState(true);
  const [loading, setLoading] = useState(false);
  const load = async () => {
    setLoading(true);
    try {
      setS(await api.get<Stats>(`/api/hosts/${hostId}/stats`));
      setErr(null);
    } catch (e) {
      setErr({ message: (e as Error).message, code: (e as { code?: string }).code });
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    setS(null);
    setErr(null);
    void load();
  }, [hostId]);
  useEffect(() => {
    if (!auto || err) return;
    const t = setInterval(() => !document.hidden && load(), 6000);
    return () => clearInterval(t);
  }, [auto, hostId, err]);

  if (err) return errorBox(err.message, err.code, hostId);
  if (!s) return <Spinner label="Collecting stats…" />;
  const memUsed = s.memory ? (s.memory.totalKb - s.memory.availableKb) * 1024 : 0;
  return (
    <div class="col gap-lg">
      <div class="row between wrap">
        <div class="dim small">
          <b>{s.hostname}</b> · {s.os} · {s.kernel} · {s.arch} {s.ips.length > 0 && `· ${s.ips.join(', ')}`}
        </div>
        <div class="row">
          {s.rebootRequired && <span class="badge yellow">reboot required</span>}
          <label class="check small">
            <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.currentTarget.checked)} /> live
          </label>
          <button class="sm icon" onClick={load}>
            {loading ? <span class="spinner" /> : <RefreshCw size={14} />}
          </button>
        </div>
      </div>
      <div class="stat-grid">
        <div class="card stat">
          <div class="label">
            <Cpu size={14} /> CPU {s.cpu.cores && `· ${s.cpu.cores} cores`}
          </div>
          <div class="value">{s.cpu.usagePct ?? '–'}%</div>
          <Bar pct={s.cpu.usagePct ?? 0} />
          <div class="small faint mt truncate">{s.cpu.model}</div>
        </div>
        <div class="card stat">
          <div class="label">
            <MemoryStick size={14} /> Memory
          </div>
          <div class="value">{s.memory?.usedPct ?? '–'}%</div>
          <Bar pct={s.memory?.usedPct ?? 0} />
          <div class="small faint mt">
            {formatBytes(memUsed)} / {formatBytes((s.memory?.totalKb ?? 0) * 1024)}
            {s.memory?.swapTotalKb ? ` · swap ${formatBytes(s.memory.swapUsedKb * 1024)}` : ''}
          </div>
        </div>
        <div class="card stat">
          <div class="label">
            <Activity size={14} /> Load
          </div>
          <div class="value">{s.load?.[0]?.toFixed(2) ?? '–'}</div>
          <Bar pct={s.load && s.cpu.cores ? (s.load[0] / s.cpu.cores) * 100 : 0} />
          <div class="small faint mt">
            5m {s.load?.[1]?.toFixed(2)} · 15m {s.load?.[2]?.toFixed(2)}
          </div>
        </div>
        <div class="card stat">
          <div class="label">
            <Server size={14} /> Uptime
          </div>
          <div class="value">{formatDuration(s.uptimeSec)}</div>
          <div class="small faint">{s.usersLoggedIn ?? 0} user session(s)</div>
          <div class="row wrap mt" style={{ gap: 4 }}>
            {s.features.map((f) => (
              <span class="badge" key={f}>
                {f}
              </span>
            ))}
          </div>
        </div>
      </div>
      <div class="card-grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))' }}>
        <div class="card">
          <h3>
            <HardDrive size={16} /> Disks
          </h3>
          <div class="col">
            {s.disks.map((d) => (
              <div key={d.mount}>
                <div class="row between small">
                  <span class="mono truncate">{d.mount}</span>
                  <span class="dim nowrap">
                    {formatBytes(d.usedKb * 1024)} / {formatBytes(d.sizeKb * 1024)} ({d.usedPct}%)
                  </span>
                </div>
                <Bar pct={d.usedPct} />
              </div>
            ))}
          </div>
        </div>
        <div class="card">
          <h3>
            <Network size={16} /> Network
          </h3>
          <table class="table">
            <tbody>
              {s.net.map((n) => (
                <tr key={n.iface}>
                  <td class="mono">{n.iface}</td>
                  <td class="nowrap">↓ {formatBytes(n.rxBps)}/s</td>
                  <td class="nowrap">↑ {formatBytes(n.txBps)}/s</td>
                  <td class="faint small hide-sm">{formatBytes(n.rxBytes)} total</td>
                </tr>
              ))}
            </tbody>
          </table>
          {s.temps.length > 0 && (
            <>
              <h3 class="mt">
                <Thermometer size={16} /> Temperatures
              </h3>
              <div class="row wrap">
                {s.temps.map((t, i) => (
                  <span key={i} class={classNames('badge', t.celsius > 80 ? 'red' : t.celsius > 65 ? 'yellow' : 'green')}>
                    {t.name}: {t.celsius}°C
                  </span>
                ))}
              </div>
            </>
          )}
        </div>
        <div class="card">
          <h3>
            <Activity size={16} /> Top processes
          </h3>
          <table class="table">
            <thead>
              <tr>
                <th>PID</th>
                <th>User</th>
                <th>CPU%</th>
                <th>MEM%</th>
                <th>Command</th>
              </tr>
            </thead>
            <tbody>
              {s.processes.map((p) => (
                <tr key={p.pid}>
                  <td class="mono small">{p.pid}</td>
                  <td class="small">{p.user}</td>
                  <td>{p.cpu}</td>
                  <td>{p.mem}</td>
                  <td class="mono small truncate" style={{ maxWidth: 160 }}>
                    {p.command}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

interface Container {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
  project: string | null;
  service: string | null;
}

function LogsModal({ title, url, onClose }: { title: string; url: string; onClose: () => void }) {
  const [logs, setLogs] = useState<string | null>(null);
  const [err, setErr] = useState('');
  const load = () =>
    api.get<{ logs: string }>(url).then(
      (r) => setLogs(r.logs),
      (e: Error) => setErr(e.message),
    );
  useEffect(() => void load(), [url]);
  return (
    <Modal title={title} icon={<ScrollText size={18} />} onClose={onClose} size="wide" footer={<button onClick={() => (setLogs(null), load())}>Refresh</button>}>
      {err && <div class="alert error">{err}</div>}
      {logs === null && !err ? <Spinner /> : <pre class="log-view">{logs || '(empty)'}</pre>}
    </Modal>
  );
}

function Docker({ hostId }: { hostId: string }) {
  const [list, setList] = useState<Container[] | null>(null);
  const [stats, setStats] = useState<Record<string, { cpu: string; mem: string }>>({});
  const [err, setErr] = useState<{ message: string; code?: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [logs, setLogs] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const load = async () => {
    try {
      const r = await api.get<{ containers: Container[] }>(`/api/hosts/${hostId}/docker`);
      setList(r.containers);
      setErr(null);
      api.get<{ stats: Record<string, { cpu: string; mem: string }> }>(`/api/hosts/${hostId}/docker/stats`).then((s) => setStats(s.stats), () => {});
    } catch (e) {
      setErr({ message: (e as Error).message, code: (e as { code?: string }).code });
    }
  };
  useEffect(() => {
    setList(null);
    void load();
  }, [hostId]);
  const act = async (c: Container, action: string) => {
    if ((action === 'stop' || action === 'kill') && !(await confirmDialog({ title: `${action} ${c.name}?`, danger: true, confirmText: action }))) return;
    setBusy(c.name);
    try {
      await api.post(`/api/hosts/${hostId}/docker/${encodeURIComponent(c.name)}/${action}`);
      toast(`${c.name}: ${action} ok`, 'success');
      await load();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };
  if (err) return errorBox(err.message, err.code, hostId);
  if (!list) return <Spinner label="Listing containers…" />;
  const filtered = list.filter((c) => !q || `${c.name} ${c.image} ${c.project}`.toLowerCase().includes(q.toLowerCase()));
  const groups = new Map<string, Container[]>();
  for (const c of filtered) groups.set(c.project ?? '(standalone)', [...(groups.get(c.project ?? '(standalone)') ?? []), c]);
  const running = list.filter((c) => c.state === 'running').length;
  return (
    <div class="col">
      <div class="row wrap">
        <span class="badge green">{running} running</span>
        <span class="badge">{list.length - running} stopped</span>
        <input placeholder="Filter…" value={q} onInput={(e) => setQ(e.currentTarget.value)} style={{ width: 180 }} />
        <span class="grow" />
        <button
          class="sm"
          onClick={() => {
            const h = hostById(hostId);
            if (h) runOnHost(h, 'cd ~/docker/<stack> && docker compose pull && docker compose up -d');
          }}
          title="Types the update command into a terminal for you to adjust and run"
        >
          Update a compose stack…
        </button>
        <button class="sm icon" onClick={load}>
          <RefreshCw size={14} />
        </button>
      </div>
      {[...groups].map(([g, cs]) => (
        <div key={g} class="card" style={{ padding: 0 }}>
          <div class="row" style={{ padding: '8px 12px', borderBottom: '1px solid var(--border)' }}>
            <Box size={15} /> <b>{g}</b> <span class="faint small">{cs.length}</span>
          </div>
          <table class="table">
            <tbody>
              {cs.map((c) => (
                <tr key={c.id}>
                  <td style={{ width: 16 }}>
                    <span class={classNames('dot', c.state === 'running' ? 'green' : c.state === 'paused' || c.state === 'restarting' ? 'yellow' : 'red')} />
                  </td>
                  <td>
                    <b>{c.name}</b>
                    <div class="small faint truncate" style={{ maxWidth: 260 }}>
                      {c.image}
                    </div>
                  </td>
                  <td class="small dim hide-sm">{c.status}</td>
                  <td class="small dim hide-sm mono truncate" style={{ maxWidth: 220 }} title={c.ports}>
                    {c.ports}
                  </td>
                  <td class="small hide-sm nowrap">{stats[c.name] ? `${stats[c.name].cpu} · ${stats[c.name].mem.split('/')[0]}` : ''}</td>
                  <td class="nowrap" style={{ textAlign: 'right' }}>
                    {busy === c.name ? (
                      <span class="spinner" />
                    ) : (
                      <>
                        {c.state === 'running' ? (
                          <>
                            <button class="sm ghost icon" title="Restart" onClick={() => act(c, 'restart')}>
                              <RotateCw size={14} />
                            </button>
                            <button class="sm ghost icon" title="Stop" onClick={() => act(c, 'stop')}>
                              <Square size={14} />
                            </button>
                          </>
                        ) : (
                          <button class="sm ghost icon" title="Start" onClick={() => act(c, 'start')}>
                            <Play size={14} />
                          </button>
                        )}
                        <button class="sm ghost icon" title="Logs" onClick={() => setLogs(c.name)}>
                          <ScrollText size={14} />
                        </button>
                        <button
                          class="sm ghost icon"
                          title="Shell inside container"
                          onClick={() => {
                            const h = hostById(hostId);
                            if (h) runOnHost(h, `docker exec -it ${c.name} sh -c 'command -v bash >/dev/null && exec bash || exec sh'\r`);
                          }}
                        >
                          <TerminalSquare size={14} />
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
      {logs && <LogsModal title={`Logs: ${logs}`} url={`/api/hosts/${hostId}/docker/${encodeURIComponent(logs)}/logs?tail=500`} onClose={() => setLogs(null)} />}
    </div>
  );
}

interface Service {
  unit: string;
  load: string;
  active: string;
  sub: string;
  description: string;
  enabled: string | null;
}

function Services({ hostId }: { hostId: string }) {
  const [list, setList] = useState<Service[] | null>(null);
  const [err, setErr] = useState<{ message: string; code?: string } | null>(null);
  const [filter, setFilter] = useState<'running' | 'failed' | 'all'>('running');
  const [q, setQ] = useState('');
  const [logs, setLogs] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = async () => {
    try {
      setList((await api.get<{ services: Service[] }>(`/api/hosts/${hostId}/services`)).services);
      setErr(null);
    } catch (e) {
      setErr({ message: (e as Error).message, code: (e as { code?: string }).code });
    }
  };
  useEffect(() => {
    setList(null);
    void load();
  }, [hostId]);
  const act = async (s: Service, action: string) => {
    if ((action === 'stop' || action === 'disable') && !(await confirmDialog({ title: `${action} ${s.unit}?`, danger: true, confirmText: action }))) return;
    setBusy(s.unit);
    try {
      await api.post(`/api/hosts/${hostId}/services/${encodeURIComponent(s.unit)}/${action}`);
      toast(`${s.unit}: ${action} ok`, 'success');
      await load();
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(null);
    }
  };
  if (err) return errorBox(err.message, err.code, hostId);
  if (!list) return <Spinner label="Listing services…" />;
  const failed = list.filter((s) => s.active === 'failed').length;
  const shown = list.filter(
    (s) => (filter === 'all' || (filter === 'running' ? s.sub === 'running' : s.active === 'failed')) && (!q || `${s.unit} ${s.description}`.toLowerCase().includes(q.toLowerCase())),
  );
  return (
    <div class="col">
      <div class="row wrap">
        {(['running', 'failed', 'all'] as const).map((f) => (
          <button key={f} class={classNames('sm', filter === f && 'active')} onClick={() => setFilter(f)}>
            {f} {f === 'failed' && failed > 0 && <span class="badge red">{failed}</span>}
          </button>
        ))}
        <input placeholder="Filter…" value={q} onInput={(e) => setQ(e.currentTarget.value)} style={{ width: 180 }} />
        <button class="sm icon" onClick={load}>
          <RefreshCw size={14} />
        </button>
      </div>
      <div class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th />
              <th>Unit</th>
              <th class="hide-sm">Description</th>
              <th class="hide-sm">Boot</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {shown.map((s) => (
              <tr key={s.unit}>
                <td style={{ width: 16 }}>
                  <span class={classNames('dot', s.active === 'active' ? 'green' : s.active === 'failed' ? 'red' : '')} />
                </td>
                <td class="mono small">
                  {s.unit}
                  <div class="faint">{s.sub}</div>
                </td>
                <td class="small dim hide-sm">{s.description}</td>
                <td class="small hide-sm">{s.enabled}</td>
                <td class="nowrap" style={{ textAlign: 'right' }}>
                  {busy === s.unit ? (
                    <span class="spinner" />
                  ) : (
                    <>
                      {s.active === 'active' ? (
                        <>
                          <button class="sm ghost icon" title="Restart" onClick={() => act(s, 'restart')}>
                            <RotateCw size={14} />
                          </button>
                          <button class="sm ghost icon" title="Stop" onClick={() => act(s, 'stop')}>
                            <Square size={14} />
                          </button>
                        </>
                      ) : (
                        <button class="sm ghost icon" title="Start" onClick={() => act(s, 'start')}>
                          <Play size={14} />
                        </button>
                      )}
                      {s.enabled === 'disabled' && (
                        <button class="sm ghost" title="Enable at boot" onClick={() => act(s, 'enable')}>
                          <Power size={14} />
                        </button>
                      )}
                      <button class="sm ghost icon" title="Logs" onClick={() => setLogs(s.unit)}>
                        <ScrollText size={14} />
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {logs && <LogsModal title={`journalctl -u ${logs}`} url={`/api/hosts/${hostId}/services/${encodeURIComponent(logs)}/logs?lines=400`} onClose={() => setLogs(null)} />}
    </div>
  );
}

function Updates({ hostId }: { hostId: string }) {
  const [r, setR] = useState<{ manager: string; packages: { name: string; line: string }[]; count: number } | null>(null);
  const [err, setErr] = useState<{ message: string; code?: string } | null>(null);
  const load = () => {
    setR(null);
    api.get<typeof r>(`/api/hosts/${hostId}/updates`).then(setR, (e: Error & { code?: string }) => setErr({ message: e.message, code: e.code }));
  };
  useEffect(load, [hostId]);
  const cmd: Record<string, string> = {
    apt: 'sudo apt update && sudo apt full-upgrade -y',
    dnf: 'sudo dnf upgrade --refresh -y',
    pacman: 'sudo pacman -Syu',
    apk: 'sudo apk update && sudo apk upgrade',
  };
  if (err) return errorBox(err.message, err.code, hostId);
  if (!r) return <Spinner label="Checking for updates (uses the cached package index)…" />;
  return (
    <div class="col">
      <div class="row wrap">
        <Package size={16} />
        <b>{r.count}</b> pending update(s) via <code>{r.manager}</code>
        <span class="grow" />
        {cmd[r.manager] && (
          <button
            class="primary sm"
            onClick={() => {
              const h = hostById(hostId);
              if (h) runOnHost(h, cmd[r.manager]);
            }}
          >
            <TerminalSquare size={14} /> Upgrade in terminal
          </button>
        )}
        <button class="sm icon" onClick={load}>
          <RefreshCw size={14} />
        </button>
      </div>
      {r.manager === 'apt' && <div class="small faint">The list reflects the last `apt update`; run the upgrade to refresh it.</div>}
      {r.packages.length > 0 && <pre class="log-view">{r.packages.map((p) => p.line).join('\n')}</pre>}
    </div>
  );
}
