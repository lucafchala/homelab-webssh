# WebSSH user guide

## Layout

- **Desktop**: the host list is in the left sidebar, with pages below it (Hosts, Terminals, Files, Dashboard, Snippets, SSH keys, Recordings, Settings, Admin). The top bar has the **command palette** (⌘), **Help** (?) and the **AI assistant** (🤖), which open as a side panel.
- **Phone**: ☰ opens the host list and menu; the bottom bar switches between Hosts / Terminal / Files / Help / AI. In a terminal, the bottom bar is replaced by the **key bar**.

### Keyboard shortcuts

| Keys | Action |
|---|---|
| `Ctrl/⌘ + Shift + K` (or `P`) | Command palette: connect to a host, open files, insert a snippet, search help |
| `Ctrl/⌘ + Shift + H` | Look up the selected terminal text in Help |
| `Ctrl/⌘ + Shift + A` | Toggle the AI panel |
| `Ctrl/⌘ + Shift + F` | Search the terminal scrollback |
| `Ctrl + Shift + C` / `Ctrl + Shift + V` | Copy / paste in the terminal (`Ctrl+C` stays "interrupt") |
| Right-click in a terminal | Copy the selection, or paste if nothing is selected (toggle in Settings) |
| Middle-click a tab | Close it |

## Terminals

- Click a host in the sidebar (or **Connect** on its card) to open a terminal tab. Open as many as you like, even several to the same host.
- **Right-click a tab** for more:
  - **Detach (keep running)**: closes the tab but the shell keeps running on the server
  - **Reconnect / new shell**
  - **Add to broadcast group**
  - **Duplicate**
- **Grid view** (▦ in the top bar) shows all open terminals side by side.
- **Broadcast** (📡) sends what you type to every terminal in the broadcast group. It's handy for running the same thing on several servers. Tabs in the group show a 📡 icon.
- **Font size**: use − / + in the top bar, or Settings.

### Sessions that survive everything

When your browser disconnects (laptop sleeps, Wi-Fi drops, phone locks), **the shell keeps running on the server** for `TERMINAL_GRACE_MINUTES` (default 30):
- Same browser: the tab shows *Reconnecting…* and re-attaches by itself, with the screen restored, including full-screen apps like `htop` or `vim`.
- Another device: click **🖥⬆ (Running sessions)** in the top bar and **Attach**. You can start on the PC and continue on your phone.
- Reloading the page re-attaches your open tabs automatically.

For things that must survive even a server restart or more than 30 minutes away, use `tmux` and set the host's **startup command** to `tmux new -As main`.

### On a phone

- Tap the terminal to bring up the keyboard. The **key bar** above it has `Esc`, `Tab`, **Ctrl**, **Alt**, arrows, `^C` `^D` `^Z` `^L` `^R`, and symbols like `| ~ / -`. Swipe it or use `‹ ›` for more pages (Home/End/PgUp/PgDn/Del, brackets and symbols, F1–F12, `^A ^B ^E ^W ^U`).
- **Ctrl and Alt are sticky**: tap **Ctrl**, then type `c` to send Ctrl-C.
- 📋 pastes, 🔍 searches scrollback, `{ }` inserts a snippet, ? opens help, ⌨ hides or shows the keyboard, and A−/A+ change the font size.
- Install it as an app (see INSTALL.md §7) for a full-screen experience.

## Hosts

- **Add host**: hostname/IP, port, user, and authentication:
  - **SSH key** (recommended): choose a key from *SSH keys*
  - **Saved password**: stored encrypted (AES-256-GCM)
  - **Ask every time**: nothing is stored; you're prompted when connecting
- **Jump host**: reach machines through a bastion. Chains are supported.
- **Group, tags, colour, favourite** keep big homelabs tidy. The sidebar search matches all of them.
- **Startup command** runs right after login (e.g. `tmux new -As main`, `cd /srv && ls`).
- **Wake-on-LAN MAC**: adds a ⚡ *Wake* button. This needs the host-network option (INSTALL.md §9).
- **Use passwordless sudo**: lets the Dashboard's service, power and package buttons and the file editor's *Open with sudo* run `sudo -n`.
- **Record terminal sessions**: when the admin sets recording to *per host*.
- **Test connection** (in the edit dialog) shows latency and `uname`, and lets you pin the host key.
- **Host keys** are pinned the first time you connect. If a key ever changes, WebSSH refuses to connect and logs it, which protects you from man-in-the-middle attacks. Only reset a pinned key if you know why it changed (for example, a reinstall).
- **Import ~/.ssh/config** creates hosts (including `ProxyJump`) in one go.

## SSH keys

- **Generate** creates Ed25519 (recommended), ECDSA or RSA-4096 keys on the server. The private key is encrypted and never leaves the server again; you can only copy the public key.
- **Import** an existing private key (passphrase supported).
- **Install on host** works like `ssh-copy-id`: it appends the public key to `~/.ssh/authorized_keys` (idempotently) and can switch the host to key login.

## Files

- Pick a host, then browse with the breadcrumb or ⬆. Double-click (or tap) a folder to open it, or a file to edit it.
- **Upload**: the button, or **drag and drop files anywhere on the page**. There's a progress bar, and you're asked before overwriting.
- **Download** files, or whole folders as `.tar.gz`.
- **Edit**: a syntax-highlighted editor (YAML, JSON, shell, nginx, TOML, Dockerfile, Python, JS, INI/systemd units…). `Ctrl/⌘+S` saves.
  - Saves are atomic: it writes a temp file and renames it, keeping the file's permissions.
  - If the file changed on the server since you opened it, you're warned before overwriting.
  - **Open with sudo** (hosts with sudo enabled) edits root-owned files such as `/etc/...`.
- Click the permissions column to `chmod`. You can also rename or move, delete (folders need a typed confirmation), create files and folders, show or hide dotfiles, and use **cd here** to `cd` into the folder in your terminal.

## Dashboard

- **Overview**: CPU, memory, load, uptime, disks, network throughput, temperatures, top processes. It refreshes every 6 s while *live* is ticked, and flags *reboot required*.
- **Containers**: grouped by compose project with live CPU/memory. Restart, stop, start, view logs, or open a shell inside a container. *Update a compose stack…* types the update command into a terminal for you.
- **Services**: running / failed / all systemd units. Start, stop, restart, enable, and view `journalctl` logs.
- **Updates**: pending packages (apt/dnf/pacman/apk) and *Upgrade in terminal*.
- **Reboot / Shut down** need you to type the host name to confirm.

## Snippets

- Save commands you use often. Use `{{name}}` or `{{name:default}}` for values you're asked for each time. Example: `docker compose -f {{dir:~/docker}}/docker-compose.yml logs -f --tail 50`
- **Insert** puts it in the active terminal without running it. **Run on…** runs it on several hosts at once, without a TTY, and shows each host's output and exit code.
- Admins can share snippets with all users.
- An empty Snippets page offers a starter set of useful examples.

## Help (offline first)

Type a command or a task into the Help panel:
1. **Command name** (`tar`, `docker compose`, `zpool`): a cheat-sheet card with examples (📋 copy, ⌨ insert into the terminal) and options.
2. **Task in plain English** ("disk is full", "what is using port 8080", "exit vim", "container keeps restarting"): step-by-step **recipes** and key sheets, all offline.
3. **A command not in the offline guide** (`restic`, `rclone`…): fetched automatically from **tldr-pages** (free).
4. **Read the manual on <host>** shows the real `man` page (or `--help`) from your connected server.
5. Only if none of this answers it does the panel offer **Ask the AI assistant**.

Tip: select an error in the terminal and press `Ctrl+Shift+H` to look it up.

## AI assistant

Your admin must enable it first (Admin → Settings & AI). It has three modes:
- **Ask**: questions and explanations. *Include terminal output* sends the last ~100 lines of your active terminal as context, so you can ask "why did that fail?".
- **Command**: describe what you want ("find files over 1 GB changed this week") and get a command to insert or run.
- **Agent**: give it a task ("nginx returns 502, find out why"). It proposes one command at a time on the host of your active terminal:
  - Each proposal shows what it does and a risk badge: 🟢 read-only, 🟡 changes state, 🔴 **dangerous**.
  - **Run**, **Edit** (change the command first), **In terminal** (run it yourself), or **Reject**.
  - Dangerous commands need you to type the host name to confirm.
  - Commands run in a separate non-interactive SSH channel with a timeout. Results go back to the AI so it can continue, and it stops after 12 steps until you reply.
  - If your admin allows it, you can tick **auto-run read-only** so harmless commands (`ls`, `df`, `docker ps`, `journalctl`…) run without asking.
- **Explain screen** (top of the AI panel) explains your current selection, or the whole screen.
- Code blocks in answers have 📋 copy, ⌨ insert, and ↵ run-in-terminal (with confirmation).

Everything the agent runs is recorded in the audit log.

## Recordings

If enabled, terminal output is recorded in asciicast v2 format (keystrokes are not recorded, so passwords you type aren't either). Play recordings in the browser at 0.5–8× speed, seek through them, or download the `.cast` file (playable with `asciinema play`). Recordings are deleted after `RECORDINGS_RETENTION_DAYS`.

## Settings

- Theme (dark/light/system), terminal colour schemes (WebSSH Dark, Dracula, Nord, Gruvbox, Tokyo Night, Catppuccin, Solarized, GitHub Light), font, cursor, scrollback, copy-on-select, right-click behaviour, key bar mode, and confirm-on-close
- **Bell notifications**: get a desktop notification when a background terminal rings the bell. For example, run `long-command; printf '\a'`.
- **Security**: change password, authenticator app, recovery codes, passkeys, and signed-in devices (sign out other devices)

## Admin

- **Users**: add (with a temporary password; they must change it and enrol 2FA), promote or demote, disable, reset password, reset 2FA (lost phone), unlock, delete
- **Audit log**: every sign-in (successful and failed), host and key change, terminal open/close, file operation, command run, AI request and setting change, searchable by user, IP, host or command
- **Live sessions**: see and terminate anyone's terminals
- **Settings & AI**: AI provider and model and test button, session recording mode, login banner, whether non-admins may add hosts, plus a read-only view of the environment security settings
