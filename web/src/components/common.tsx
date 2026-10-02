import type { ComponentChildren, JSX } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { Check, Copy, CornerDownLeft, TerminalSquare, X } from 'lucide-preact';
import { dialog, toast, toasts } from '../state';
import { copyText, classNames } from '../util';
import { activeController } from '../terminal/engine';

export function Modal(props: { title: ComponentChildren; onClose: () => void; children: ComponentChildren; footer?: ComponentChildren; size?: 'normal' | 'wide' | 'full'; icon?: ComponentChildren }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && props.onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [props.onClose]);
  return (
    <div class="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && props.onClose()}>
      <div class={classNames('modal', props.size === 'wide' && 'wide', props.size === 'full' && 'full')} role="dialog" aria-modal="true">
        <div class="modal-head">
          <h2>
            {props.icon}
            {props.title}
          </h2>
          <button class="ghost icon" onClick={props.onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        <div class="modal-body">{props.children}</div>
        {props.footer && <div class="modal-foot">{props.footer}</div>}
      </div>
    </div>
  );
}

/** Renders the promise-based confirm/prompt dialog from state.dialog. */
export function DialogHost() {
  const d = dialog.value;
  const [values, setValues] = useState<Record<string, string>>({});
  const [typed, setTyped] = useState('');
  useEffect(() => {
    if (d) {
      setValues(Object.fromEntries((d.fields ?? []).map((f) => [f.name, f.value ?? ''])));
      setTyped('');
    }
  }, [d]);
  if (!d) return null;
  const close = (v: Record<string, string> | null) => {
    dialog.value = null;
    d.resolve(v);
  };
  const missing = (d.fields ?? []).some((f) => f.required && !values[f.name]?.trim());
  const blocked = (d.typeToConfirm !== undefined && typed !== d.typeToConfirm) || missing;
  const submit = (e?: Event) => {
    e?.preventDefault();
    if (!blocked) close(values);
  };
  return (
    <Modal
      title={d.title}
      onClose={() => close(null)}
      footer={
        <>
          <button onClick={() => close(null)}>{d.cancelText ?? 'Cancel'}</button>
          <button class={d.danger ? 'danger solid' : 'primary'} disabled={blocked} onClick={() => submit()}>
            {d.confirmText ?? 'OK'}
          </button>
        </>
      }
    >
      <form onSubmit={submit} class="col">
        {d.message && <p style={{ whiteSpace: 'pre-wrap' }}>{d.message}</p>}
        {(d.fields ?? []).map((f, i) => (
          <label key={f.name}>
            {f.label}
            {f.type === 'textarea' ? (
              <textarea class="code" value={values[f.name] ?? ''} placeholder={f.placeholder} onInput={(e) => setValues({ ...values, [f.name]: e.currentTarget.value })} autoFocus={i === 0} />
            ) : (
              <input
                type={f.type ?? 'text'}
                value={values[f.name] ?? ''}
                placeholder={f.placeholder}
                autoFocus={i === 0}
                autoComplete={f.type === 'password' ? 'current-password' : 'off'}
                onInput={(e) => setValues({ ...values, [f.name]: e.currentTarget.value })}
              />
            )}
          </label>
        ))}
        {d.typeToConfirm !== undefined && (
          <label>
            Type <code>{d.typeToConfirm}</code> to confirm
            <input value={typed} onInput={(e) => setTyped(e.currentTarget.value)} autoFocus autoComplete="off" />
          </label>
        )}
        <button type="submit" class="hidden" />
      </form>
    </Modal>
  );
}

export function Toasts() {
  return (
    <div class="toasts" aria-live="polite">
      {toasts.value.map((t) => (
        <div key={t.id} class={classNames('toast', t.kind)}>
          {t.text}
        </div>
      ))}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span class="row dim">
      <span class="spinner" />
      {label}
    </span>
  );
}

export function Empty({ icon, title, children }: { icon?: ComponentChildren; title: string; children?: ComponentChildren }) {
  return (
    <div class="empty">
      {icon}
      <h3>{title}</h3>
      {children && <div class="dim">{children}</div>}
    </div>
  );
}

export function CopyButton({ text, label }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      class="sm ghost icon"
      title="Copy"
      onClick={async () => {
        if (await copyText(text)) {
          setDone(true);
          setTimeout(() => setDone(false), 1200);
        }
      }}
    >
      {done ? <Check size={14} /> : <Copy size={14} />}
      {label}
    </button>
  );
}

/** Insert a command into the active terminal (without pressing Enter unless run=true). */
export function insertIntoTerminal(cmd: string, run = false): boolean {
  const c = activeController();
  if (!c) {
    toast('Open a terminal first', 'error');
    return false;
  }
  c.sendText(cmd.replace(/\n/g, '\r') + (run ? '\r' : ''));
  c.focus();
  return true;
}

export function CommandLine({ cmd, compact }: { cmd: string; compact?: boolean }) {
  return (
    <div class="row" style={{ alignItems: 'flex-start', gap: 4 }}>
      <pre class="mono" style={{ flex: 1, minWidth: 0, fontSize: compact ? 12 : 12.5, background: 'var(--bg-elev)', padding: '6px 8px', borderRadius: 4 }}>
        {cmd}
      </pre>
      <CopyButton text={cmd} />
      <button class="sm ghost icon" title="Insert into terminal" onClick={() => insertIntoTerminal(cmd)}>
        <TerminalSquare size={14} />
      </button>
    </div>
  );
}

// ------------------------------------------------------------------ minimal, XSS-safe Markdown
function inline(text: string, keyBase: string): JSX.Element[] {
  const out: JSX.Element[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*)|(\[[^\]]+\]\((https?:\/\/[^)\s]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(<span key={`${keyBase}-t${i++}`}>{text.slice(last, m.index)}</span>);
    const tok = m[0];
    if (m[1]) out.push(<code key={`${keyBase}-c${i++}`}>{tok.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={`${keyBase}-b${i++}`}>{tok.slice(2, -2)}</strong>);
    else if (m[3]) out.push(<em key={`${keyBase}-i${i++}`}>{tok.slice(1, -1)}</em>);
    else if (m[4]) {
      const label = /^\[([^\]]+)\]/.exec(tok)![1];
      out.push(
        <a key={`${keyBase}-a${i++}`} href={m[5]} target="_blank" rel="noopener noreferrer">
          {label}
        </a>,
      );
    }
    last = m.index + tok.length;
  }
  if (last < text.length) out.push(<span key={`${keyBase}-t${i++}`}>{text.slice(last)}</span>);
  return out;
}

export function CodeBlock({ code, lang, onRun }: { code: string; lang: string; onRun?: (cmd: string) => void }) {
  const shell = /^(bash|sh|shell|zsh|console|)$/.test(lang);
  return (
    <div class="codeblock">
      <div class="cb-head">
        <span class="grow">{lang || 'code'}</span>
        <CopyButton text={code} />
        {shell && (
          <button class="sm ghost icon" title="Insert into terminal (does not run)" onClick={() => insertIntoTerminal(code)}>
            <TerminalSquare size={14} />
          </button>
        )}
        {shell && onRun && (
          <button class="sm ghost icon" title="Run on this host (asks first)" onClick={() => onRun(code)}>
            <CornerDownLeft size={14} />
          </button>
        )}
      </div>
      <pre>{code}</pre>
    </div>
  );
}

export function Markdown({ text, onRun }: { text: string; onRun?: (cmd: string) => void }) {
  const blocks: JSX.Element[] = [];
  const lines = text.split('\n');
  let i = 0;
  let k = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*```(\w*)\s*$/.exec(line);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) code.push(lines[i++]);
      i++;
      blocks.push(<CodeBlock key={k++} code={code.join('\n')} lang={fence[1]} onRun={onRun} />);
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      blocks.push(<h4 key={k++}>{inline(h[2], `h${k}`)}</h4>);
      i++;
      continue;
    }
    if (/^\s*([-*]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line);
      const items: JSX.Element[] = [];
      while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) {
        items.push(<li key={items.length}>{inline(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ''), `l${k}-${items.length}`)}</li>);
        i++;
      }
      blocks.push(ordered ? <ol key={k++}>{items}</ol> : <ul key={k++}>{items}</ul>);
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^\s*```/.test(lines[i]) && !/^(#{1,4})\s/.test(lines[i]) && !/^\s*([-*]|\d+\.)\s+/.test(lines[i])) para.push(lines[i++]);
    blocks.push(<p key={k++}>{inline(para.join('\n'), `p${k}`)}</p>);
  }
  return <div class="md">{blocks}</div>;
}

/** Simple segmented control. */
export function Segmented<T extends string>({ value, options, onChange }: { value: T; options: { value: T; label: ComponentChildren }[]; onChange: (v: T) => void }) {
  return (
    <div class="row" style={{ gap: 2, background: 'var(--bg-hover)', padding: 2, borderRadius: 8 }}>
      {options.map((o) => (
        <button key={o.value} class={classNames('sm', value === o.value ? 'active' : 'ghost')} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [nonce, setNonce] = useState(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    fn().then(
      (data) => alive.current && setState({ data, error: null, loading: false }),
      (err: Error) => alive.current && setState({ data: null, error: err.message, loading: false }),
    );
    return () => {
      alive.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);
  return { ...state, reload: () => setNonce((n) => n + 1) };
}
