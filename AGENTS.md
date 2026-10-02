# Instructions for agents (and humans) working on this repo

WebSSH is a self-hosted web SSH console for a homelab: Fastify + ssh2 backend, Preact + xterm.js frontend, SQLite storage, deployed with Docker behind Cloudflare Tunnel/Access. **It controls real servers, so security regressions are the worst possible bug.** Read this whole file before changing code.

- Architecture & protocols: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- Security model: [SECURITY.md](SECURITY.md)
- User-facing docs to keep in sync: [README.md](README.md), [docs/INSTALL.md](docs/INSTALL.md), [docs/USER_GUIDE.md](docs/USER_GUIDE.md), [docs/CLOUDFLARE.md](docs/CLOUDFLARE.md), [.env.example](.env.example)

## Commands

```bash
npm install                    # Node 22.13+ (uses built-in node:sqlite; no native addons)
npm run dev                    # API :8080 (tsx watch) + Vite :5173 — run with PUBLIC_URL=http://localhost:5173
npm run typecheck              # server + web (tsc --noEmit) — must pass
npm test                       # vitest: unit + integration (+ mocked AI). Integration tests start a real sshd
                               #   (apt install openssh-server); run as root so sshd can allocate PTYs
npm run build                  # web (vite) + server (tsc) → web/dist, server/dist
npm run test:e2e               # Playwright (needs `npm run build` first, sshd, and a local user `e2euser`
                               #   with password `Pa55word-e2e!`; see e2e/webssh.spec.ts)
npm run icons                  # regenerate PWA PNG icons
docker compose build           # production image
```

Definition of done for any change: `npm run typecheck` ✅, `npm test` ✅, `npm run build` ✅, docs updated if behaviour/config changed, and a test added for new logic (security-relevant logic **must** have tests).

## Layout

```
server/src/            backend (TypeScript, ESM, NodeNext — import local files with .js extensions)
  app.ts               plugin + route wiring, perimeter hook, CSP, SPA fallback
  routes/<area>.ts     one module per area; export registerXRoutes(app, ctx, guards)
  db/                  node:sqlite wrapper, append-only migrations, models + public serializers
  security/ auth/      crypto vault, passwords, TOTP, CIDR, throttles, CF Access, sessions, guards
  ssh/                 connection pool (manager), terminal sessions, stats parsers, keys
  ai/                  providers (Anthropic SDK, OpenAI-compatible), prompts, risk classifier
  help/                offline command data, recipes, key sheets, local-first resolver, tldr
server/test/           vitest suites + helpers (real sshd launcher, HTTP client)
web/src/               Preact SPA: state.ts (signals), api.ts, terminal/engine.ts, components/*
web/public/            PWA manifest, icons, service worker
e2e/                   Playwright tests
deploy/                cloudflare-setup.sh, backup.sh, Caddyfile, systemd unit, fail2ban filter
docs/                  install, user guide, Cloudflare, architecture
```

## Security invariants — never break these

1. **Every route has a guard.** Use `guards.user` (normal), `guards.admin`, `guards.account` (allowed during enrolment: password/2FA/settings only) or `guards.mfa` (2nd-factor endpoints). Unauthenticated routes are limited to `/healthz` and `/api/auth/{state,setup,login,passkey/*,logout}`.
2. **Authorization by ownership.** Hosts: `Hosts.accessible(db, userId, id)` to *use* (own or shared), `ownedOr404` to *modify* (owner or admin). Keys/snippets: owner only. Never trust an id from the client without these checks. A host may only use keys owned by the host's owner.
3. **Secrets are write-only.** SSH passwords, private keys, passphrases, TOTP secrets, AI API keys: encrypt with `ctx.vault.encrypt(value, '<kind>:<id>')` (AAD binds ciphertext to its row), and return only booleans (`hasPassword`, `apiKeySet`). Use the `public*()` serializers in `db/models.ts`. There is a test asserting no secret material is returned — extend it if you add secrets.
4. **Validate all input with zod** via `parse()` from `util/http.ts`. Bound every string/array length.
5. **Never build shell commands by concatenation.** Use `shq()` for every interpolated value and validate names with strict regexes (see `CONTAINER`/`UNIT` in `routes/monitor.ts`). Prefer SFTP over shelling out for file operations.
6. **State-changing requests need CSRF + Origin.** Don't add GET endpoints that change state. WebSocket upgrades must keep the Origin check.
7. **Audit** every security-relevant action with `ctx.audit.write({...actor(req), action, target, success, details})`. Never put secrets (passwords, keys, tokens, file contents) in audit details or logs.
8. **AI never executes without the user.** The server only *proposes*; execution goes through `/api/hosts/:id/exec`, which re-classifies with `classifyCommand()` and requires `confirmDangerous` for dangerous commands. Don't add auto-execution paths beyond the existing opt-in "auto-run read-only". Terminal output sent to models must stay wrapped by `wrapTerminalContext()` (untrusted data).
9. **Host keys:** never accept a changed host key automatically; resets must be explicit and audited.
10. **CSP stays strict:** no inline scripts, no `eval`, no third-party script origins. The UI must work offline-built (no CDNs).
11. **Migrations are append-only.** Add a new entry to `MIGRATIONS`; never edit existing ones (deployed DBs have already applied them).
12. **Don't weaken defaults** (`REQUIRE_2FA=true`, lockouts, cookie flags, container hardening in `docker-compose.yml`) without an explicit request from the owner.

## Conventions

- TypeScript strict everywhere. Match surrounding style: small modules, early returns, comments only where the *why* isn't obvious.
- Server errors: throw `HttpError` (`badRequest`, `notFound`, `forbidden`, `conflict`) — never leak stack traces.
- SSH failures: `SshError` with a `code` (`HOST_KEY_UNKNOWN`, `HOST_KEY_MISMATCH`, `AUTH_FAILED`, `TARGET_DENIED`, …); routes map these to HTTP statuses (409 for "connect interactively first").
- Non-interactive SSH use (`ctx.ssh.run`/`lease` with default `NON_INTERACTIVE`) must never prompt; interactive prompts only happen over the terminal WebSocket.
- Frontend state lives in `web/src/state.ts` signals; terminal state in `terminal/engine.ts` (controllers are not Preact components — they own the xterm DOM and survive re-renders).
- Use `confirmDialog`/`promptDialog` (promise-based) instead of `window.confirm/prompt`.
- Mobile matters: test layouts at ~390 px wide; keep tap targets ≥ 32 px; the key bar must not steal focus (`onMouseDown={preventDefault}`).
- Command help is **local-first**: extend `help/commands.ts` / `help/recipes.ts` (with good `keywords`) before reaching for AI. The resolver only sets `suggestAi` when local data can't answer; keep it that way.
- AI: Anthropic integration uses the official SDK (`@anthropic-ai/sdk`). Default model `claude-opus-5-5`, adaptive thinking, server-side refusal fallbacks only on the official endpoint, assistant `raw` content echoed back unchanged (append-only history). OpenAI-compatible path covers Ollama/LM Studio/OpenRouter. Keep provider-specific code inside `ai/anthropic.ts` / `ai/openai.ts`.
- Dependencies: only free/open-source, actively maintained packages; run `npm audit` after adding one. Avoid native addons (the image has no build toolchain).

## Adding things — recipes

**A new API route**
1. Add it to the right `server/src/routes/<area>.ts` with a guard, zod validation, ownership checks, audit entry.
2. Add a test in `server/test/` (integration test if it touches SSH — the sshd helper makes this easy).
3. Call it from the UI via `api.get/post/...` in `web/src/api.ts`.

**A new setting**
- Deployment/security-critical → env var in `config.ts` + `.env.example` + docs (read-only in Admin UI via `routes/admin.ts` `env`).
- Runtime-tunable → `AppSettingsSchema` in `appSettings.ts` + `SettingsUpdate` in `routes/admin.ts` + Admin UI.

**A new host action that runs a remote command** (e.g. a dashboard button)
- Build the command from constants + `shq(validatedValue)`; use `priv(h)` for sudo; return parsed results; audit it; handle "permission denied" with a helpful message.

**A DB change** → new migration string appended to `db/migrations.ts`, model functions in `db/models.ts`, serializer that excludes secrets.

## Gotchas

- `node:sqlite` prints an ExperimentalWarning — scripts pass `--disable-warning=ExperimentalWarning`.
- The desktop terminal renders with WebGL (canvas) — tests read the screen via `window.__webssh.screen()` (only exposed under `navigator.webdriver`).
- TOTP codes are single-use per 30 s step (replay protection) — tests must use fresh steps.
- `PUBLIC_URL` must equal the browser origin (Origin checks, cookies, WebAuthn RP ID). In dev with Vite use `PUBLIC_URL=http://localhost:5173`.
- Behind Cloudflare Access, direct LAN access fails when `CF_ACCESS_*` is set (no JWT) — by design.
- Wake-on-LAN broadcasts need host networking (`docker-compose.hostnet.yml`).
- The container root filesystem is read-only: write only to `/data` and `/tmp`.

## Git / PRs

- Small, focused commits with clear messages; never commit `.env`, `data/`, keys, or tokens.
- CI (`.github/workflows/ci.yml`) runs typecheck, tests (with sshd), build and a Docker build — keep it green.
