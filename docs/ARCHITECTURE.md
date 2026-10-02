# Architecture

```
┌────────────── Browser (Preact SPA, xterm.js) ───────────────┐
│ REST (JSON, CSRF header)   WebSocket /api/terminal/ws   SSE /api/ai/chat │
└──────────────┬──────────────────────┬───────────────────────┬────────────┘
               │ HTTPS via Cloudflare Access + Tunnel (cloudflared)       │
┌──────────────▼──────────────────────▼───────────────────────▼────────────┐
│ Fastify 5 (server/src/app.ts)                                            │
│  onRequest: IP allowlist → CF Access JWT → Origin check                  │
│  guards (auth/guards.ts): session cookie → CSRF → 2FA/password policy    │
│  routes/*  ──►  db/models.ts (node:sqlite)   security/crypto.ts (Vault)  │
│                 ssh/manager.ts  (pooled ssh2 connections, host keys,     │
│                                  jump hosts, interactive auth)           │
│                 ssh/terminals.ts (shell sessions + @xterm/headless state,│
│                                  re-attach, backpressure, recordings)    │
│                 ai/* (Anthropic SDK / OpenAI-compatible, risk classifier)│
│                 help/* (offline cheat sheet, recipes, tldr, remote man)  │
└──────────────────────────────┬───────────────────────────────────────────┘
                               │ SSH (ssh2, pure JS)
                     your servers / VMs / containers
```

## Server (`server/src`)

| Path | Responsibility |
|---|---|
| `index.ts` | Entry point: config, first-run setup token banner, maintenance timer (session/recording/audit pruning), graceful shutdown |
| `app.ts` | Builds the Fastify app and `AppContext`; registers plugins (cookie, helmet/CSP, rate-limit, multipart, websocket, static), the perimeter `onRequest` hook, error handler, all routes, SPA fallback |
| `config.ts` | Env parsing with zod (empty values = unset) → typed `Config` |
| `context.ts` | `AppContext` — the dependency bag passed to every route module |
| `db/index.ts`, `db/migrations.ts`, `db/models.ts` | `node:sqlite` wrapper with statement cache + transactions; **append-only** migrations (`PRAGMA user_version`); typed repositories and `public*()` serializers that strip secrets |
| `security/crypto.ts` | `Vault` (AES-256-GCM, HKDF-derived key, AAD per record), master key loading, tokens, hashing |
| `security/password.ts` | scrypt hashing, password policy, timing-equalising dummy check |
| `security/totp.ts` | RFC 4226/6238 HOTP/TOTP, base32, recovery codes |
| `security/cidr.ts`, `throttle.ts`, `cfaccess.ts` | CIDR lists, failure throttling + TTL maps, Cloudflare Access JWT verification (jose) |
| `auth/sessions.ts` | Server-side sessions: hashed tokens, `mfa`→`full` promotion with rotation, idle/absolute expiry |
| `auth/guards.ts` | `account`, `user`, `admin`, `mfa` preHandlers; cookie helpers |
| `audit.ts` | Audit log (SQLite + structured log line for fail2ban) |
| `appSettings.ts` | Admin-editable settings (recording, banner, AI provider) stored in DB, seeded from env |
| `recorder.ts` | asciicast v2 recordings |
| `ssh/manager.ts` | Connection pool keyed by `user:host`, leases + idle close, jump hosts via `forwardOut`, host-key TOFU/pinning, auth sequencing (key → password → keyboard-interactive → prompt), target allowlist, `exec()` helper with timeout/caps, `shq()` shell quoting |
| `ssh/terminals.ts` | `TerminalSession`: shell channel ↔ WebSocket clients, headless xterm for screen snapshots on re-attach, grace period, backpressure, recording |
| `ssh/stats.ts`, `ssh/keys.ts` | Stats script + parsers (stats, docker ps, systemd); key generation/inspection/fingerprints |
| `routes/*.ts` | HTTP/WS endpoints, one module per area (auth, admin, hosts, keys, terminal, sftp, monitor, snippets+recordings, help, ai) |
| `ai/` | `types.ts` (provider-neutral messages), `anthropic.ts` (SDK streaming, adaptive thinking, server-side fallbacks on the official endpoint, raw block echo), `openai.ts` (SSE client for Ollama/OpenAI-compatible), `providers.ts` (dispatch + `run_command` tool), `prompts.ts`, `safety.ts` (risk classifier) |
| `help/` | `commands.ts` (137 entries), `recipes.ts` (44), `keys.ts` (8 sheets), `search.ts` (local-first resolver), `tldr.ts` |
| `cli.ts` | Break-glass admin CLI |

### Request pipeline

1. `onRequest` (app.ts): skip `/healthz`; enforce `IP_ALLOWLIST`; verify Cloudflare Access JWT if configured; reject cross-origin state-changing requests and WebSocket upgrades (`Origin` ≠ `PUBLIC_URL`).
2. Route `preHandler` guard: resolves the session from the cookie, checks CSRF for non-GET, and (for `guards.user`) blocks until password change / 2FA enrolment are done (`403` with `code` `PASSWORD_CHANGE_REQUIRED` / `MFA_SETUP_REQUIRED`).
3. Handler validates input with zod (`util/http.ts → parse()`), performs the action, writes an audit entry for anything security-relevant.
4. `HttpError` → `{error, code}` JSON; unknown errors → 500 without details.

### Terminal WebSocket protocol (`/api/terminal/ws`)

Client → server: JSON text frames, or **binary** frames for keystrokes.

```jsonc
{ "type": "open", "hostId": "…", "cols": 120, "rows": 32 }     // new session
{ "type": "attach", "sessionId": "…", "cols": 120, "rows": 32 } // re-attach (same user only)
{ "type": "resize", "cols": 100, "rows": 30 }
{ "type": "answer", "requestId": "…", "accept": true }            // host key
{ "type": "answer", "requestId": "…", "responses": ["pw"] }       // auth prompt (null = cancel)
{ "type": "close" }                                               // kill the shell
{ "type": "ping" }
```

Server → client: **binary** frames = raw terminal output; JSON events:
`created {sessionId}` · `status {message}` · `hostkey {fingerprint,keyType,requestId}` · `prompt {title,instructions,prompts[],requestId}` · `ready {recording}` · `attached {status,title}` (followed by a binary screen snapshot) · `title` · `error {code,message}` · `closed {reason,exitCode}` · `pong`. Close code `4001` = login session ended.

### AI flow

The browser owns the conversation and the agent loop (stateless server):
1. `POST /api/ai/chat` `{mode, hostId, messages, terminalContext?}` → SSE events `text`, `thinking`, `done {message, toolCalls[{…, valid, risk}]}`, `error`.
2. For each proposed `run_command`, the UI asks the user; on approval it calls `POST /api/hosts/:id/exec {source:'ai', confirmDangerous?}` (server re-classifies; `428` for dangerous without confirmation).
3. The result is appended as a `tool` message and step 1 repeats (max 12 steps per user turn).

Anthropic assistant turns are echoed back **unchanged** (`raw.content`, including thinking blocks and signatures) — required for adaptive-thinking models. Terminal context is appended to the last user turn (keeps the system prompt cache-stable) inside `<terminal>` tags, stripped of escape sequences, and declared untrusted in the system prompt.

### Data model (SQLite, `DATA_DIR/webssh.db`)

`users` · `webauthn_credentials` · `sessions` (id = sha256(token)) · `ssh_keys` (private key encrypted, AAD `key:<id>`) · `hosts` (password encrypted, AAD `host:<id>`; pinned host key) · `snippets` · `recordings` (files in `DATA_DIR/recordings/*.cast`) · `audit_log` · `settings` (JSON blobs, AI key encrypted with AAD `ai-key`). TOTP secrets: AAD `totp:<userId>`.

## Web (`web/src`)

| Path | Responsibility |
|---|---|
| `main.tsx` | Boot (auth state → setup/login/enrol/app), visual-viewport height sync for mobile keyboards, session restore, SW registration |
| `api.ts` | fetch wrapper (CSRF header, error → `ApiError`, Cloudflare Access expiry detection), upload with progress, SSE reader |
| `state.ts` | Preact signals: user/prefs/theme, hosts/keys/snippets, navigation, toasts, promise-based dialogs |
| `terminal/engine.ts` | `TerminalController` per tab (xterm + addons + WebSocket protocol + reconnect/re-attach + sticky modifiers + broadcast), tab operations |
| `terminal/themes.ts` | Terminal colour schemes |
| `components/*` | `Shell` (layout, shortcuts), `Auth`, `Hosts`, `Terminal` (tabs/grid/key bar/prompts), `Files` + lazy `editor.ts` (CodeMirror), `Dashboard`, `Snippets`, `Keys`, `Recordings` (player), `Help`, `Ai`, `Settings`, `Admin`, `Palette`, `common` (Modal, dialogs, Markdown, helpers) |
| `public/` | PWA manifest, icons (generated by `scripts/gen-icons.mjs`), service worker (shell cache only; never caches `/api`) |

## Tests

| Suite | What |
|---|---|
| `server/test/security.test.ts` | Vault, scrypt, RFC TOTP vectors, CIDR, throttles, sessions, config |
| `server/test/logic.test.ts` | Risk classifier (cases), stats/docker/systemd parsers, ssh-config import, WOL, keys, help resolver + dataset integrity, tldr, AI message conversion |
| `server/test/integration.test.ts` | Spins up a real `sshd` + the app: setup, 2FA, CSRF/origin, TOTP login, keys, host-key TOFU + mismatch, stats, exec gating, terminal over WebSocket incl. detach/re-attach, recordings, SFTP (upload/edit/conflict/download/tar/delete), key install, audit trail, secret hygiene, lockout |
| `server/test/ai.test.ts` | Mock Anthropic + OpenAI-compatible servers: streaming, thinking, tool calls + risk, raw block round-trip, request shape |
| `e2e/webssh.spec.ts` | Playwright: setup + TOTP enrolment, add host, host-key + password prompts, typing in the terminal, reload re-attach, help, files, mobile layout |
