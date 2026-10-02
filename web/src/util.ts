export function formatBytes(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '–';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = n;
  while (Math.abs(v) >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

export function formatDuration(sec: number | null | undefined): string {
  if (sec === null || sec === undefined) return '–';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m`;
  return `${Math.floor(sec)}s`;
}

export function timeAgo(ts: number | null | undefined): string {
  if (!ts) return 'never';
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(ts).toLocaleDateString();
}

export function formatDate(ts: number | null | undefined): string {
  return ts ? new Date(ts).toLocaleString() : '–';
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // Fallback for non-secure contexts
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | null = null;
  return (...a: A) => {
    if (t) clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

export const isTouch = () => typeof window !== 'undefined' && (window.matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window);
export const isMobileWidth = () => typeof window !== 'undefined' && window.innerWidth < 820;

export function shellQuote(s: string): string {
  return /^[a-zA-Z0-9_./:@%+=,-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

export function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : `${dir}/${name}`;
}

export function hostLabel(h: { username: string; hostname: string; port: number }): string {
  return `${h.username}@${h.hostname}${h.port !== 22 ? `:${h.port}` : ''}`;
}

/** Extract {{name}} / {{name:default}} variables from a snippet. */
export function snippetVars(cmd: string): { name: string; def: string }[] {
  const out = new Map<string, string>();
  for (const m of cmd.matchAll(/\{\{\s*([a-zA-Z_][\w-]*)\s*(?::([^}]*))?\}\}/g)) if (!out.has(m[1])) out.set(m[1], m[2] ?? '');
  return [...out].map(([name, def]) => ({ name, def }));
}

export function fillSnippet(cmd: string, values: Record<string, string>): string {
  return cmd.replace(/\{\{\s*([a-zA-Z_][\w-]*)\s*(?::([^}]*))?\}\}/g, (_m, n: string, d?: string) => values[n] ?? d ?? '');
}

export function classNames(...c: (string | false | null | undefined)[]): string {
  return c.filter(Boolean).join(' ');
}
