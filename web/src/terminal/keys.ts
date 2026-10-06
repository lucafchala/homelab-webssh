// Sticky on-screen modifiers (Ctrl / Alt / Shift from the mobile key bar) → terminal byte sequences.
// Pure functions, no DOM: covered by server/test/webkeys.test.ts.

export interface Modifiers {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

const ESC = '\x1b';

/** xterm's modifier parameter (CSI 1;5 A = Ctrl+Up): 1 + Shift(1) + Alt(2) + Ctrl(4). */
export function modifierParam(m: Modifiers): number {
  return 1 + (m.shift ? 1 : 0) + (m.alt ? 2 : 0) + (m.ctrl ? 4 : 0);
}

function ctrlChar(ch: string): string {
  const code = ch.charCodeAt(0);
  if (code >= 97 && code <= 122) return String.fromCharCode(code - 96); // a-z
  if (code >= 64 && code <= 95) return String.fromCharCode(code - 64); // @ A-Z [ \ ] ^ _
  if (ch === ' ') return '\x00';
  if (ch === '?') return '\x7f';
  return ch;
}

/**
 * Apply the armed modifiers to one chunk of terminal input.
 * `used` tells the caller whether the chunk was a key the modifiers belong to (then they are released);
 * pastes, IME words and unknown sequences are passed through untouched and keep the modifiers armed.
 */
export function applyModifiers(data: string, m: Modifiers): { data: string; used: boolean } {
  if (!m.ctrl && !m.alt && !m.shift) return { data, used: false };
  const p = modifierParam(m);

  // Cursor / Home / End / F1-F4:  ESC [ A, ESC O A  →  ESC [ 1;p A
  const cursor = /^\x1b[[O]([A-DFHPQRS])$/.exec(data);
  if (cursor) return { data: `${ESC}[1;${p}${cursor[1]}`, used: true };
  // Ins / Del / PgUp / PgDn / F5-F12:  ESC [ n ~  →  ESC [ n;p ~
  const tilde = /^\x1b\[(\d+)~$/.exec(data);
  if (tilde) return { data: `${ESC}[${tilde[1]};${p}~`, used: true };

  if (data === '\t' && m.shift) return { data: `${ESC}[Z`, used: true }; // back-tab

  if (data.length !== 1) return { data, used: false };
  let out = data;
  if (m.shift && out >= 'a' && out <= 'z') out = out.toUpperCase();
  if (m.ctrl) out = ctrlChar(out);
  if (m.alt) out = ESC + out;
  return { data: out, used: true };
}
