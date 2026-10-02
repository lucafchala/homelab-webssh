# Security

A web SSH console is a high-value target: whoever controls it controls your homelab. WebSSH is built so that an attacker has to beat **several independent layers**, and so that you can see what happened afterwards.

## Threat model

| Threat | Mitigations |
|---|---|
| Internet scanners / brute force against the login | Cloudflare Tunnel (no inbound port); Cloudflare Access in front (only your email/IdP passes); app login with scrypt password + **mandatory 2FA**; per-account lockout; per-IP failure throttle; global and per-route rate limits; constant-time responses for unknown users |
| Stolen password | 2FA required (TOTP with replay protection, or passkeys); new-device sessions visible and revocable |
| Lost phone / authenticator | 10 single-use recovery codes (stored hashed); admin "reset 2FA"; CLI break-glass on the host |
| Phishing | Passkeys (WebAuthn) are origin-bound and unphishable; Access login happens on Cloudflare's domain |
| Session theft (XSS / cookies) | Strict CSP (`script-src 'self'`, no inline scripts, `frame-ancestors 'none'`); `HttpOnly; Secure; SameSite=Strict` cookies with the `__Host-` prefix; session tokens stored as SHA-256 hashes; tokens rotated on 2FA completion; idle + absolute expiry; open WebSockets are re-checked every 30 s and closed when the session is revoked |
| CSRF / cross-site WebSocket hijacking | Per-session CSRF token header on every state-changing request; `Origin` must equal `PUBLIC_URL` for POST/PUT/PATCH/DELETE and WebSocket upgrades; `SameSite=Strict` |
| Origin reached directly (bypassing Cloudflare) | Tunnel means there is no public origin; optionally every request must carry a valid **Cloudflare Access JWT** (verified against your team's JWKS + AUD); optional `IP_ALLOWLIST` |
| Database / backup leak | SSH passwords, private keys, passphrases, TOTP secrets and AI API keys are encrypted with **AES-256-GCM** (key derived via HKDF from `MASTER_KEY`), each bound to its record by associated data; passwords hashed with scrypt (N=2¹⁷); session tokens hashed |
| Man-in-the-middle between WebSSH and your servers | Host keys pinned on first use (user is shown the SHA-256 fingerprint to verify); any change blocks the connection and is audited; reset requires the host owner and is audited |
| Compromised WebSSH account used to pivot | `SSH_TARGET_ALLOWLIST` limits which networks can be reached (resolved IP is checked and then used, preventing DNS rebinding); per-user host ownership; full audit trail; admin can kill sessions |
| Over-eager AI agent | Every command needs explicit approval; heuristic risk classifier with a second typed confirmation for destructive commands (also enforced server-side: `428` without `confirmDangerous`); commands run in a separate, non-interactive channel with timeouts and output caps; 12-step limit; terminal output sent to the model is wrapped as untrusted data; everything audited |
| Container escape impact | Runs as non-root `node` user, read-only root filesystem, all Linux capabilities dropped, `no-new-privileges`, memory/PID limits; no Docker socket mounted |
| Secrets in logs | Cookies, CSRF tokens, Authorization and Access JWT headers are redacted; private keys/passwords never logged or returned by the API |

## What is *not* protected

- **Root on the WebSSH host or a copy of `.env` + the data volume** gives access to all stored credentials. Protect the machine, keep `.env` at `chmod 600`, and store backups encrypted.
- If you use `MASTER_KEY_FILE`/env unset, an auto-generated key is stored **inside** the data volume (`master.key`) — then a copy of the volume alone is enough. Always set `MASTER_KEY` (the install guide does).
- An admin account can see the audit log and manage users, but cannot read other users' stored secrets through the UI/API.
- The risk classifier is a **guard rail, not a sandbox**. Read the commands you approve.

## Hardening checklist

- [ ] `MASTER_KEY` set in `.env` (and backed up in your password manager); `.env` is `chmod 600`
- [ ] Cloudflare Access enabled with only your email(s); `CF_ACCESS_TEAM_DOMAIN` + `CF_ACCESS_AUD` set
- [ ] `REQUIRE_2FA=true` (default) and a passkey registered on each of your devices
- [ ] Recovery codes saved offline
- [ ] `SSH_TARGET_ALLOWLIST` set to your LAN/VPN ranges
- [ ] No `ports:` published in `docker-compose.yml` (tunnel only)
- [ ] Hosts use SSH **keys**; password auth disabled in each server's `sshd_config` once keys work
- [ ] Each server's host key fingerprint verified on first connect
- [ ] A dedicated, least-privilege SSH user where possible (sudo only for what you need, via `/etc/sudoers.d/`)
- [ ] Recording enabled for sensitive hosts if you want an audit of terminal output
- [ ] Regular `./deploy/backup.sh` + `git pull && docker compose up -d --build` for updates
- [ ] Cloudflare WAF custom rule limiting countries (optional)
- [ ] Review **Admin → Audit log** occasionally (filter "Failures only")

## Reporting a vulnerability

Please open a private security advisory on the GitHub repository (Security → Advisories → Report a vulnerability) rather than a public issue.
