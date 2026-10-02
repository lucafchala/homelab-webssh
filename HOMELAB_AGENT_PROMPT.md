# Prompt for the agent on your homelab

**How to use:** on the machine that will run WebSSH (a server, VM, or LXC with Docker support), start an AI coding agent with shell access, for example [Claude Code](https://claude.com/claude-code) (`claude` in a terminal). Fill in the three values in the *Settings* block below, then paste everything below the line. The agent will ask you for the few things only you can provide (Cloudflare token, choices) and will confirm before anything risky.

---

**Settings** (edit before pasting):

```
HOSTNAME    = webssh.example.com      # public hostname for WebSSH (a subdomain of a domain on Cloudflare)
OWNER_EMAIL = you@example.com         # email(s) allowed through Cloudflare Access
REPO_URL    = https://github.com/lucafchala/webssh.lucafchala.com.git
```

Wherever this prompt says `webssh.example.com` or `you@example.com`, use HOSTNAME and OWNER_EMAIL from the Settings block.

You are deploying **WebSSH**, a self-hosted web SSH console, on this homelab machine. The goal: `https://webssh.example.com` serves WebSSH through a **Cloudflare Tunnel** (no inbound ports), behind **Cloudflare Access** (only the owner's email gets through), with the app's own login + mandatory 2FA. Everything must stay **free** (Cloudflare free tier, open-source software, optional local AI via Ollama).

Repository: REPO_URL from the Settings block (if `git clone` fails because the repo is private, ask the owner to authenticate `gh` or provide a deploy key). After cloning, read `AGENTS.md`, `docs/INSTALL.md`, `docs/CLOUDFLARE.md` and `SECURITY.md` in the repo — they are the source of truth; this prompt is the plan.

## Ground rules

1. **Ask before** anything destructive or hard to reverse: deleting data/volumes, changing firewall rules, editing `sshd_config`, restarting networking, rebooting, installing kernel/system packages beyond what's listed, or touching other containers/services. Explain what and why in one or two sentences.
2. **Never lock the owner out.** Don't disable SSH password auth, change SSH ports, or enable a firewall unless the owner explicitly asks *and* you've verified an alternative login works in a separate session.
3. **Secrets:** never echo `MASTER_KEY`, the tunnel token, or API tokens into your replies or logs. Write them to `.env` (`chmod 600`) only. Ask the owner to paste the Cloudflare API token directly into a shell variable prompt (e.g. `read -rs CF_API_TOKEN`), not into the chat, when your interface allows that.
4. Prefer the repository's scripts and documented commands over improvisation. If something in the docs is wrong for this system, fix it locally, note it, and include it in the final report (suggest a PR).
5. Verify every step (commands' exit codes, `docker compose ps`, health checks, `curl`) before moving on. If a step fails twice, stop and explain the error and options.
6. Keep a running checklist and print it at the end.

## Plan

### 1. Discover (read-only)
- OS / distro / architecture (`/etc/os-release`, `uname -m`), CPU/RAM/disk free, whether this is a VM/LXC (`systemd-detect-virt`).
- Docker + Compose plugin present? (`docker version`, `docker compose version`). In an LXC, check nesting works.
- LAN details: primary interface, IP, subnet(s) (`ip -br a`, `ip r`) — used for `SSH_TARGET_ALLOWLIST`.
- Time sync (`timedatectl`) — 2FA needs a correct clock.
- Whether anything already uses the names `webssh`, `webssh-cloudflared`, or a `/opt/webssh` directory.
Report findings briefly to the owner.

### 2. Prerequisites (ask first)
- If Docker is missing: propose installing via `curl -fsSL https://get.docker.com | sh` and adding the user to the `docker` group. Ask before running.
- Install `git`, `curl`, `jq`, `openssl` if missing.
- If NTP is off: propose `sudo timedatectl set-ntp true`.

### 3. Get the code and configure
```bash
sudo mkdir -p /opt/webssh && sudo chown "$USER" /opt/webssh
git clone <REPO_URL> /opt/webssh && cd /opt/webssh      # REPO_URL from the Settings block
cp .env.example .env && chmod 600 .env
sed -i "s|^MASTER_KEY=.*|MASTER_KEY=$(openssl rand -base64 32)|" .env
```
- Set `PUBLIC_URL=https://webssh.example.com`.
- Set `SSH_TARGET_ALLOWLIST` to the discovered LAN subnet(s) plus common private ranges the owner uses (ask: Tailscale `100.64.0.0/10`? other VLANs? Docker host `172.16.0.0/12`).
- Tell the owner: **save `MASTER_KEY` in your password manager** (show them how to view it: `grep MASTER_KEY /opt/webssh/.env`), but don't print it yourself.

### 4. Cloudflare (free)
Ask the owner which path they prefer:
- **A. Automated** (recommended): they activate Zero Trust once at https://one.dash.cloudflare.com/ (team name + Free plan), create an API token with *Account: Cloudflare Tunnel Edit, Access: Apps and Policies Edit, Access: Organizations… Read; Zone: DNS Edit* (see `docs/CLOUDFLARE.md`), and give you the token + Account ID + the email(s) allowed through Access. Then run:
  ```bash
  read -rs CF_API_TOKEN; export CF_API_TOKEN
  CF_ACCOUNT_ID=<id> ./deploy/cloudflare-setup.sh --hostname webssh.example.com --email <OWNER_EMAIL>
  unset CF_API_TOKEN
  ```
  Afterwards suggest they delete or narrow the API token.
- **B. Manual**: walk them through `docs/CLOUDFLARE.md` Option B and have them paste the tunnel token and the Access AUD tag into `.env` (or give them to you to write).
If the owner declines Access, run the script with `--no-access` and make sure they understand the trade-off (documented at the bottom of `docs/CLOUDFLARE.md`).

### 5. Deploy
```bash
docker compose up -d --build
docker compose ps
docker compose logs --tail=50 webssh
docker compose logs --tail=20 cloudflared     # expect "Registered tunnel connection"
```
- Wait for `webssh` to be **healthy**.
- Verify locally: `docker compose exec webssh node -e "fetch('http://127.0.0.1:8080/healthz').then(r=>r.text()).then(console.log)"`.
- Verify publicly: `curl -sI https://webssh.example.com | head -5` → expect a redirect to `<team>.cloudflareaccess.com` when Access is on (or `200` without Access).
- Get the one-time setup token: `docker compose logs webssh | grep -A4 "FIRST RUN"` and give it to the owner **privately** (it only allows creating the first admin and expires once used).

### 6. Owner's first login (guide them)
1. Open https://webssh.example.com → Access email PIN → WebSSH *First-time setup* → setup token, username, strong password.
2. Enrol the authenticator app, **save the recovery codes**, optionally add passkeys on phone/laptop.
3. *Keys → Generate* an Ed25519 key; *Hosts → Add host* for this machine (`host.docker.internal`, their user, password temporarily) → verify fingerprint on this machine with `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` (you can print the fingerprint for them) → *Keys → Install on host*.
4. Repeat for other servers (or import their `~/.ssh/config`).

### 7. Optional extras (offer, don't assume)
- **Free local AI**: if the machine has ≥ 8 GB RAM free (or a GPU), offer `docker compose --profile ai up -d` and `docker exec webssh-ollama ollama pull qwen2.5-coder:7b` (or `:3b` on small machines; GPU passthrough per the commented block in `docker-compose.yml`). Then the owner sets Admin → Settings & AI → Ollama, base URL `http://ollama:11434/v1`. Measure a test prompt's speed and report it.
- **Wake-on-LAN**: only if they want WoL buttons — switch to `docker-compose.hostnet.yml` and update the tunnel route to `http://localhost:8080` (re-run the setup script with `--service http://localhost:8080`).
- **Backups**: add the cron entry from `docs/INSTALL.md` (`./deploy/backup.sh /opt/webssh-backups` nightly). Ask where backups should live (ideally a NAS or another disk).
- **Auto-start on boot**: confirm the Docker service is enabled (`systemctl is-enabled docker`); containers use `restart: unless-stopped`.
- **Host hardening suggestions** (report only; apply only with explicit consent, one host at a time, keeping a second session open): key-only SSH (`PasswordAuthentication no`) once keys work everywhere, unattended security updates, passwordless sudo limited to what the WebSSH dashboard needs (`/usr/bin/systemctl`, `/usr/bin/docker`, `/usr/bin/journalctl`) via `/etc/sudoers.d/`.

### 8. Final report
Print a concise summary:
- What was installed/changed (files, packages, containers, cron), and where `.env` and backups live.
- Cloudflare objects created (tunnel name/id, DNS record, Access app/policy) and the allowed emails.
- Health check results (local + public), versions (`git rev-parse --short HEAD`, `docker compose images`).
- The owner's to-do list: save MASTER_KEY + recovery codes, add passkeys, add servers, enable key-only SSH later, delete the Cloudflare API token.
- Any problems found in the repo/docs and suggested fixes.
- How to update later: `cd /opt/webssh && ./deploy/backup.sh /opt/webssh-backups && git pull && docker compose up -d --build`.
- Break-glass commands: `docker exec -it webssh node server/dist/cli.js reset-2fa <user>` (and `reset-password`, `unlock`, `create-admin`, `list-users`).
