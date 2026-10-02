import { COMMANDS, type CommandHelp } from './commands.js';
import { RECIPES, type Recipe } from './recipes.js';
import { KEY_SHEETS, type KeySheet } from './keys.js';

/**
 * Local-first help resolver. Answers simple lookups ("tar", "ss -tulpn",
 * "what is using port 80", "exit vim") from offline data. Only when nothing
 * local is a confident match do we suggest escalating (tldr → man → AI).
 */

const STOP = new Set(
  'a an and are as at be by can do does for from get how i in is it me my of on or show the this to what whats which who why with you your there please want need see find check list'.split(' '),
);

const SYNONYMS: Record<string, string> = {
  ram: 'memory', mem: 'memory', storage: 'disk', drive: 'disk', drives: 'disk', hdd: 'disk', ssd: 'disk', space: 'disk',
  container: 'docker', containers: 'docker', logs: 'log', errors: 'error', ports: 'port', listening: 'port', ip: 'ip',
  restart: 'restart', reboot: 'reboot', update: 'update', upgrade: 'update', updates: 'update', delete: 'remove', remove: 'remove',
  quit: 'exit', leave: 'exit', close: 'exit', processes: 'process', proc: 'process', cpu: 'cpu', temp: 'temperature',
  temperatures: 'temperature', hot: 'temperature', slow: 'slow', crashed: 'crash', crashing: 'crash', failing: 'failed', fails: 'failed',
  keys: 'key', certs: 'certificate', cert: 'certificate', ssl: 'certificate', tls: 'certificate', vms: 'vm', backups: 'backup',
};

export function tokenize(q: string): string[] {
  return q
    .toLowerCase()
    .replace(/[^a-z0-9._+-]+/g, ' ')
    .split(/\s+/)
    .filter((w) => w && !STOP.has(w))
    .map((w) => SYNONYMS[w] ?? w.replace(/(ing|ed|es|s)$/, (m) => (w.length > 5 ? '' : m)));
}

function norm(w: string) {
  return SYNONYMS[w] ?? w.replace(/(ing|ed|es|s)$/, (m) => (w.length > 5 ? '' : m));
}

export interface HelpAnswer {
  query: string;
  /** high = answered locally; low = local hints only; none = nothing local */
  confidence: 'high' | 'low' | 'none';
  command: CommandHelp | null;
  commands: CommandHelp[];
  recipes: Recipe[];
  keySheets: KeySheet[];
  /** First token looks like a program we have no local page for → try tldr / man (free) before AI. */
  lookupName: string | null;
  suggestAi: boolean;
}

function scoreRecipe(tokens: string[], rec: Recipe): number {
  const kw = new Set(rec.keywords.map(norm));
  const title = tokenize(rec.title);
  let s = 0;
  for (const t of tokens) {
    if (kw.has(t)) s += 3;
    else if ([...kw].some((k) => k.length > 3 && (k.startsWith(t) || t.startsWith(k)))) s += 1.5;
    if (title.includes(t)) s += 2;
  }
  return tokens.length ? s / Math.sqrt(tokens.length) : 0;
}

function scoreSheet(tokens: string[], sheet: KeySheet): number {
  let s = 0;
  for (const t of tokens) if (sheet.keywords.includes(t) || sheet.id === t) s += 3;
  return s;
}

export function resolveHelp(query: string): HelpAnswer {
  const q = query.trim();
  const tokens = tokenize(q);
  const firstWord = q.split(/\s+/)[0]?.toLowerCase() ?? '';
  const isCommandLike = /^[a-z0-9][a-z0-9._+-]*$/.test(firstWord) && (q.split(/\s+/).length <= 3 || /^-/.test(q.split(/\s+/)[1] ?? ''));

  // 1) Exact command name ("tar", "docker compose", "ss -tulpn")
  const twoWords = q.toLowerCase().split(/\s+/).slice(0, 2).join(' ');
  const exact = COMMANDS.find((c) => c.name === twoWords) ?? COMMANDS.find((c) => c.name === firstWord) ?? null;

  // 2) Natural-language task → recipes
  const recipes = RECIPES.map((r) => [scoreRecipe(tokens, r), r] as const)
    .filter(([s]) => s >= 2)
    .sort((a, b) => b[0] - a[0])
    .slice(0, 5);

  // 3) Key sheets ("exit vim", "tmux split")
  const keySheets = KEY_SHEETS.map((k) => [scoreSheet(tokens, k), k] as const)
    .filter(([s]) => s > 0)
    .sort((a, b) => b[0] - a[0])
    .slice(0, 2)
    .map(([, k]) => k);

  // 4) Fuzzy command matches
  const commands: CommandHelp[] = [];
  const seen = new Set<string>();
  const add = (c: CommandHelp) => {
    if (!seen.has(c.name)) {
      seen.add(c.name);
      commands.push(c);
    }
  };
  if (exact) add(exact);
  for (const cmd of COMMANDS) {
    if (commands.length >= 8) break;
    const hay = `${cmd.name} ${cmd.summary} ${cmd.category}`.toLowerCase();
    if (tokens.some((t) => t.length > 2 && hay.includes(t))) add(cmd);
  }

  const bestRecipe = recipes[0]?.[0] ?? 0;
  let confidence: HelpAnswer['confidence'] = 'none';
  if (exact || bestRecipe >= 4 || (keySheets.length && tokens.length <= 3)) confidence = 'high';
  else if (recipes.length || commands.length || keySheets.length) confidence = 'low';

  const lookupName = !exact && isCommandLike ? firstWord : null;

  return {
    query: q,
    confidence,
    command: exact,
    commands,
    recipes: recipes.map(([, r]) => r),
    keySheets,
    lookupName,
    // AI is only suggested when local data (and a tldr/man lookup for bare names) can't answer.
    suggestAi: confidence !== 'high' && !lookupName,
  };
}
