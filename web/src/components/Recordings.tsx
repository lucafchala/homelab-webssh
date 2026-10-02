import { useEffect, useRef, useState } from 'preact/hooks';
import { Download, Pause, Play, Trash2, Video } from 'lucide-preact';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { api } from '../api';
import { confirmDialog, isAdmin, me, prefs } from '../state';
import { formatBytes, formatDate, formatDuration } from '../util';
import { Empty, Modal, Spinner, useAsync } from './common';
import { getTheme } from '../terminal/themes';

interface Rec {
  id: string;
  username: string;
  hostName: string;
  cols: number;
  rows: number;
  size: number;
  startedAt: number;
  endedAt: number | null;
}

/** asciicast v2 player rendered with xterm.js. */
function Player({ rec, onClose }: { rec: Rec; onClose: () => void }) {
  const host = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const events = useRef<[number, string, string][]>([]);
  const [loaded, setLoaded] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [pos, setPos] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [duration, setDuration] = useState(0);
  const state = useRef({ idx: 0, t: 0, timer: 0 as unknown as ReturnType<typeof setTimeout> });

  useEffect(() => {
    const term = new Terminal({ cols: rec.cols, rows: rec.rows, fontSize: prefs.value.fontSize, fontFamily: prefs.value.fontFamily, theme: getTheme(prefs.value.termTheme), disableStdin: true, convertEol: false, scrollback: 2000 });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host.current!);
    termRef.current = term;
    fetch(`/api/recordings/${rec.id}`, { credentials: 'same-origin' })
      .then((r) => r.text())
      .then((text) => {
        const lines = text.split('\n').filter(Boolean);
        events.current = lines.slice(1).map((l) => JSON.parse(l));
        setDuration(events.current.length ? events.current[events.current.length - 1][0] : 0);
        setLoaded(true);
        setPlaying(true);
      });
    return () => {
      clearTimeout(state.current.timer);
      term.dispose();
    };
  }, [rec.id]);

  const seek = (t: number) => {
    const term = termRef.current!;
    clearTimeout(state.current.timer);
    term.reset();
    let i = 0;
    let buf = '';
    for (; i < events.current.length && events.current[i][0] <= t; i++) {
      const [, type, data] = events.current[i];
      if (type === 'o') buf += data;
      else if (type === 'r') {
        const [c, r] = data.split('x').map(Number);
        if (c && r) term.resize(c, r);
      }
    }
    term.write(buf);
    state.current.idx = i;
    state.current.t = t;
    setPos(t);
  };

  useEffect(() => {
    if (!loaded || !playing) return;
    const step = () => {
      const s = state.current;
      const ev = events.current[s.idx];
      if (!ev) {
        setPlaying(false);
        return;
      }
      const wait = Math.min(2000, Math.max(0, (ev[0] - s.t) * 1000)) / speed; // cap idle gaps at 2 s
      s.timer = setTimeout(() => {
        const [t, type, data] = ev;
        if (type === 'o') termRef.current?.write(data);
        else if (type === 'r') {
          const [c, r] = data.split('x').map(Number);
          if (c && r) termRef.current?.resize(c, r);
        }
        s.t = t;
        s.idx++;
        setPos(t);
        step();
      }, wait);
    };
    step();
    return () => clearTimeout(state.current.timer);
  }, [loaded, playing, speed]);

  return (
    <Modal
      title={`${rec.hostName} — ${formatDate(rec.startedAt)}`}
      icon={<Video size={18} />}
      onClose={onClose}
      size="full"
      footer={
        <div class="row" style={{ width: '100%' }}>
          <button class="icon" onClick={() => (pos >= duration ? (seek(0), setPlaying(true)) : setPlaying(!playing))}>
            {playing ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <input type="range" min={0} max={duration} step={0.1} value={pos} onInput={(e) => seek(Number(e.currentTarget.value))} class="grow" style={{ minHeight: 0 }} />
          <span class="small mono nowrap">
            {formatDuration(pos)} / {formatDuration(duration)}
          </span>
          <select value={speed} onChange={(e) => setSpeed(Number(e.currentTarget.value))} style={{ width: 80 }}>
            {[0.5, 1, 2, 4, 8].map((s) => (
              <option key={s} value={s}>
                {s}×
              </option>
            ))}
          </select>
        </div>
      }
    >
      {!loaded && <Spinner label="Loading recording…" />}
      <div ref={host} style={{ background: getTheme(prefs.value.termTheme).background, padding: 6, borderRadius: 6, overflow: 'auto' }} />
    </Modal>
  );
}

export function RecordingsPage() {
  const [all, setAll] = useState(false);
  const { data, loading, reload } = useAsync(() => api.get<Rec[]>(`/api/recordings${all ? '?all=1' : ''}`), [all]);
  const [playing, setPlaying] = useState<Rec | null>(null);
  const remove = async (r: Rec) => {
    if (!(await confirmDialog({ title: 'Delete recording?', danger: true, confirmText: 'Delete' }))) return;
    await api.del(`/api/recordings/${r.id}`);
    reload();
  };
  return (
    <div class="page">
      <div class="page-header">
        <h1>
          <Video size={22} /> Session recordings
        </h1>
        {isAdmin.value && (
          <label class="check small">
            <input type="checkbox" checked={all} onChange={(e) => setAll(e.currentTarget.checked)} /> All users
          </label>
        )}
      </div>
      <p class="dim small">
        Recording mode: <b>{me.value?.features.recording}</b>. {me.value?.features.recording === 'per-host' && 'Enable "Record terminal sessions" on a host to record it.'} Only terminal output is recorded (asciicast v2 — also playable with asciinema).
      </p>
      {loading && <Spinner />}
      {data && !data.length && <Empty icon={<Video size={40} />} title="No recordings yet" />}
      {data && data.length > 0 && (
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>Host</th>
                {all && <th>User</th>}
                <th>Started</th>
                <th class="hide-sm">Duration</th>
                <th class="hide-sm">Size</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.map((r) => (
                <tr key={r.id}>
                  <td>
                    <b>{r.hostName}</b>
                  </td>
                  {all && <td>{r.username}</td>}
                  <td class="small">{formatDate(r.startedAt)}</td>
                  <td class="small hide-sm">{r.endedAt ? formatDuration((r.endedAt - r.startedAt) / 1000) : <span class="badge red">live</span>}</td>
                  <td class="small hide-sm">{formatBytes(r.size)}</td>
                  <td class="nowrap" style={{ textAlign: 'right' }}>
                    <button class="sm primary" onClick={() => setPlaying(r)}>
                      <Play size={14} /> Play
                    </button>
                    <a class="btn sm ghost icon" href={`/api/recordings/${r.id}`} download title="Download .cast">
                      <Download size={14} />
                    </a>
                    {r.endedAt && (
                      <button class="sm ghost icon" onClick={() => remove(r)}>
                        <Trash2 size={14} />
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {playing && <Player rec={playing} onClose={() => setPlaying(null)} />}
    </div>
  );
}
