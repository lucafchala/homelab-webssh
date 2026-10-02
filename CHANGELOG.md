# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [1.0.0] — 2026-10-02

First public release.

### Added
- Browser SSH terminals (xterm.js): tabs, grid view, broadcast input, scrollback search, sessions that survive disconnects and re-attach from any device, mobile key bar, PWA.
- Host manager: SSH keys / saved passwords / ask, jump hosts, host-key pinning (TOFU), groups/tags/colours, startup commands, Wake-on-LAN, `~/.ssh/config` import, `ssh-copy-id`-style key install.
- SFTP file manager with drag-and-drop upload, folder download as `.tar.gz`, and a CodeMirror editor (atomic saves, conflict detection, optional sudo).
- Host dashboard: system stats, Docker containers, systemd services, pending package updates, reboot/shutdown.
- Snippets with variables; run on many hosts at once.
- Local-first command help: 137 commands, 44 task recipes, 8 key sheets, tldr-pages and remote `man`.
- Optional AI assistant (Ollama, Claude, OpenAI-compatible) with an approval-gated agent and command risk classifier.
- Security: mandatory 2FA (TOTP, passkeys), recovery codes, lockouts, CSRF/origin checks, strict CSP, AES-256-GCM encrypted secrets, Cloudflare Access JWT validation, IP and SSH-target allowlists, audit log, session recordings.
- Deployment: hardened Docker image, Compose stack with Cloudflare Tunnel, Cloudflare setup script, backups, CI.
