# Cloudflare setup (free)

WebSSH is published through **Cloudflare Tunnel** and protected by **Cloudflare Access**:

```
 Browser ──HTTPS──▶ Cloudflare edge ──(Access login: email PIN / Google / GitHub)──▶ Tunnel ──▶ cloudflared (homelab) ──▶ webssh:8080 ──SSH──▶ your servers
```

- **Tunnel**: `cloudflared` runs on your homelab and opens an *outbound* connection to Cloudflare. Nothing listens on your public IP, and you don't forward any ports on your router.
- **Access**: before a request ever reaches your homelab, Cloudflare makes the visitor prove who they are (one-time PIN sent to your email by default). Only the emails you list get through. WebSSH then verifies the signed `Cf-Access-Jwt-Assertion` header on every request (`CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD`), so even a request that somehow bypassed Cloudflare is rejected.
- **Cost**: DNS, Tunnel, and Access (Zero Trust Free plan, up to 50 users) are all $0. When you first open Zero Trust, Cloudflare may ask you to pick a plan and possibly add a payment method for the Free plan; you won't be charged on Free. If you'd rather not, skip Access: the tunnel alone plus WebSSH's own password + mandatory 2FA is still strong (see the bottom of this page).

## Prerequisites

1. A Cloudflare account (free) with `lucafchala.com` added as a zone (your nameservers point to Cloudflare).
2. The WebSSH stack checked out on the homelab machine (see [INSTALL.md](INSTALL.md)).

## Option A — automated (recommended)

1. **Activate Zero Trust once.** Open <https://one.dash.cloudflare.com/>, pick a **team name** (e.g. `lucafchala` → `lucafchala.cloudflareaccess.com`) and choose the **Free** plan.
2. **Create an API token** at <https://dash.cloudflare.com/profile/api-tokens> → *Create Token* → *Custom token*:

   | Scope | Permission | Access |
   |---|---|---|
   | Account | Cloudflare Tunnel | Edit |
   | Account | Access: Apps and Policies | Edit |
   | Account | Access: Organizations, Identity Providers, and Groups | Read |
   | Zone (lucafchala.com) | DNS | Edit |

   Copy the token. You can delete it after setup; nothing stores it.
3. **Find your Account ID**: dashboard → `lucafchala.com` → right sidebar → *Account ID*.
4. **Run the script** in the repository folder on the homelab:

   ```bash
   CF_API_TOKEN=xxxx CF_ACCOUNT_ID=yyyy ./deploy/cloudflare-setup.sh \
     --hostname webssh.lucafchala.com \
     --email lfchala4@gmail.com
   ```

   It creates (or updates, so it's safe to re-run) the tunnel `webssh-homelab`, routes `webssh.lucafchala.com → http://webssh:8080`, creates the proxied DNS record and the Access application + "WebSSH owners" policy, then writes `CLOUDFLARE_TUNNEL_TOKEN`, `CF_ACCESS_TEAM_DOMAIN`, `CF_ACCESS_AUD` and `PUBLIC_URL` into `.env`.
5. `docker compose up -d` — the `cloudflared` container connects, and within ~30 s the tunnel shows **Healthy** in *Networking → Tunnels*.

Requirements: `curl` and `jq` (`sudo apt install -y jq`).

## Option B — dashboard (manual, ~10 minutes)

### 1. Tunnel
1. Cloudflare dashboard → **Networking → Tunnels** (or Zero Trust → Networks → Tunnels) → **Create a tunnel** → type **Cloudflared** → name `webssh-homelab`.
2. On the *Install connector* step choose **Docker**, and copy the token (the long `eyJ…` string after `--token`). Put it in `.env`:
   ```
   CLOUDFLARE_TUNNEL_TOKEN=eyJ...
   ```
   Don't run their `docker run` command; our `docker-compose.yml` already includes `cloudflared`.
3. **Public hostname / published application route**: subdomain `webssh`, domain `lucafchala.com`, service **HTTP** → `webssh:8080`.
   If you use the host-network override (`docker-compose.hostnet.yml`, for Wake-on-LAN), use `localhost:8080` instead.
4. Save. The DNS record is created automatically.

### 2. Access application
1. Zero Trust → **Access controls → Applications → Add an application → Self-hosted**.
2. Name `WebSSH`, public hostname `webssh.lucafchala.com`, session duration `24h`.
3. **Policy**: action **Allow**, include → **Emails** → `lfchala4@gmail.com` (add family/friends here if needed).
4. Login methods: *One-time PIN* is on by default. You can add **Google** or **GitHub** under *Integrations → Identity providers* (free).
5. Save, then open the application's **Overview** and copy the **Application Audience (AUD) Tag**.
6. In `.env`:
   ```
   CF_ACCESS_TEAM_DOMAIN=lucafchala.cloudflareaccess.com
   CF_ACCESS_AUD=<the AUD tag>
   ```
7. `docker compose up -d` to apply.

## Recommended free extras

- **SSL/TLS → Edge Certificates**: *Always Use HTTPS* on, *Minimum TLS* 1.2.
- **Security → WAF → Custom rules** (5 free): e.g. *block when Country not in {your countries}* for `webssh.lucafchala.com`. This is a cheap extra layer.
- **Rocket Loader / Auto-minify** must stay **off** for this hostname (they rewrite scripts; the app's CSP blocks them anyway).
- **WebSockets** are enabled by default (Network → WebSockets). Terminals need them.
- In Access settings, you can also require a hardware key or a specific country.

## Verify

```bash
curl -sI https://webssh.lucafchala.com | head -3     # → 302 redirect to <team>.cloudflareaccess.com (Access is working)
docker compose logs cloudflared | tail                # → "Registered tunnel connection" ×4
```

In a private browser window: open the URL → Access PIN page → enter your email → code → WebSSH login.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `Error 1033` / tunnel down | `docker compose logs cloudflared` — usually a wrong/missing `CLOUDFLARE_TUNNEL_TOKEN`. |
| `502 Bad Gateway` | The route points at the wrong service. It must be `http://webssh:8080` (bridge network) or `http://localhost:8080` (host network). Check `docker compose ps`. |
| WebSSH says *"Forbidden: Cloudflare Access required"* | `CF_ACCESS_AUD` / `CF_ACCESS_TEAM_DOMAIN` don't match the Access application, or you're hitting the app directly (LAN/port) while Access validation is enabled. |
| *"Cross-origin request rejected (check PUBLIC_URL)"* | `PUBLIC_URL` in `.env` must be exactly `https://webssh.lucafchala.com` (no trailing slash). |
| Terminal stuck on *Reconnecting* after a long idle | Your Access session expired. The app detects this and reloads into the Access login. If it doesn't, refresh the page. |
| Passkeys fail | Passkeys are bound to `PUBLIC_URL`'s hostname; they don't work if you browse via an IP or another hostname. |

## Without Access (tunnel only)

Leave `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD` empty (or run the script with `--no-access`). WebSSH stays protected by its own login: scrypt passwords, mandatory TOTP/passkey 2FA, account lockout, IP throttling and an audit log. The difference is that the login page itself is reachable from the internet. Consider adding a Cloudflare WAF country rule in that case.
