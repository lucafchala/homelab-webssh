# Installing WebSSH on your homelab

This takes about 20 minutes. At the end, `https://webssh.lucafchala.com` works from any browser, on desktop or phone, protected by Cloudflare Access plus your own login with 2FA.

> **Prefer to have it done for you?** Paste [HOMELAB_AGENT_PROMPT.md](../HOMELAB_AGENT_PROMPT.md) into an AI coding agent (for example Claude Code) running on the homelab machine. It follows this same guide, checks each step, and asks you before anything risky.

## 0. What you need

| Thing | Notes |
|---|---|
| An always-on Linux machine on your LAN | Any x86-64 or ARM64 box: a mini PC, NAS, Proxmox VM/LXC, or Raspberry Pi 4/5. 1 CPU core and 512 MB RAM is plenty (plus RAM for Ollama if you want local AI). |
| Docker Engine + Compose plugin | `curl -fsSL https://get.docker.com \| sh` (Debian/Ubuntu/Fedora). In a Proxmox LXC, enable *nesting*. |
| A Cloudflare account with `lucafchala.com` | Free plan. The domain's nameservers must point to Cloudflare. |
| An authenticator app | Aegis, 2FAS, Google Authenticator, 1Password, Bitwarden… or use passkeys. |

Everything here is free.

## 1. Get the code

```bash
sudo mkdir -p /opt/webssh && sudo chown "$USER" /opt/webssh
git clone https://github.com/lucafchala/webssh.lucafchala.com.git /opt/webssh
cd /opt/webssh
```

(Private repo? Use `gh repo clone lucafchala/webssh.lucafchala.com /opt/webssh`, or a deploy key.)

## 2. Configure

```bash
cp .env.example .env
chmod 600 .env
# Generate the encryption key for saved credentials:
sed -i "s|^MASTER_KEY=.*|MASTER_KEY=$(openssl rand -base64 32)|" .env
```

**Back up `MASTER_KEY` in your password manager now.** Without it, saved SSH passwords and keys can't be decrypted.

Open `.env` and check:
- `PUBLIC_URL=https://webssh.lucafchala.com`
- `SSH_TARGET_ALLOWLIST=192.168.0.0/16,10.0.0.0/8,100.64.0.0/10,172.16.0.0/12` — recommended. WebSSH can then only SSH into your own networks, never the internet. Adjust it to your LAN.

The other values have sensible defaults; each one is explained in `.env.example`.

## 3. Cloudflare Tunnel + Access

Follow [CLOUDFLARE.md](CLOUDFLARE.md). The short version:

```bash
sudo apt install -y jq
CF_API_TOKEN=<token> CF_ACCOUNT_ID=<id> ./deploy/cloudflare-setup.sh \
  --hostname webssh.lucafchala.com --email lfchala4@gmail.com
```

This fills `CLOUDFLARE_TUNNEL_TOKEN`, `CF_ACCESS_TEAM_DOMAIN` and `CF_ACCESS_AUD` in `.env`.

## 4. Start it

```bash
docker compose up -d --build
docker compose ps                    # webssh "healthy", cloudflared "running"
docker compose logs webssh | grep -A4 "FIRST RUN"
```

The log shows a **one-time setup token**. Copy it.

## 5. First login

1. Open `https://webssh.lucafchala.com`. Cloudflare Access asks for your email and sends you a PIN.
2. WebSSH shows **First-time setup**: paste the setup token, choose a username and a strong password (12+ characters with mixed character types, or a 16+ character passphrase).
3. **Secure your account**: scan the QR code with your authenticator app and enter the 6-digit code. **Save the 10 recovery codes** in your password manager.
4. Optional but recommended: *Settings → Passkeys → Add passkey* on each device (Face ID / Touch ID / Windows Hello).

## 6. Add your servers

The best practice is key-based login. WebSSH does it for you:

1. **Keys → Generate** (Ed25519). The private key is created on the server, encrypted, and never shown again.
2. **Hosts → Add host**: IP/hostname, user, *Authentication: Saved password* (temporarily) → **Save & connect**.
3. On first connect, **verify the host key fingerprint**. On the server's own console, run `ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` and compare. Then click *Trust & connect*.
4. **Keys → Install on host** → pick the host and keep "switch the host to this key" ticked. Done: the host now uses the key, and the saved password is deleted.
5. Once every host uses keys, consider turning off SSH password logins on those servers (Help panel → search *"ssh key login"*).

Tips:
- To manage the Docker host itself, add a host with hostname `host.docker.internal`.
- Machines behind another box: set that box as the **Jump host**.
- Have a `~/.ssh/config`? *Hosts → Import ~/.ssh/config*.
- For admin buttons (services, sudo file edits, reboot) as a non-root user, tick **Use passwordless sudo** and allow it on the server (Help panel → *"passwordless sudo"*).

## 7. Install the app on your phone

- **iPhone/iPad**: Safari → Share → **Add to Home Screen**.
- **Android**: Chrome → ⋮ → **Install app**.

It opens full-screen with the extra-keys bar above the keyboard.

## 8. Optional: free local AI with Ollama

```bash
docker compose --profile ai up -d
docker exec webssh-ollama ollama pull qwen2.5-coder:7b     # ~4.7 GB; use qwen2.5-coder:3b on small machines
```

Then in WebSSH go to **Admin → Settings & AI**: Provider **Ollama**, Base URL `http://ollama:11434/v1`, Model `qwen2.5-coder:7b` → **Save** → **Test**.

Using Claude instead (paid, best results): Provider **Anthropic Claude**, paste your API key from console.anthropic.com. The default model is `claude-opus-5-5`.

The offline Help panel never needs AI.

## 9. Wake-on-LAN (optional)

Docker's bridge network can't broadcast on your LAN. To use WoL buttons:

```bash
docker compose -f docker-compose.yml -f docker-compose.hostnet.yml up -d
```

Then change the tunnel route's service to `http://localhost:8080` (Cloudflare dashboard → Tunnels → your tunnel → Public hostnames, or re-run the setup script with `--service http://localhost:8080`).

## Updating

```bash
cd /opt/webssh
./deploy/backup.sh /opt/webssh-backups      # always back up first
git pull
docker compose up -d --build
docker image prune -f
```

Database migrations run automatically on start.

## Backups and restore

`./deploy/backup.sh /path/to/backups` writes a consistent snapshot (SQLite + recordings) and keeps the newest 14. Schedule it:

```bash
( crontab -l 2>/dev/null; echo "15 3 * * * cd /opt/webssh && ./deploy/backup.sh /opt/webssh-backups >/dev/null 2>&1" ) | crontab -
```

Also keep a copy of `.env`, which holds `MASTER_KEY`, somewhere safe.

**Restore:**

```bash
docker compose down
docker run --rm -v webssh_webssh-data:/data -v /opt/webssh-backups:/b alpine \
  sh -c 'rm -rf /data/* && tar -xzf /b/webssh-YYYYMMDD-HHMMSS.tar.gz -C /data && chown -R 1000:1000 /data'
docker compose up -d
```

## Break-glass (locked out?)

Run these on the homelab machine:

```bash
docker exec -it webssh node server/dist/cli.js list-users
docker exec -it webssh node server/dist/cli.js reset-2fa <username>       # lost phone
docker exec -it webssh node server/dist/cli.js reset-password <username>
docker exec -it webssh node server/dist/cli.js unlock <username>
docker exec -it webssh node server/dist/cli.js create-admin <username>
```

## Without Docker

```bash
sudo useradd --system --home /var/lib/webssh --shell /usr/sbin/nologin webssh
# Node.js 22+ required (https://nodejs.org or your distro / nodesource)
cd /opt/webssh && npm ci && npm run build && npm prune --omit=dev
sudo mkdir -p /etc/webssh && sudo cp .env /etc/webssh/webssh.env && sudo chmod 600 /etc/webssh/webssh.env
sudo cp deploy/systemd/webssh.service /etc/systemd/system/
sudo systemctl daemon-reload && sudo systemctl enable --now webssh
```

Run `cloudflared` as a service with your tunnel token (`sudo cloudflared service install <token>`) and point the route at `http://localhost:8080`.

## Troubleshooting

| Problem | Fix |
|---|---|
| "Invalid setup token" | Use the token from the *current* `docker compose logs webssh` (it changes each restart until setup is done), or set `SETUP_TOKEN` in `.env`. |
| 2FA codes are always "invalid" | Your phone's or the server's clock is off. Run `timedatectl` on the server and enable NTP. |
| "Cross-origin request rejected" | `PUBLIC_URL` must exactly match the URL in the address bar. |
| Host test: *outside SSH_TARGET_ALLOWLIST* | Add that network to `SSH_TARGET_ALLOWLIST` and restart. |
| Host test: *HOST KEY CHANGED* | Did you reinstall that server? Verify the new fingerprint on its console, then *Edit host → Reset pinned key*. If not, investigate. |
| Files/Stats say "needs interactive authentication" | That host uses "Ask every time". Open a terminal to it first (the connection is shared), or switch it to a key. |
| Docker/Services tabs: permission denied | Add the SSH user to the `docker` group, or enable passwordless sudo for it and tick *Use passwordless sudo* on the host. |
| Terminal text is tiny or huge on the phone | Use the A−/A+ keys on the key bar, or *Settings → Font size*. |
