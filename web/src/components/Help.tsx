import { useEffect, useState } from 'preact/hooks';
import { AlertTriangle, ArrowLeft, BookOpen, Bot, Globe, Keyboard, ListChecks, Search, TerminalSquare } from 'lucide-preact';
import { api } from '../api';
import { aiSeed, helpQuery, hostById, me, sidePanel } from '../state';
import { activeController, activeTab, tabs } from '../terminal/engine';
import type { CommandHelp, HelpAnswer, KeySheet, Recipe, TldrPage } from '../types';
import { debounce } from '../util';
import { CommandLine, Spinner } from './common';

interface IndexData {
  categories: string[];
  commands: { name: string; category: string; summary: string }[];
  recipes: { id: string; title: string; category: string }[];
  keySheets: { id: string; title: string }[];
}

let indexCache: IndexData | null = null;

function activeHostId(): string | null {
  const t = tabs.value.find((x) => x.key === activeTab.value);
  return t?.hostId ?? null;
}

function CommandCard({ c }: { c: CommandHelp }) {
  return (
    <div class="help-cmd">
      <div class="row between">
        <h3>{c.name}</h3>
        <span class="badge">{c.category}</span>
      </div>
      <p class="dim" style={{ marginBottom: 6 }}>
        {c.summary}
      </p>
      <code class="small">{c.usage}</code>
      {c.danger && (
        <div class="alert warn small mt row" style={{ alignItems: 'flex-start' }}>
          <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} /> {c.danger}
        </div>
      )}
      {c.examples.length > 0 && (
        <div class="mt">
          <div class="small dim" style={{ fontWeight: 600 }}>
            Examples
          </div>
          {c.examples.map(([cmd, desc]) => (
            <div class="example" key={cmd}>
              <div class="grow">
                <div class="desc">{desc}</div>
                <CommandLine cmd={cmd} compact />
              </div>
            </div>
          ))}
        </div>
      )}
      {c.options.length > 0 && (
        <details class="mt">
          <summary class="small dim" style={{ cursor: 'pointer', fontWeight: 600 }}>
            Common options ({c.options.length})
          </summary>
          <div class="opt-list mt">
            {c.options.map(([o, d]) => [<code key={o + 'o'}>{o}</code>, <span key={o + 'd'}>{d}</span>])}
          </div>
        </details>
      )}
      {c.related?.length ? (
        <div class="small faint mt">
          See also:{' '}
          {c.related.map((r, i) => (
            <a key={r} href="#" onClick={(e) => (e.preventDefault(), (helpQuery.value = r))}>
              {r}
              {i < c.related!.length - 1 ? ', ' : ''}
            </a>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function RecipeCard({ r }: { r: Recipe }) {
  return (
    <div class="help-cmd">
      <div class="row between">
        <h3 style={{ fontFamily: 'var(--font)' }} class="row">
          <ListChecks size={16} /> {r.title}
        </h3>
        <span class="badge">{r.category}</span>
      </div>
      {r.steps.map((s, i) => (
        <div class="example" key={i}>
          <div class="grow">
            <div class="desc">
              {i + 1}. {s.text}
            </div>
            {s.command && <CommandLine cmd={s.command} compact />}
          </div>
        </div>
      ))}
      {r.note && <div class="alert info small mt">{r.note}</div>}
      <div class="small faint mt">Replace &lt;placeholders&gt; before running.</div>
    </div>
  );
}

function KeySheetCard({ k }: { k: KeySheet }) {
  return (
    <div class="help-cmd">
      <h3 class="row" style={{ fontFamily: 'var(--font)' }}>
        <Keyboard size={16} /> {k.title}
      </h3>
      {k.sections.map((s) => (
        <div key={s.title} class="mt">
          <div class="small dim" style={{ fontWeight: 600 }}>
            {s.title}
          </div>
          <div class="opt-list mt">{s.keys.map(([key, d]) => [<kbd key={key + 'k'}>{key}</kbd>, <span key={key + 'd'}>{d}</span>])}</div>
        </div>
      ))}
    </div>
  );
}

function TldrCard({ p }: { p: TldrPage }) {
  return (
    <div class="help-cmd">
      <div class="row between">
        <h3>{p.name}</h3>
        <span class="badge blue">tldr</span>
      </div>
      <p class="dim">{p.description}</p>
      {p.examples.map((e) => (
        <div class="example" key={e.command}>
          <div class="grow">
            <div class="desc">{e.description}</div>
            <CommandLine cmd={e.command} compact />
          </div>
        </div>
      ))}
      {p.moreInfo && (
        <a class="small" href={p.moreInfo} target="_blank" rel="noopener noreferrer">
          More information
        </a>
      )}
    </div>
  );
}

function ManView({ name, onBack }: { name: string; onBack: () => void }) {
  const hostId = activeHostId();
  const [state, setState] = useState<{ text?: string; error?: string; loading: boolean; mode: 'man' | 'help' }>({ loading: true, mode: 'man' });
  const load = (mode: 'man' | 'help') => {
    if (!hostId) return setState({ loading: false, error: 'Open a terminal to a host first — the manual is read from that host.', mode });
    setState({ loading: true, mode });
    api.get<{ text: string }>(`/api/help/man/${hostId}/${encodeURIComponent(name)}?mode=${mode}`).then(
      (r) => setState({ loading: false, text: r.text, mode }),
      (err: Error) => setState({ loading: false, error: err.message, mode }),
    );
  };
  useEffect(() => load('man'), [name, hostId]);
  return (
    <div class="col">
      <div class="row">
        <button class="sm ghost" onClick={onBack}>
          <ArrowLeft size={14} /> Back
        </button>
        <b class="grow mono">
          {state.mode === 'man' ? 'man' : ''} {name} {state.mode === 'help' && '--help'}
        </b>
        <span class="small faint">{hostById(hostId)?.name}</span>
      </div>
      {state.loading && <Spinner label="Reading from host…" />}
      {state.error && (
        <div class="alert error small">
          {state.error}
          {state.mode === 'man' && hostId && (
            <div class="mt">
              <button class="sm" onClick={() => load('help')}>
                Try {name} --help
              </button>
            </div>
          )}
        </div>
      )}
      {state.text && <pre class="log-view" style={{ maxHeight: 'none' }}>{state.text}</pre>}
    </div>
  );
}

const search = debounce(async (q: string, set: (a: HelpAnswer | null) => void) => {
  try {
    set(await api.get<HelpAnswer>(`/api/help/search?q=${encodeURIComponent(q)}`));
  } catch {
    set(null);
  }
}, 220);

export function HelpPanel() {
  const [q, setQ] = useState(helpQuery.value);
  const [answer, setAnswer] = useState<HelpAnswer | null>(null);
  const [tldr, setTldr] = useState<{ name: string; page: TldrPage | null; loading: boolean } | null>(null);
  const [man, setMan] = useState<string | null>(null);
  const [index, setIndex] = useState<IndexData | null>(indexCache);
  const [detail, setDetail] = useState<CommandHelp | Recipe | KeySheet | null>(null);
  const ai = me.value?.features.ai;

  useEffect(() => {
    if (helpQuery.value) {
      setQ(helpQuery.value);
      helpQuery.value = '';
      setMan(null);
      setDetail(null);
    }
  }, [helpQuery.value]);

  useEffect(() => {
    if (!index) api.get<IndexData>('/api/help/index').then((d) => ((indexCache = d), setIndex(d)));
  }, []);

  useEffect(() => {
    setTldr(null);
    if (!q.trim()) return setAnswer(null);
    search(q, setAnswer);
  }, [q]);

  // Free fallback for unknown command names: tldr-pages (no AI involved).
  useEffect(() => {
    const name = answer?.lookupName;
    if (!name || !me.value?.features.tldr) return;
    setTldr({ name, page: null, loading: true });
    api.get<TldrPage>(`/api/help/tldr/${encodeURIComponent(name)}`).then(
      (page) => setTldr({ name, page, loading: false }),
      () => setTldr({ name, page: null, loading: false }),
    );
  }, [answer?.lookupName]);

  const askAi = () => {
    aiSeed.value = { text: q, mode: /^(how|what|why|which|can|is|are|show|list|find|check|set|make|create)\b/i.test(q) || q.split(' ').length > 3 ? 'generate' : 'chat' };
    sidePanel.value = 'ai';
  };

  if (man) return <ManView name={man} onBack={() => setMan(null)} />;

  if (detail) {
    return (
      <div class="col">
        <button class="sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setDetail(null)}>
          <ArrowLeft size={14} /> Back
        </button>
        {'usage' in detail ? <CommandCard c={detail} /> : 'steps' in detail ? <RecipeCard r={detail} /> : <KeySheetCard k={detail} />}
      </div>
    );
  }

  const nothingLocal = answer && !answer.command && !answer.recipes.length && !answer.keySheets.length && !answer.commands.length;
  const tldrMissing = tldr && !tldr.loading && !tldr.page;

  return (
    <div class="col">
      <div style={{ position: 'relative' }}>
        <Search size={14} style={{ position: 'absolute', left: 9, top: 10, color: 'var(--text-faint)' }} />
        <input
          autoFocus
          value={q}
          onInput={(e) => setQ(e.currentTarget.value)}
          placeholder="Command or task… e.g. tar, what is using port 80"
          style={{ paddingLeft: 28 }}
          autoCapitalize="off"
          autoCorrect="off"
        />
      </div>

      {!q && (
        <div class="col">
          <div class="small dim">
            Instant offline help — no AI needed for everyday commands. Try <a href="#" onClick={(e) => (e.preventDefault(), setQ('disk is full'))}>disk is full</a>,{' '}
            <a href="#" onClick={(e) => (e.preventDefault(), setQ('ss'))}>ss</a>, <a href="#" onClick={(e) => (e.preventDefault(), setQ('exit vim'))}>exit vim</a>.
          </div>
          {index && (
            <>
              <div class="group-label">Common tasks</div>
              {index.recipes.slice(0, 14).map((r) => (
                <a key={r.id} href="#" class="small" onClick={(e) => (e.preventDefault(), api.get<Recipe>(`/api/help/recipes/${r.id}`).then(setDetail))}>
                  {r.title}
                </a>
              ))}
              <div class="group-label">Keyboard cheat sheets</div>
              <div class="row wrap">
                {index.keySheets.map((k) => (
                  <button key={k.id} class="sm" onClick={() => api.get<KeySheet>(`/api/help/keys/${k.id}`).then(setDetail)}>
                    {k.title.split(' (')[0]}
                  </button>
                ))}
              </div>
              <div class="group-label">Commands by category</div>
              {index.categories.map((cat) => (
                <details key={cat}>
                  <summary class="small" style={{ cursor: 'pointer', padding: '3px 0' }}>
                    {cat} <span class="faint">({index.commands.filter((c) => c.category === cat).length})</span>
                  </summary>
                  <div class="col" style={{ gap: 2, padding: '4px 0 6px 12px' }}>
                    {index.commands
                      .filter((c) => c.category === cat)
                      .map((c) => (
                        <a key={c.name} href="#" class="small" onClick={(e) => (e.preventDefault(), api.get<CommandHelp>(`/api/help/commands/${encodeURIComponent(c.name)}`).then(setDetail))}>
                          <code>{c.name}</code> <span class="dim">— {c.summary}</span>
                        </a>
                      ))}
                  </div>
                </details>
              ))}
            </>
          )}
        </div>
      )}

      {answer && (
        <>
          {answer.command && <CommandCard c={answer.command} />}
          {answer.keySheets.map((k) => (
            <KeySheetCard key={k.id} k={k} />
          ))}
          {answer.recipes.slice(0, answer.confidence === 'high' ? 2 : 3).map((r) => (
            <RecipeCard key={r.id} r={r} />
          ))}
          {tldr?.loading && <Spinner label={`Looking up ${tldr.name} on tldr-pages…`} />}
          {tldr?.page && <TldrCard p={tldr.page} />}
          {answer.commands.filter((c) => c.name !== answer.command?.name).length > 0 && (
            <div>
              <div class="group-label">Related commands</div>
              {answer.commands
                .filter((c) => c.name !== answer.command?.name)
                .slice(0, 6)
                .map((c) => (
                  <a key={c.name} href="#" class="small" style={{ display: 'block', padding: '2px 0' }} onClick={(e) => (e.preventDefault(), setDetail(c))}>
                    <code>{c.name}</code> <span class="dim">— {c.summary}</span>
                  </a>
                ))}
            </div>
          )}

          <div class="card small col" style={{ gap: 6 }}>
            {(answer.lookupName || answer.command) && (
              <button class="sm" onClick={() => setMan(answer.command?.name.split(' ')[0] ?? answer.lookupName!)} disabled={!activeController()}>
                <BookOpen size={14} /> Read the manual on {hostById(activeHostId())?.name ?? 'the connected host'}
              </button>
            )}
            {nothingLocal && !answer.lookupName && <div class="dim">Nothing in the offline guide matches that.</div>}
            {tldrMissing && <div class="dim">No tldr page for “{tldr!.name}”.</div>}
            {ai && (answer.suggestAi || tldrMissing) ? (
              <button class="primary sm" onClick={askAi}>
                <Bot size={14} /> Ask the AI assistant
              </button>
            ) : ai ? (
              <a href="#" class="faint" onClick={(e) => (e.preventDefault(), askAi())}>
                Not what you need? Ask the AI
              </a>
            ) : (
              (answer.suggestAi || tldrMissing) && (
                <a class="dim" href={`https://www.google.com/search?q=${encodeURIComponent('linux ' + q)}`} target="_blank" rel="noopener noreferrer">
                  <Globe size={12} /> Search the web
                </a>
              )
            )}
          </div>
        </>
      )}

      <div class="small faint mt row">
        <TerminalSquare size={12} /> Tip: select text in the terminal and press <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>H</kbd> to look it up.
      </div>
    </div>
  );
}
