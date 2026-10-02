/** Keyboard cheat sheets for the interactive tools you meet in a terminal. */
export interface KeySheet {
  id: string;
  title: string;
  keywords: string[];
  sections: { title: string; keys: [string, string][] }[];
}

export const KEY_SHEETS: KeySheet[] = [
  {
    id: 'bash',
    title: 'Shell line editing (bash / zsh)',
    keywords: ['bash', 'zsh', 'shell', 'readline', 'shortcuts', 'keyboard', 'cursor', 'line'],
    sections: [
      { title: 'Move', keys: [['Ctrl-a / Ctrl-e', 'start / end of line'], ['Alt-b / Alt-f', 'back / forward one word'], ['Ctrl-xx', 'toggle between start and cursor']] },
      { title: 'Edit', keys: [['Ctrl-u', 'cut to start of line'], ['Ctrl-k', 'cut to end of line'], ['Ctrl-w', 'cut previous word'], ['Ctrl-y', 'paste what you cut'], ['Ctrl-_', 'undo']] },
      { title: 'History', keys: [['Ctrl-r', 'reverse search history (again to go further back)'], ['!!', 'previous command'], ['!$', 'last argument of the previous command'], ['Alt-.', 'insert last argument']] },
      { title: 'Control', keys: [['Ctrl-c', 'cancel / interrupt'], ['Ctrl-d', 'end of input / log out'], ['Ctrl-z', 'suspend (fg to resume, bg to background)'], ['Ctrl-l', 'clear screen']] },
    ],
  },
  {
    id: 'tmux',
    title: 'tmux (prefix = Ctrl-b)',
    keywords: ['tmux', 'multiplexer', 'session', 'window', 'pane', 'split', 'detach'],
    sections: [
      { title: 'Sessions', keys: [['tmux new -As main', 'attach to or create "main"'], ['prefix d', 'detach'], ['prefix s', 'choose session'], ['prefix $', 'rename session']] },
      { title: 'Windows', keys: [['prefix c', 'new window'], ['prefix n / p', 'next / previous'], ['prefix 0-9', 'jump to window'], ['prefix ,', 'rename'], ['prefix &', 'kill window']] },
      { title: 'Panes', keys: [['prefix %', 'split left/right'], ['prefix "', 'split top/bottom'], ['prefix arrow', 'move between panes'], ['prefix z', 'zoom pane'], ['prefix x', 'kill pane']] },
      { title: 'Scroll / copy', keys: [['prefix [', 'scroll mode (arrows/PgUp, q to quit)'], ['set -g mouse on', '(in ~/.tmux.conf) mouse scrolling & selection']] },
    ],
  },
  {
    id: 'screen',
    title: 'GNU screen (prefix = Ctrl-a)',
    keywords: ['screen', 'multiplexer', 'detach'],
    sections: [{ title: 'Basics', keys: [['screen -S name', 'new named session'], ['prefix d', 'detach'], ['screen -r name', 'reattach'], ['prefix c', 'new window'], ['prefix n / p', 'next / previous'], ['prefix [', 'scroll mode (Esc to leave)'], ['prefix k', 'kill window']] }],
  },
  {
    id: 'vim',
    title: 'vim / vi — survival guide',
    keywords: ['vim', 'vi', 'editor', 'exit', 'quit', 'save', 'insert'],
    sections: [
      { title: 'Get out!', keys: [['Esc then :q!', 'quit without saving'], ['Esc then :wq', 'save and quit'], ['Esc then :w', 'save'], ['Esc then ZZ', 'save and quit']] },
      { title: 'Modes', keys: [['i / a', 'insert before / after cursor'], ['o', 'new line below and insert'], ['Esc', 'back to normal mode'], ['v / V', 'select chars / lines']] },
      { title: 'Edit', keys: [['dd', 'delete line'], ['yy', 'copy line'], ['p', 'paste'], ['u / Ctrl-r', 'undo / redo'], ['x', 'delete character']] },
      { title: 'Navigate & search', keys: [['gg / G', 'top / bottom'], [':42', 'go to line 42'], ['/text', 'search (n = next)'], [':%s/old/new/g', 'replace everywhere']] },
    ],
  },
  {
    id: 'nano',
    title: 'nano editor',
    keywords: ['nano', 'editor', 'save', 'exit'],
    sections: [{ title: 'Basics (^ = Ctrl, M- = Alt)', keys: [['^O then Enter', 'save'], ['^X', 'exit'], ['^W', 'search'], ['^\\', 'replace'], ['^K / ^U', 'cut / paste line'], ['^_', 'go to line'], ['M-u', 'undo'], ['M-#', 'toggle line numbers']] }],
  },
  {
    id: 'less',
    title: 'less (also man pages, journalctl, git log)',
    keywords: ['less', 'pager', 'man', 'scroll', 'quit', 'search'],
    sections: [{ title: 'Keys', keys: [['q', 'quit'], ['Space / b', 'page down / up'], ['g / G', 'top / bottom'], ['/text', 'search forward (n / N next / prev)'], ['F', 'follow mode like tail -f (Ctrl-c to stop)'], ['-S', 'toggle line wrapping']] }],
  },
  {
    id: 'htop',
    title: 'htop',
    keywords: ['htop', 'top', 'process', 'monitor', 'kill'],
    sections: [{ title: 'Keys', keys: [['F3 or /', 'search'], ['F4 or \\', 'filter'], ['F5 or t', 'tree view'], ['F6 or < >', 'choose sort column'], ['F9 or k', 'kill selected process'], ['u', 'filter by user'], ['q', 'quit']] }],
  },
  {
    id: 'webssh',
    title: 'WebSSH shortcuts',
    keywords: ['webssh', 'shortcut', 'keyboard', 'palette', 'copy', 'paste', 'mobile'],
    sections: [
      { title: 'Global', keys: [['Ctrl-Shift-K or Ctrl-Shift-P', 'command palette'], ['Ctrl-Shift-F', 'search the terminal scrollback'], ['Ctrl-Shift-C / Ctrl-Shift-V', 'copy / paste'], ['Ctrl-Shift-H', 'help panel'], ['Ctrl-Shift-A', 'AI assistant'], ['Ctrl-+ / Ctrl--', 'font size']] },
      { title: 'Mobile', keys: [['Key bar', 'Esc, Tab, Ctrl, Alt, arrows, symbols above the keyboard'], ['Ctrl (sticky)', 'tap Ctrl, then a letter → Ctrl-letter'], ['Pinch', 'zoom the terminal font'], ['Long-press', 'select text to copy']] },
    ],
  },
];
