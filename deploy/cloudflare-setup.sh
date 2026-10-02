#!/usr/bin/env bash
# Automates the free Cloudflare setup for WebSSH:
#   1. a remotely-managed Cloudflare Tunnel  (homelab → Cloudflare, no open ports)
#   2. the public hostname route + proxied DNS record
#   3. a Cloudflare Access application + allow policy (only your email(s) get through)
#   4. writes CLOUDFLARE_TUNNEL_TOKEN, CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD into .env
#
# Requirements: bash, curl, jq; a Cloudflare API token with these permissions:
#   Account → Cloudflare Tunnel → Edit
#   Account → Access: Apps and Policies → Edit
#   Account → Access: Organizations, Identity Providers, and Groups → Read
#   Zone    → DNS → Edit            (for your domain's zone)
# Create it at https://dash.cloudflare.com/profile/api-tokens (it is not stored anywhere by this script).
#
# Usage:
#   CF_API_TOKEN=... CF_ACCOUNT_ID=... ./deploy/cloudflare-setup.sh \
#       --hostname webssh.lucafchala.com --email you@example.com [--email other@example.com] \
#       [--service http://webssh:8080] [--env-file .env] [--zone lucafchala.com] [--no-access]
set -euo pipefail

API="${CF_API_BASE:-https://api.cloudflare.com/client/v4}"
HOSTNAME_=""
SERVICE="http://webssh:8080"
ENV_FILE=".env"
TUNNEL_NAME="webssh-homelab"
ZONE_NAME=""
NO_ACCESS=0
EMAILS=()

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hostname) HOSTNAME_="$2"; shift 2 ;;
    --email) EMAILS+=("$2"); shift 2 ;;
    --service) SERVICE="$2"; shift 2 ;;
    --env-file) ENV_FILE="$2"; shift 2 ;;
    --tunnel-name) TUNNEL_NAME="$2"; shift 2 ;;
    --zone) ZONE_NAME="$2"; shift 2 ;;
    --no-access) NO_ACCESS=1; shift ;;
    -h|--help) sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

die() { echo "ERROR: $*" >&2; exit 1; }
command -v jq >/dev/null || die "jq is required (apt install jq)"
command -v curl >/dev/null || die "curl is required"
[[ -n "${CF_API_TOKEN:-}" ]] || die "set CF_API_TOKEN"
[[ -n "${CF_ACCOUNT_ID:-}" ]] || die "set CF_ACCOUNT_ID (dashboard → any domain → Overview → right sidebar → Account ID)"
[[ -n "$HOSTNAME_" ]] || die "--hostname is required (e.g. webssh.lucafchala.com)"
[[ $NO_ACCESS -eq 1 || ${#EMAILS[@]} -gt 0 ]] || die "pass at least one --email allowed through Cloudflare Access (or --no-access)"

cf() { # method path [json]
  local method="$1" path="$2" body="${3:-}"
  local out
  if [[ -n "$body" ]]; then
    out=$(curl -sS -X "$method" "$API$path" -H "Authorization: Bearer $CF_API_TOKEN" -H "Content-Type: application/json" --data "$body")
  else
    out=$(curl -sS -X "$method" "$API$path" -H "Authorization: Bearer $CF_API_TOKEN")
  fi
  if [[ "$(jq -r '.success' <<<"$out")" != "true" ]]; then
    echo "Cloudflare API error on $method $path:" >&2
    jq -r '.errors[]? | "  [\(.code)] \(.message)"' <<<"$out" >&2 || echo "$out" >&2
    return 1
  fi
  echo "$out"
}

echo "→ Verifying API token…"
cf GET "/user/tokens/verify" >/dev/null 2>&1 || cf GET "/accounts/$CF_ACCOUNT_ID/tokens/verify" >/dev/null || die "API token is invalid"

# Default zone = last two labels (pass --zone for domains like example.co.uk)
[[ -n "$ZONE_NAME" ]] || ZONE_NAME=$(awk -F. '{print $(NF-1)"."$NF}' <<<"$HOSTNAME_")
echo "→ Looking up zone $ZONE_NAME…"
ZONE_ID=$(cf GET "/zones?name=$ZONE_NAME" | jq -r '.result[0].id // empty')
[[ -n "$ZONE_ID" ]] || die "zone $ZONE_NAME not found in this account (is the domain on Cloudflare?)"

echo "→ Creating (or reusing) tunnel '$TUNNEL_NAME'…"
TUNNEL_ID=$(cf GET "/accounts/$CF_ACCOUNT_ID/cfd_tunnel?name=$TUNNEL_NAME&is_deleted=false" | jq -r '.result[0].id // empty')
if [[ -z "$TUNNEL_ID" ]]; then
  TUNNEL_ID=$(cf POST "/accounts/$CF_ACCOUNT_ID/cfd_tunnel" "$(jq -n --arg n "$TUNNEL_NAME" '{name:$n, config_src:"cloudflare"}')" | jq -r '.result.id')
fi
echo "   tunnel id: $TUNNEL_ID"

echo "→ Routing https://$HOSTNAME_ → $SERVICE …"
cf PUT "/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/configurations" "$(jq -n --arg h "$HOSTNAME_" --arg s "$SERVICE" '{
  config: { ingress: [
    { hostname: $h, service: $s, originRequest: { connectTimeout: 30, noTLSVerify: false } },
    { service: "http_status:404" }
  ] } }')" >/dev/null

echo "→ DNS record $HOSTNAME_ → $TUNNEL_ID.cfargotunnel.com …"
EXISTING=$(cf GET "/zones/$ZONE_ID/dns_records?name=$HOSTNAME_" | jq -r '.result[0].id // empty')
DNS_BODY=$(jq -n --arg h "$HOSTNAME_" --arg c "$TUNNEL_ID.cfargotunnel.com" '{type:"CNAME", name:$h, content:$c, proxied:true, comment:"WebSSH via Cloudflare Tunnel"}')
if [[ -n "$EXISTING" ]]; then
  cf PUT "/zones/$ZONE_ID/dns_records/$EXISTING" "$DNS_BODY" >/dev/null
else
  cf POST "/zones/$ZONE_ID/dns_records" "$DNS_BODY" >/dev/null
fi

TUNNEL_TOKEN=$(cf GET "/accounts/$CF_ACCOUNT_ID/cfd_tunnel/$TUNNEL_ID/token" | jq -r '.result')

TEAM_DOMAIN=""
AUD=""
if [[ $NO_ACCESS -eq 0 ]]; then
  echo "→ Reading Zero Trust organization…"
  if ! ORG=$(cf GET "/accounts/$CF_ACCOUNT_ID/access/organizations"); then
    die "No Zero Trust organization yet. Open https://one.dash.cloudflare.com/ once, pick a team name and the Free plan, then re-run."
  fi
  TEAM_DOMAIN=$(jq -r '.result.auth_domain' <<<"$ORG")
  echo "   team domain: $TEAM_DOMAIN"

  echo "→ Creating Access policy for: ${EMAILS[*]}"
  INCLUDE=$(printf '%s\n' "${EMAILS[@]}" | jq -R '{email:{email:.}}' | jq -s '.')
  POLICY_ID=$(cf GET "/accounts/$CF_ACCOUNT_ID/access/policies" | jq -r '.result[] | select(.name=="WebSSH owners") | .id' | head -n1)
  POLICY_BODY=$(jq -n --argjson inc "$INCLUDE" '{name:"WebSSH owners", decision:"allow", include:$inc, session_duration:"24h"}')
  if [[ -n "$POLICY_ID" ]]; then
    cf PUT "/accounts/$CF_ACCOUNT_ID/access/policies/$POLICY_ID" "$POLICY_BODY" >/dev/null
  else
    POLICY_ID=$(cf POST "/accounts/$CF_ACCOUNT_ID/access/policies" "$POLICY_BODY" | jq -r '.result.id')
  fi

  echo "→ Creating (or updating) Access application for $HOSTNAME_…"
  APP_ID=$(cf GET "/accounts/$CF_ACCOUNT_ID/access/apps" | jq -r --arg h "$HOSTNAME_" '.result[] | select(.domain==$h) | .id' | head -n1)
  APP_BODY=$(jq -n --arg h "$HOSTNAME_" --arg p "$POLICY_ID" '{
    name: "WebSSH", domain: $h, type: "self_hosted", session_duration: "24h",
    app_launcher_visible: false, auto_redirect_to_identity: false,
    http_only_cookie_attribute: true, same_site_cookie_attribute: "lax", enable_binding_cookie: false,
    policies: [ { id: $p, precedence: 1 } ] }')
  if [[ -n "$APP_ID" ]]; then
    APP=$(cf PUT "/accounts/$CF_ACCOUNT_ID/access/apps/$APP_ID" "$APP_BODY")
  else
    APP=$(cf POST "/accounts/$CF_ACCOUNT_ID/access/apps" "$APP_BODY")
  fi
  AUD=$(jq -r '.result.aud' <<<"$APP")
  echo "   application AUD: $AUD"
fi

set_env() { # key value
  local k="$1" v="$2"
  touch "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  if grep -qE "^$k=" "$ENV_FILE"; then
    # use a delimiter that can't appear in tokens
    sed -i "s|^$k=.*|$k=$v|" "$ENV_FILE"
  else
    echo "$k=$v" >>"$ENV_FILE"
  fi
}

set_env CLOUDFLARE_TUNNEL_TOKEN "$TUNNEL_TOKEN"
set_env PUBLIC_URL "https://$HOSTNAME_"
if [[ -n "$AUD" ]]; then
  set_env CF_ACCESS_TEAM_DOMAIN "$TEAM_DOMAIN"
  set_env CF_ACCESS_AUD "$AUD"
fi

cat <<EOF

✅ Cloudflare is configured.
   Tunnel:       $TUNNEL_NAME ($TUNNEL_ID) → $SERVICE
   Public URL:   https://$HOSTNAME_
   Access:       $([[ -n "$AUD" ]] && echo "only ${EMAILS[*]} (one-time PIN by email; add Google/GitHub login in Zero Trust → Integrations → Identity providers)" || echo "disabled")
   Wrote CLOUDFLARE_TUNNEL_TOKEN$([[ -n "$AUD" ]] && echo ", CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD") and PUBLIC_URL to $ENV_FILE

Next:  docker compose up -d --build   then open https://$HOSTNAME_
EOF
