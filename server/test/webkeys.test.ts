import { describe, expect, it } from 'vitest';
import { applyModifiers, modifierParam } from '../../web/src/terminal/keys';

const none = { ctrl: false, alt: false, shift: false };
const ctrl = { ...none, ctrl: true };
const alt = { ...none, alt: true };
const shift = { ...none, shift: true };
const ESC = '\x1b';

describe('key bar sticky modifiers', () => {
  it('leaves input alone when nothing is armed', () => {
    expect(applyModifiers('c', none)).toEqual({ data: 'c', used: false });
    expect(applyModifiers(`${ESC}[A`, none)).toEqual({ data: `${ESC}[A`, used: false });
  });

  it('Ctrl turns letters and @[\\]^_ into control codes', () => {
    expect(applyModifiers('c', ctrl)).toEqual({ data: '\x03', used: true });
    expect(applyModifiers('C', ctrl)).toEqual({ data: '\x03', used: true });
    expect(applyModifiers('[', ctrl)).toEqual({ data: '\x1b', used: true });
    expect(applyModifiers('\\', ctrl)).toEqual({ data: '\x1c', used: true });
    expect(applyModifiers(' ', ctrl)).toEqual({ data: '\x00', used: true });
    expect(applyModifiers('?', ctrl)).toEqual({ data: '\x7f', used: true });
    // not a control-able key: sent as is, but the modifier is still consumed
    expect(applyModifiers('1', ctrl)).toEqual({ data: '1', used: true });
    expect(applyModifiers('ß', ctrl)).toEqual({ data: 'ß', used: true });
  });

  it('Alt prefixes ESC; Ctrl+Alt combines', () => {
    expect(applyModifiers('b', alt)).toEqual({ data: `${ESC}b`, used: true });
    expect(applyModifiers('b', { ...none, ctrl: true, alt: true })).toEqual({ data: `${ESC}\x02`, used: true });
  });

  it('Shift upper-cases letters and back-tabs', () => {
    expect(applyModifiers('q', shift)).toEqual({ data: 'Q', used: true });
    expect(applyModifiers('\t', shift)).toEqual({ data: `${ESC}[Z`, used: true });
    expect(applyModifiers('\t', ctrl)).toEqual({ data: '\t', used: true });
  });

  it('applies to the bar\'s own cursor / navigation / function keys with xterm modifier codes', () => {
    expect(modifierParam(ctrl)).toBe(5);
    expect(modifierParam(alt)).toBe(3);
    expect(modifierParam(shift)).toBe(2);
    expect(modifierParam({ ctrl: true, alt: true, shift: true })).toBe(8);
    expect(applyModifiers(`${ESC}[D`, ctrl)).toEqual({ data: `${ESC}[1;5D`, used: true });
    expect(applyModifiers(`${ESC}OA`, alt)).toEqual({ data: `${ESC}[1;3A`, used: true }); // application cursor mode
    expect(applyModifiers(`${ESC}[H`, shift)).toEqual({ data: `${ESC}[1;2H`, used: true });
    expect(applyModifiers(`${ESC}OP`, ctrl)).toEqual({ data: `${ESC}[1;5P`, used: true }); // F1
    expect(applyModifiers(`${ESC}[3~`, ctrl)).toEqual({ data: `${ESC}[3;5~`, used: true }); // Del
    expect(applyModifiers(`${ESC}[24~`, shift)).toEqual({ data: `${ESC}[24;2~`, used: true }); // F12
  });

  it('keeps modifiers armed for pastes, IME words and unknown sequences', () => {
    expect(applyModifiers('hello world', ctrl)).toEqual({ data: 'hello world', used: false });
    expect(applyModifiers(`${ESC}[200~x${ESC}[201~`, ctrl)).toEqual({ data: `${ESC}[200~x${ESC}[201~`, used: false });
    expect(applyModifiers(`${ESC}[1;5A`, alt)).toEqual({ data: `${ESC}[1;5A`, used: false }); // already modified
  });
});
