/**
 * tldr-pages (https://tldr.sh, CC BY 4.0) fetched on demand from GitHub and
 * cached in memory. Free community-maintained examples for ~5000 commands.
 */
export interface TldrPage {
  name: string;
  description: string;
  moreInfo: string | null;
  examples: { description: string; command: string }[];
  platform: string;
}

const cache = new Map<string, { page: TldrPage | null; at: number }>();
const TTL = 24 * 3600_000;

export function parseTldr(md: string, platform: string): TldrPage {
  const lines = md.split('\n');
  let name = '';
  const desc: string[] = [];
  let moreInfo: string | null = null;
  const examples: TldrPage['examples'] = [];
  let pending = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('# ')) name = line.slice(2).trim();
    else if (line.startsWith('> ')) {
      const t = line.slice(2).trim();
      const m = /More information: <(.+)>/.exec(t);
      if (m) moreInfo = m[1];
      else desc.push(t);
    } else if (line.startsWith('- ')) pending = line.slice(2).replace(/:$/, '').trim();
    else if (line.startsWith('`') && line.endsWith('`')) {
      // {{placeholder}} → <placeholder>
      examples.push({ description: pending, command: line.slice(1, -1).replace(/\{\{(.*?)\}\}/g, '<$1>') });
      pending = '';
    }
  }
  return { name, description: desc.join(' '), moreInfo, examples, platform };
}

export async function fetchTldr(baseUrl: string, name: string): Promise<TldrPage | null> {
  const key = name.toLowerCase();
  if (!/^[a-z0-9][a-z0-9._+-]{0,63}$/.test(key)) return null;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.page;
  let page: TldrPage | null = null;
  for (const platform of ['common', 'linux']) {
    try {
      const res = await fetch(`${baseUrl}/${platform}/${encodeURIComponent(key)}.md`, { signal: AbortSignal.timeout(8000) });
      if (res.ok) {
        page = parseTldr(await res.text(), platform);
        break;
      }
    } catch {
      /* offline — fall through */
    }
  }
  cache.set(key, { page, at: Date.now() });
  if (cache.size > 2000) cache.delete(cache.keys().next().value!);
  return page;
}
