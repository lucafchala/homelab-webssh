import { useState } from 'preact/hooks';
import { Download, KeyRound, Plus, Trash2, Upload } from 'lucide-preact';
import { api } from '../api';
import { confirmDialog, hosts, keys, loadHosts, loadKeys, promptDialog, toast } from '../state';
import type { SshKey } from '../types';
import { formatDate } from '../util';
import { CopyButton, Empty, Modal } from './common';

function ImportKey({ onClose }: { onClose: () => void }) {
  const [f, setF] = useState({ name: '', privateKey: '', passphrase: '' });
  const [error, setError] = useState('');
  const save = async () => {
    try {
      await api.post('/api/keys/import', { name: f.name || 'Imported key', privateKey: f.privateKey, passphrase: f.passphrase || undefined });
      await loadKeys();
      onClose();
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Modal
      title="Import private key"
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Cancel</button>
          <button class="primary" onClick={save} disabled={!f.privateKey.trim()}>
            Import
          </button>
        </>
      }
    >
      <div class="col">
        {error && <div class="alert error">{error}</div>}
        <label>
          Name
          <input value={f.name} onInput={(e) => setF({ ...f, name: e.currentTarget.value })} placeholder="laptop key" />
        </label>
        <label>
          Private key (OpenSSH or PEM)
          <textarea class="code" rows={8} value={f.privateKey} onInput={(e) => setF({ ...f, privateKey: e.currentTarget.value })} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" spellcheck={false} />
        </label>
        <label>
          Passphrase (if encrypted)
          <input type="password" value={f.passphrase} onInput={(e) => setF({ ...f, passphrase: e.currentTarget.value })} autoComplete="off" />
        </label>
        <div class="small faint">The key is encrypted at rest with the server's master key and can never be downloaded again.</div>
      </div>
    </Modal>
  );
}

function InstallKey({ k, onClose }: { k: SshKey; onClose: () => void }) {
  const [hostId, setHostId] = useState(hosts.value[0]?.id ?? '');
  const [switchHost, setSwitchHost] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const run = async () => {
    setBusy(true);
    try {
      const r = await api.post<{ result: string; switched: boolean }>(`/api/keys/${k.id}/install`, { hostId, switchHost });
      setMsg({ ok: true, text: `${r.result === 'installed' ? 'Key installed' : 'Key was already installed'}${r.switched ? ' — host switched to key authentication.' : '.'}` });
      await loadHosts();
    } catch (err) {
      setMsg({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Install "${k.name}" on a host`}
      onClose={onClose}
      footer={
        <>
          <button onClick={onClose}>Close</button>
          <button class="primary" onClick={run} disabled={!hostId || busy}>
            {busy ? 'Installing…' : 'Install'}
          </button>
        </>
      }
    >
      <div class="col">
        <p class="small dim">Like <code>ssh-copy-id</code>: appends the public key to <code>~/.ssh/authorized_keys</code> using the host's current login (password or another key).</p>
        <label>
          Host
          <select value={hostId} onChange={(e) => setHostId(e.currentTarget.value)}>
            {hosts.value.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name} ({h.username}@{h.hostname})
              </option>
            ))}
          </select>
        </label>
        <label class="check">
          <input type="checkbox" checked={switchHost} onChange={(e) => setSwitchHost(e.currentTarget.checked)} /> Switch the host to this key afterwards (removes the saved password)
        </label>
        {msg && <div class={`alert ${msg.ok ? 'success' : 'error'}`}>{msg.text}</div>}
        {msg?.ok && <div class="small dim">Once key login works everywhere, consider disabling SSH password logins on the host (Help → "ssh key login").</div>}
      </div>
    </Modal>
  );
}

export function KeysPage() {
  const [importing, setImporting] = useState(false);
  const [installing, setInstalling] = useState<SshKey | null>(null);
  const generate = async () => {
    const r = await promptDialog({ title: 'Generate SSH key', message: 'Ed25519 is recommended (small, fast, secure). RSA 4096 for very old servers.', fields: [{ name: 'name', label: 'Name', value: 'webssh', required: true }, { name: 'type', label: 'Type (ed25519 / ecdsa / rsa)', value: 'ed25519' }], confirmText: 'Generate' });
    if (!r) return;
    try {
      await api.post('/api/keys/generate', { name: r.name, type: (['ed25519', 'ecdsa', 'rsa'].includes(r.type) ? r.type : 'ed25519') });
      await loadKeys();
      toast('Key generated', 'success');
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };
  const remove = async (k: SshKey) => {
    const users = hosts.value.filter((h) => h.keyId === k.id).map((h) => h.name);
    if (!(await confirmDialog({ title: `Delete key "${k.name}"?`, message: users.length ? `Used by: ${users.join(', ')}. Those hosts will ask for a password instead.` : undefined, danger: true, confirmText: 'Delete' }))) return;
    await api.del(`/api/keys/${k.id}`);
    await Promise.all([loadKeys(), loadHosts()]);
  };
  const rename = async (k: SshKey) => {
    const r = await promptDialog({ title: 'Rename key', fields: [{ name: 'name', label: 'Name', value: k.name, required: true }] });
    if (r) {
      await api.patch(`/api/keys/${k.id}`, { name: r.name });
      await loadKeys();
    }
  };
  return (
    <div class="page">
      <div class="page-header">
        <h1>
          <KeyRound size={22} /> SSH keys
        </h1>
        <button onClick={() => setImporting(true)}>
          <Upload size={16} /> Import
        </button>
        <button class="primary" onClick={generate}>
          <Plus size={16} /> Generate
        </button>
      </div>
      {!keys.value.length ? (
        <Empty icon={<KeyRound size={40} />} title="No keys yet">
          Generate a key here (the private half never leaves the server, encrypted), then "Install on host" to replace password logins.
        </Empty>
      ) : (
        <div class="col">
          {keys.value.map((k) => (
            <div class="card col" key={k.id}>
              <div class="row between wrap">
                <b style={{ cursor: 'pointer' }} onClick={() => rename(k)} title="Rename">
                  {k.name}
                </b>
                <div class="row">
                  <span class="badge">{k.type}</span>
                  <span class="small faint">{formatDate(k.createdAt)}</span>
                </div>
              </div>
              <div class="small mono dim" style={{ wordBreak: 'break-all' }}>
                {k.fingerprint}
              </div>
              <div class="row" style={{ alignItems: 'flex-start' }}>
                <pre class="mono small grow" style={{ background: 'var(--bg)', padding: 8, borderRadius: 6, wordBreak: 'break-all', whiteSpace: 'pre-wrap' }}>
                  {k.publicKey}
                </pre>
                <CopyButton text={k.publicKey} />
              </div>
              <div class="row wrap">
                <button class="sm primary" onClick={() => setInstalling(k)}>
                  <Download size={14} /> Install on host
                </button>
                <span class="small faint grow">Used by {hosts.value.filter((h) => h.keyId === k.id).length} host(s)</span>
                <button class="sm danger" onClick={() => remove(k)}>
                  <Trash2 size={14} /> Delete
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
      {importing && <ImportKey onClose={() => setImporting(false)} />}
      {installing && <InstallKey k={installing} onClose={() => setInstalling(null)} />}
    </div>
  );
}
