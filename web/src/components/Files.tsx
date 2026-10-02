import { useEffect, useRef, useState } from 'preact/hooks';
import {
  ArrowUp, Download, Eye, EyeOff, File, FileCode, FilePlus, Folder, FolderOpen, FolderPlus, Link2, Lock, Pencil, RefreshCw, Save, TerminalSquare, TextCursorInput, Trash2, Upload,
} from 'lucide-preact';
import { api, uploadFile } from '../api';
import { confirmDialog, focusHostId, hostById, hosts, me, prefs, promptDialog, toast } from '../state';
import { activeTab, openTerminal, runOnHost, tabs } from '../terminal/engine';
import { classNames, formatBytes, formatDate, joinPath, shellQuote } from '../util';
import { CopyButton, Empty, Modal, Spinner } from './common';
import type { EditorHandle } from './editor';

interface Entry {
  name: string;
  type: 'file' | 'dir' | 'link' | 'other';
  isLink: boolean;
  target: string | null;
  size: number;
  mtime: number;
  mode: number;
  perms: string;
  owner: string;
  group: string;
}

const lastPath = new Map<string, string>();

function HostPicker({ value, onChange }: { value: string | null; onChange: (id: string) => void }) {
  return (
    <select value={value ?? ''} onChange={(e) => onChange(e.currentTarget.value)} style={{ width: 'auto', minWidth: 160 }}>
      <option value="" disabled>
        Choose host…
      </option>
      {hosts.value.map((h) => (
        <option key={h.id} value={h.id}>
          {h.name}
        </option>
      ))}
    </select>
  );
}

export function useFocusHost(): [string | null, (id: string) => void] {
  const fromTab = tabs.value.find((t) => t.key === activeTab.value)?.hostId ?? null;
  const id = focusHostId.value ?? fromTab ?? hosts.value[0]?.id ?? null;
  return [id, (v: string) => (focusHostId.value = v)];
}

export function FilesPage() {
  const [hostId, setHostId] = useFocusHost();
  const host = hostById(hostId);
  const [path, setPath] = useState<string>('');
  const [data, setData] = useState<{ path: string; parent: string | null; entries: Entry[] } | null>(null);
  const [error, setError] = useState<{ message: string; code?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [hidden, setHidden] = useState(false);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [drag, setDrag] = useState(false);
  const [uploads, setUploads] = useState<{ name: string; pct: number }[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const fileInput = useRef<HTMLInputElement>(null);

  const load = async (p?: string) => {
    if (!hostId) return;
    setLoading(true);
    setError(null);
    try {
      const target = p ?? path ?? '';
      const r = await api.get<{ path: string; parent: string | null; entries: Entry[] }>(`/api/sftp/${hostId}/list?path=${encodeURIComponent(target || '.')}&hidden=${hidden ? 1 : 0}`);
      setData(r);
      setPath(r.path);
      lastPath.set(hostId, r.path);
      setSel(new Set());
    } catch (err) {
      const e = err as Error & { code?: string };
      setError({ message: e.message, code: e.code });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    setData(null);
    setPath(hostId ? (lastPath.get(hostId) ?? '') : '');
    if (hostId) void load(lastPath.get(hostId) ?? '');
  }, [hostId]);
  useEffect(() => {
    if (data) void load(path);
  }, [hidden]);

  if (!hosts.value.length) return <Empty title="No hosts" icon={<FolderOpen size={40} />} />;

  const entries = (data?.entries ?? []).filter((e) => !filter || e.name.toLowerCase().includes(filter.toLowerCase()));
  const full = (name: string) => joinPath(path, name);
  const selected = [...sel];

  const open = (e: Entry) => {
    if (e.type === 'dir') void load(full(e.name));
    else setEditing(full(e.name));
  };
  const download = (name: string) => {
    const a = document.createElement('a');
    a.href = `/api/sftp/${hostId}/download?path=${encodeURIComponent(full(name))}`;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
  };
  const doUpload = async (files: FileList | File[]) => {
    if (!hostId) return;
    for (const f of Array.from(files)) {
      if (f.size > (me.value?.features.maxUploadBytes ?? Infinity)) {
        toast(`${f.name} is larger than the upload limit`, 'error');
        continue;
      }
      setUploads((u) => [...u, { name: f.name, pct: 0 }]);
      const url = (overwrite: boolean) => `/api/sftp/${hostId}/upload?path=${encodeURIComponent(path)}${overwrite ? '&overwrite=1' : ''}`;
      const progress = (pct: number) => setUploads((u) => u.map((x) => (x.name === f.name ? { ...x, pct } : x)));
      try {
        await uploadFile(url(false), f, progress).catch(async (err) => {
          if (err.code === 'EXISTS' && (await confirmDialog({ title: `Overwrite ${f.name}?`, message: 'A file with that name already exists here.', confirmText: 'Overwrite', danger: true }))) {
            return uploadFile(url(true), f, progress);
          }
          throw err;
        });
        toast(`Uploaded ${f.name}`, 'success');
      } catch (err) {
        if ((err as Error & { code?: string }).code !== 'EXISTS') toast(`${f.name}: ${(err as Error).message}`, 'error');
      } finally {
        setUploads((u) => u.filter((x) => x.name !== f.name));
      }
    }
    void load(path);
  };
  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) toast(ok, 'success');
      await load(path);
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const mkdir = async () => {
    const r = await promptDialog({ title: 'New folder', fields: [{ name: 'name', label: 'Name', required: true }] });
    if (r) await act(() => api.post(`/api/sftp/${hostId}/mkdir`, { path: full(r.name.trim()) }));
  };
  const touch = async () => {
    const r = await promptDialog({ title: 'New file', fields: [{ name: 'name', label: 'Name', required: true, placeholder: 'docker-compose.yml' }] });
    if (r) {
      await act(() => api.post(`/api/sftp/${hostId}/touch`, { path: full(r.name.trim()) }));
      setEditing(full(r.name.trim()));
    }
  };
  const rename = async (name: string) => {
    const r = await promptDialog({ title: `Rename ${name}`, fields: [{ name: 'to', label: 'New name or path', value: name, required: true }] });
    if (r && r.to !== name) await act(() => api.post(`/api/sftp/${hostId}/rename`, { from: full(name), to: r.to.startsWith('/') ? r.to : full(r.to) }));
  };
  const chmod = async (e: Entry) => {
    const r = await promptDialog({ title: `Permissions of ${e.name}`, message: `Current: ${e.perms} (${e.mode.toString(8)})`, fields: [{ name: 'mode', label: 'Octal mode', value: e.mode.toString(8).padStart(3, '0'), required: true }] });
    if (r) await act(() => api.post(`/api/sftp/${hostId}/chmod`, { path: full(e.name), mode: r.mode.trim() }));
  };
  const remove = async (names: string[]) => {
    const dirs = data?.entries.filter((e) => names.includes(e.name) && e.type === 'dir' && !e.isLink).length ?? 0;
    const ok = await confirmDialog({
      title: `Delete ${names.length === 1 ? names[0] : `${names.length} items`}?`,
      message: `${dirs ? `${dirs} folder(s) will be deleted with everything inside.\n` : ''}This cannot be undone.`,
      danger: true,
      confirmText: 'Delete',
      typeToConfirm: dirs ? 'delete' : undefined,
    });
    if (ok) await act(() => api.post(`/api/sftp/${hostId}/delete`, { paths: names.map(full), recursive: dirs > 0 }), 'Deleted');
  };
  const cdInTerminal = () => {
    if (host) runOnHost(host, `cd ${shellQuote(path)}\r`);
  };

  const crumbs = path.split('/').filter(Boolean);

  return (
    <div
      class="page"
      style={{ position: 'relative', minHeight: '100%' }}
      onDragOver={(e) => (e.preventDefault(), setDrag(true))}
      onDragLeave={(e) => e.currentTarget === e.target && setDrag(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDrag(false);
        if (e.dataTransfer?.files.length) void doUpload(e.dataTransfer.files);
      }}
    >
      {drag && <div class="drop-zone">Drop files to upload to {path}</div>}
      <div class="page-header">
        <h1>
          <FolderOpen size={22} /> Files
        </h1>
        <HostPicker value={hostId} onChange={setHostId} />
      </div>

      {error ? (
        <div class="alert error">
          {error.message}
          {(error.code === 'HOST_KEY_UNKNOWN' || error.code === 'AUTH_FAILED') && host && (
            <div class="mt">
              <button class="primary sm" onClick={() => openTerminal(host)}>
                <TerminalSquare size={14} /> Open a terminal first
              </button>
            </div>
          )}
          <button class="sm mt" onClick={() => load(path)}>
            Retry
          </button>
        </div>
      ) : (
        <>
          <div class="row wrap mb">
            <button class="icon" title="Up" disabled={!data?.parent} onClick={() => data?.parent && load(data.parent)}>
              <ArrowUp size={16} />
            </button>
            <div class="breadcrumbs grow card" style={{ padding: '2px 6px' }}>
              <button onClick={() => load('/')}>/</button>
              {crumbs.map((c, i) => (
                <span key={i} class="row" style={{ gap: 2 }}>
                  <button onClick={() => load('/' + crumbs.slice(0, i + 1).join('/'))}>{c}</button>
                  {i < crumbs.length - 1 && <span class="faint">/</span>}
                </span>
              ))}
              <span class="grow" />
              <CopyButton text={path} />
            </div>
            <input placeholder="Filter" value={filter} onInput={(e) => setFilter(e.currentTarget.value)} style={{ width: 130 }} />
          </div>
          <div class="row wrap mb">
            <button class="primary" onClick={() => fileInput.current?.click()}>
              <Upload size={15} /> Upload
            </button>
            <input ref={fileInput} type="file" multiple class="hidden" onChange={(e) => e.currentTarget.files && doUpload(e.currentTarget.files)} />
            <button onClick={mkdir}>
              <FolderPlus size={15} /> <span class="hide-mobile">Folder</span>
            </button>
            <button onClick={touch}>
              <FilePlus size={15} /> <span class="hide-mobile">File</span>
            </button>
            <button class="icon" onClick={() => load(path)} title="Refresh">
              {loading ? <span class="spinner" /> : <RefreshCw size={15} />}
            </button>
            <button class="icon" onClick={() => setHidden(!hidden)} title={hidden ? 'Hide dotfiles' : 'Show dotfiles'}>
              {hidden ? <Eye size={15} /> : <EyeOff size={15} />}
            </button>
            <button onClick={cdInTerminal} title="cd here in the terminal">
              <TerminalSquare size={15} /> <span class="hide-mobile">cd here</span>
            </button>
            {selected.length > 0 && (
              <>
                <span class="dim small">{selected.length} selected</span>
                {selected.length === 1 && (
                  <button onClick={() => download(selected[0])}>
                    <Download size={15} />
                  </button>
                )}
                <button class="danger" onClick={() => remove(selected)}>
                  <Trash2 size={15} /> Delete
                </button>
              </>
            )}
          </div>
          {uploads.map((u) => (
            <div key={u.name} class="row small mb">
              <span class="truncate" style={{ width: 200 }}>
                {u.name}
              </span>
              <div class="progress grow">
                <div style={{ width: `${u.pct}%` }} />
              </div>
              {u.pct}%
            </div>
          ))}
          {!data && loading && <Spinner label="Loading…" />}
          {data && (
            <div class="table-wrap">
              <table class="table">
                <thead>
                  <tr>
                    <th style={{ width: 28 }}>
                      <input
                        type="checkbox"
                        checked={sel.size > 0 && sel.size === entries.length}
                        onChange={(e) => setSel(e.currentTarget.checked ? new Set(entries.map((x) => x.name)) : new Set())}
                      />
                    </th>
                    <th>Name</th>
                    <th class="hide-sm">Size</th>
                    <th class="hide-sm">Modified</th>
                    <th class="hide-sm">Permissions</th>
                    <th class="hide-sm">Owner</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {!entries.length && (
                    <tr>
                      <td colSpan={7} class="dim center" style={{ padding: 24 }}>
                        Empty folder — drop files here to upload
                      </td>
                    </tr>
                  )}
                  {entries.map((e) => (
                    <tr key={e.name} class={classNames('file-row', sel.has(e.name) && 'selected')} onDblClick={() => open(e)}>
                      <td onClick={(ev) => ev.stopPropagation()}>
                        <input
                          type="checkbox"
                          checked={sel.has(e.name)}
                          onChange={() => {
                            const n = new Set(sel);
                            if (n.has(e.name)) n.delete(e.name);
                            else n.add(e.name);
                            setSel(n);
                          }}
                        />
                      </td>
                      <td onClick={() => open(e)}>
                        <div class="file-name">
                          {e.type === 'dir' ? <Folder size={16} color="var(--accent)" /> : /\.(ya?ml|json|conf|sh|py|js|ts|env|toml|ini)$/.test(e.name) ? <FileCode size={16} /> : <File size={16} class="dim" />}
                          <span class="truncate">{e.name}</span>
                          {e.isLink && (
                            <span class="faint small truncate" title={e.target ?? ''}>
                              <Link2 size={11} /> {e.target}
                            </span>
                          )}
                        </div>
                      </td>
                      <td class="hide-sm nowrap dim">{e.type === 'dir' ? '' : formatBytes(e.size)}</td>
                      <td class="hide-sm nowrap dim">{formatDate(e.mtime * 1000)}</td>
                      <td class="hide-sm mono dim small" onClick={() => chmod(e)} style={{ cursor: 'pointer' }} title="Change permissions">
                        {e.perms}
                      </td>
                      <td class="hide-sm dim small">
                        {e.owner}:{e.group}
                      </td>
                      <td class="nowrap" style={{ textAlign: 'right' }}>
                        {e.type !== 'dir' && (
                          <button class="sm ghost icon" title="Edit" onClick={() => setEditing(full(e.name))}>
                            <Pencil size={14} />
                          </button>
                        )}
                        <button class="sm ghost icon" title={e.type === 'dir' ? 'Download as .tar.gz' : 'Download'} onClick={() => download(e.name)}>
                          <Download size={14} />
                        </button>
                        <button class="sm ghost icon hide-mobile" title="Rename / move" onClick={() => rename(e.name)}>
                          <TextCursorInput size={14} />
                        </button>
                        <button class="sm ghost icon" title="Delete" onClick={() => remove([e.name])}>
                          <Trash2 size={14} />
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
      {editing && hostId && <EditorModal hostId={hostId} path={editing} onClose={() => (setEditing(null), load(path))} />}
    </div>
  );
}

export function EditorModal({ hostId, path, onClose }: { hostId: string; path: string; onClose: () => void }) {
  const host = hostById(hostId);
  const hostRef = useRef<HTMLDivElement>(null);
  const editor = useRef<EditorHandle | null>(null);
  const [meta, setMeta] = useState<{ mtime: number; size: number; binary: boolean } | null>(null);
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sudo, setSudo] = useState(false);

  const load = async (useSudo: boolean) => {
    setError('');
    try {
      const r = await api.get<{ content: string; mtime: number; size: number; binary: boolean }>(`/api/sftp/${hostId}/read?path=${encodeURIComponent(path)}${useSudo ? '&sudo=1' : ''}`);
      setMeta(r);
      if (r.binary) return;
      const { createEditor } = await import('./editor');
      editor.current?.destroy();
      if (!hostRef.current) return;
      hostRef.current.innerHTML = '';
      editor.current = createEditor(hostRef.current, {
        content: r.content,
        filename: path,
        dark: document.documentElement.dataset.theme !== 'light',
        onSave: () => void save(),
        onChange: () => setDirty(true),
      });
      setDirty(false);
      editor.current.focus();
    } catch (err) {
      const e = err as Error & { status?: number };
      setError(e.message + (e.status === 403 && host?.useSudo ? ' — try "Open with sudo".' : ''));
    }
  };

  const saveRef = useRef<() => Promise<void>>();
  const save = async (force = false) => {
    if (!editor.current || !meta) return;
    setSaving(true);
    try {
      const r = await api.put<{ mtime?: number }>(`/api/sftp/${hostId}/write`, { path, content: editor.current.getValue(), expectedMtime: force || sudo ? undefined : meta.mtime, sudo });
      if (r.mtime) setMeta({ ...meta, mtime: r.mtime });
      setDirty(false);
      toast(`Saved ${path}`, 'success');
    } catch (err) {
      const e = err as Error & { code?: string };
      if (e.code === 'MODIFIED') {
        if (await confirmDialog({ title: 'File changed on the server', message: 'Someone (or something) modified this file after you opened it. Overwrite their changes?', danger: true, confirmText: 'Overwrite' })) await save(true);
      } else toast(e.message, 'error');
    } finally {
      setSaving(false);
    }
  };
  saveRef.current = save;

  useEffect(() => {
    void load(false);
    return () => editor.current?.destroy();
  }, [path]);

  const close = async () => {
    if (dirty && !(await confirmDialog({ title: 'Discard unsaved changes?', danger: true, confirmText: 'Discard' }))) return;
    onClose();
  };

  return (
    <Modal
      title={<span class="mono truncate">{path}</span>}
      icon={<FileCode size={18} />}
      onClose={close}
      size="full"
      footer={
        <>
          <span class="small faint grow">
            {host?.name} {meta && `· ${formatBytes(meta.size)}`} {sudo && '· sudo'} · Ctrl/⌘+S to save
          </span>
          {host?.useSudo && !sudo && (
            <button onClick={() => (setSudo(true), load(true))}>
              <Lock size={14} /> Open with sudo
            </button>
          )}
          <button onClick={close}>Close</button>
          <button class="primary" onClick={() => save()} disabled={saving || !dirty}>
            <Save size={14} /> {saving ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      {error && <div class="alert error mb">{error}</div>}
      {meta?.binary && <div class="alert warn">This looks like a binary file — download it instead.</div>}
      <div ref={hostRef} class="editor-host" style={{ height: 'calc(88vh - 140px)', fontSize: prefs.value.fontSize - 1 }} />
    </Modal>
  );
}
