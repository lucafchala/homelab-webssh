/** Remote system stats: one POSIX sh script, one round trip, parsed server-side. */

export const STATS_SCRIPT = `
export LC_ALL=C
echo @@hostname; hostname 2>/dev/null || cat /etc/hostname 2>/dev/null
echo @@os; ( . /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" ) || uname -s
echo @@kernel; uname -r
echo @@arch; uname -m
echo @@uptime; cat /proc/uptime 2>/dev/null
echo @@loadavg; cat /proc/loadavg 2>/dev/null
echo @@cpuinfo; grep -c ^processor /proc/cpuinfo 2>/dev/null; grep -m1 -E 'model name|Hardware|Model' /proc/cpuinfo 2>/dev/null | cut -d: -f2-
echo @@stat1; head -1 /proc/stat 2>/dev/null
echo @@net1; cat /proc/net/dev 2>/dev/null
sleep 1
echo @@stat2; head -1 /proc/stat 2>/dev/null
echo @@net2; cat /proc/net/dev 2>/dev/null
echo @@meminfo; grep -E '^(MemTotal|MemAvailable|MemFree|Buffers|Cached|SwapTotal|SwapFree):' /proc/meminfo 2>/dev/null
echo @@df; df -P -k -x tmpfs -x devtmpfs -x squashfs -x overlay -x efivarfs 2>/dev/null || df -P -k 2>/dev/null
echo @@temps; for z in /sys/class/thermal/thermal_zone*/temp; do [ -r "$z" ] && echo "$(cat "\${z%/temp}/type" 2>/dev/null) $(cat "$z")"; done
echo @@procs; ps -eo pid,user,pcpu,pmem,comm --sort=-pcpu 2>/dev/null | head -11
echo @@users; who 2>/dev/null | wc -l
echo @@ips; hostname -I 2>/dev/null || ip -o -4 addr show scope global 2>/dev/null | awk '{print $4}'
echo @@features; for c in docker podman systemctl zpool pveversion nvidia-smi; do command -v $c >/dev/null 2>&1 && echo $c; done
echo @@reboot; [ -f /var/run/reboot-required ] && echo yes || echo no
echo @@end
`;

export interface HostStats {
  hostname: string;
  os: string;
  kernel: string;
  arch: string;
  uptimeSec: number | null;
  load: number[] | null;
  cpu: { cores: number | null; model: string | null; usagePct: number | null };
  memory: { totalKb: number; availableKb: number; usedPct: number; swapTotalKb: number; swapUsedKb: number } | null;
  disks: { fs: string; mount: string; sizeKb: number; usedKb: number; availKb: number; usedPct: number }[];
  net: { iface: string; rxBytes: number; txBytes: number; rxBps: number; txBps: number }[];
  temps: { name: string; celsius: number }[];
  processes: { pid: number; user: string; cpu: number; mem: number; command: string }[];
  usersLoggedIn: number | null;
  ips: string[];
  features: string[];
  rebootRequired: boolean;
}

function sections(out: string): Map<string, string[]> {
  const map = new Map<string, string[]>();
  let cur: string[] | null = null;
  for (const line of out.split('\n')) {
    const m = /^@@(\w+)$/.exec(line.trim());
    if (m) {
      cur = [];
      map.set(m[1], cur);
    } else if (cur) {
      cur.push(line);
    }
  }
  return map;
}

function cpuTimes(line: string | undefined): { idle: number; total: number } | null {
  if (!line?.startsWith('cpu')) return null;
  const nums = line.trim().split(/\s+/).slice(1).map(Number);
  if (nums.length < 4 || nums.some((n) => !Number.isFinite(n))) return null;
  const idle = nums[3] + (nums[4] ?? 0);
  return { idle, total: nums.reduce((a, b) => a + b, 0) };
}

function netDev(lines: string[] = []): Map<string, { rx: number; tx: number }> {
  const m = new Map<string, { rx: number; tx: number }>();
  for (const l of lines) {
    const mm = /^\s*([^:\s]+):\s*(.*)$/.exec(l);
    if (!mm) continue;
    const f = mm[2].trim().split(/\s+/).map(Number);
    if (f.length >= 9) m.set(mm[1], { rx: f[0], tx: f[8] });
  }
  return m;
}

export function parseStats(out: string): HostStats {
  const s = sections(out);
  const first = (k: string) => (s.get(k) ?? []).find((l) => l.trim())?.trim() ?? '';

  const uptime = Number.parseFloat(first('uptime').split(/\s+/)[0]);
  const loadParts = first('loadavg').split(/\s+/).slice(0, 3).map(Number);

  const cpuLines = (s.get('cpuinfo') ?? []).map((l) => l.trim()).filter(Boolean);
  const cores = Number.parseInt(cpuLines[0] ?? '', 10);
  const t1 = cpuTimes(first('stat1'));
  const t2 = cpuTimes(first('stat2'));
  let usagePct: number | null = null;
  if (t1 && t2 && t2.total > t1.total) {
    usagePct = Math.round((1 - (t2.idle - t1.idle) / (t2.total - t1.total)) * 1000) / 10;
  }

  const mem: Record<string, number> = {};
  for (const l of s.get('meminfo') ?? []) {
    const m = /^(\w+):\s+(\d+)/.exec(l);
    if (m) mem[m[1]] = Number(m[2]);
  }
  let memory: HostStats['memory'] = null;
  if (mem.MemTotal) {
    const avail = mem.MemAvailable ?? (mem.MemFree ?? 0) + (mem.Buffers ?? 0) + (mem.Cached ?? 0);
    memory = {
      totalKb: mem.MemTotal,
      availableKb: avail,
      usedPct: Math.round(((mem.MemTotal - avail) / mem.MemTotal) * 1000) / 10,
      swapTotalKb: mem.SwapTotal ?? 0,
      swapUsedKb: (mem.SwapTotal ?? 0) - (mem.SwapFree ?? 0),
    };
  }

  const disks: HostStats['disks'] = [];
  for (const l of (s.get('df') ?? []).slice(1)) {
    const f = l.trim().split(/\s+/);
    if (f.length < 6) continue;
    const mount = f.slice(5).join(' ');
    if (/^\/(proc|sys|dev|run)(\/|$)/.test(mount) || mount.startsWith('/snap/') || mount.includes('/docker/')) continue;
    const size = Number(f[1]);
    if (!size) continue;
    disks.push({ fs: f[0], mount, sizeKb: size, usedKb: Number(f[2]), availKb: Number(f[3]), usedPct: Number.parseInt(f[4], 10) });
  }

  const n1 = netDev(s.get('net1'));
  const n2 = netDev(s.get('net2'));
  const net: HostStats['net'] = [];
  for (const [iface, b] of n2) {
    if (iface === 'lo' || /^(veth|br-|docker0$|virbr\d+-nic|tap|fwbr|fwpr|fwln)/.test(iface)) continue;
    const a = n1.get(iface) ?? b;
    net.push({ iface, rxBytes: b.rx, txBytes: b.tx, rxBps: Math.max(0, b.rx - a.rx), txBps: Math.max(0, b.tx - a.tx) });
  }

  const temps: HostStats['temps'] = [];
  for (const l of s.get('temps') ?? []) {
    const m = /^(.*)\s+(-?\d+)$/.exec(l.trim());
    if (!m) continue;
    const v = Number(m[2]);
    const c = Math.abs(v) > 1000 ? v / 1000 : v;
    if (c > -40 && c < 150) temps.push({ name: m[1] || 'zone', celsius: Math.round(c * 10) / 10 });
  }

  const processes: HostStats['processes'] = [];
  for (const l of (s.get('procs') ?? []).slice(1)) {
    const f = l.trim().split(/\s+/);
    if (f.length < 5 || !/^\d+$/.test(f[0])) continue;
    processes.push({ pid: Number(f[0]), user: f[1], cpu: Number(f[2]), mem: Number(f[3]), command: f.slice(4).join(' ') });
  }

  const ips = (s.get('ips') ?? [])
    .join(' ')
    .split(/\s+/)
    .map((x) => x.replace(/\/\d+$/, ''))
    .filter((x) => /^[0-9a-f.:]+$/i.test(x) && !x.startsWith('fe80'));

  return {
    hostname: first('hostname'),
    os: first('os'),
    kernel: first('kernel'),
    arch: first('arch'),
    uptimeSec: Number.isFinite(uptime) ? Math.floor(uptime) : null,
    load: loadParts.length === 3 && loadParts.every(Number.isFinite) ? loadParts : null,
    cpu: { cores: Number.isFinite(cores) ? cores : null, model: cpuLines[1]?.trim() || null, usagePct },
    memory,
    disks,
    net,
    temps,
    processes,
    usersLoggedIn: Number.isFinite(Number.parseInt(first('users'), 10)) ? Number.parseInt(first('users'), 10) : null,
    ips: [...new Set(ips)].slice(0, 10),
    features: (s.get('features') ?? []).map((l) => l.trim()).filter(Boolean),
    rebootRequired: first('reboot') === 'yes',
  };
}

export interface ContainerInfo {
  id: string;
  name: string;
  image: string;
  state: string;
  status: string;
  ports: string;
  createdAt: string;
  project: string | null;
  service: string | null;
}

export function parseDockerPs(out: string): ContainerInfo[] {
  const list: ContainerInfo[] = [];
  for (const line of out.split('\n')) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    try {
      const j = JSON.parse(t) as Record<string, string>;
      const labels = Object.fromEntries(
        (j.Labels ?? '')
          .split(',')
          .map((kv) => kv.split('='))
          .filter((kv) => kv.length >= 2)
          .map(([k, ...v]) => [k, v.join('=')]),
      );
      list.push({
        id: (j.ID ?? '').slice(0, 64),
        name: j.Names ?? '',
        image: j.Image ?? '',
        state: (j.State ?? '').toLowerCase(),
        status: j.Status ?? '',
        ports: j.Ports ?? '',
        createdAt: j.CreatedAt ?? '',
        project: labels['com.docker.compose.project'] ?? null,
        service: labels['com.docker.compose.service'] ?? null,
      });
    } catch {
      /* skip malformed line */
    }
  }
  return list;
}

export interface ServiceInfo {
  unit: string;
  load: string;
  active: string;
  sub: string;
  description: string;
  enabled: string | null;
}

export function parseSystemdUnits(units: string, files: string): ServiceInfo[] {
  const enabled = new Map<string, string>();
  for (const l of files.split('\n')) {
    const f = l.trim().split(/\s+/);
    if (f.length >= 2 && f[0].endsWith('.service')) enabled.set(f[0], f[1]);
  }
  const out: ServiceInfo[] = [];
  for (const l of units.split('\n')) {
    const line = l.replace(/^[●*\s]+/, '').trim();
    const m = /^(\S+\.service)\s+(\S+)\s+(\S+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!m) continue;
    out.push({ unit: m[1], load: m[2], active: m[3], sub: m[4], description: m[5], enabled: enabled.get(m[1]) ?? null });
  }
  return out;
}

/** Last known OS string per host id (filled by the stats endpoint, used as AI context). */
export const hostOsCache = new Map<string, string>();
