/** CodeMirror 6 editor, loaded lazily (its own chunk) only when a file is opened. */
import { EditorView, keymap, lineNumbers, highlightActiveLine, drawSelection, highlightActiveLineGutter } from '@codemirror/view';
import { EditorState, type Extension } from '@codemirror/state';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { bracketMatching, foldGutter, indentOnInput, StreamLanguage, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { oneDark } from '@codemirror/theme-one-dark';
import { json } from '@codemirror/lang-json';
import { yaml } from '@codemirror/lang-yaml';
import { python } from '@codemirror/lang-python';
import { javascript } from '@codemirror/lang-javascript';
import { markdown } from '@codemirror/lang-markdown';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { nginx } from '@codemirror/legacy-modes/mode/nginx';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { sql } from '@codemirror/legacy-modes/mode/sql';

function languageFor(filename: string): Extension | null {
  const name = filename.toLowerCase();
  const base = name.split('/').pop() ?? name;
  if (base === 'dockerfile' || base.startsWith('dockerfile.') || base.endsWith('.dockerfile')) return StreamLanguage.define(dockerFile);
  if (/\.(ya?ml)$/.test(base) || base === 'docker-compose.yml' || base === 'compose.yaml') return yaml();
  if (/\.json5?$/.test(base)) return json();
  if (/\.py$/.test(base)) return python();
  if (/\.(m?js|cjs|ts|tsx|jsx)$/.test(base)) return javascript({ typescript: /\.tsx?$/.test(base), jsx: /x$/.test(base) });
  if (/\.(md|markdown)$/.test(base)) return markdown();
  if (/\.(sh|bash|zsh|ksh)$/.test(base) || /^\.(bash|zsh|profile)/.test(base) || base === '.bashrc' || base === 'profile') return StreamLanguage.define(shell);
  if (/nginx|\.conf$/.test(name) && name.includes('nginx')) return StreamLanguage.define(nginx);
  if (/\.toml$/.test(base)) return StreamLanguage.define(toml);
  if (/\.(ini|cfg|conf|env|properties|service|timer|socket|network|netdev|mount)$/.test(base) || base.startsWith('.env')) return StreamLanguage.define(properties);
  if (/\.sql$/.test(base)) return StreamLanguage.define(sql({}));
  return null;
}

export interface EditorHandle {
  getValue(): string;
  setValue(v: string): void;
  focus(): void;
  destroy(): void;
}

export function createEditor(parent: HTMLElement, opts: { content: string; filename: string; dark: boolean; onSave: () => void; onChange: () => void }): EditorHandle {
  const lang = languageFor(opts.filename);
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: opts.content,
      extensions: [
        lineNumbers(),
        highlightActiveLineGutter(),
        foldGutter(),
        history(),
        drawSelection(),
        indentOnInput(),
        bracketMatching(),
        highlightActiveLine(),
        highlightSelectionMatches(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        EditorView.lineWrapping,
        keymap.of([
          { key: 'Mod-s', preventDefault: true, run: () => (opts.onSave(), true) },
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
          ...searchKeymap,
        ]),
        EditorView.updateListener.of((u) => u.docChanged && opts.onChange()),
        ...(opts.dark ? [oneDark] : []),
        ...(lang ? [lang] : []),
      ],
    }),
  });
  return {
    getValue: () => view.state.doc.toString(),
    setValue: (v) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: v } }),
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
