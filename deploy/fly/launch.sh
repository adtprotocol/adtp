#!/usr/bin/env bash
# Starts one ADTP node on Fly.io for one address. Run it again to update that node.
#
#   bash deploy/fly/launch.sh <app-name> <address> <host> [human|agent] [description]
#
#   bash deploy/fly/launch.sh adtp-dylan  dylan@stratuslabs.com adtp.stratuslabs.com human
#   bash deploy/fly/launch.sh adtp-source source@adtp.dev       node.adtp.dev        agent "A test address for trying ADTP."
#
#   <app-name>     the Fly app to create: any name nobody else on Fly has taken
#   <address>      the address this node serves
#   <host>         the hostname the node is reached at; you point it at Fly in DNS afterwards
#   human|agent    what kind of address it is (default: human)
#   description    one line saying what the address is for. Giving one lists the
#                  address in the domain's public directory; leave it out to stay unlisted.
#
# Environment: FLY_REGION (default iad), FLY_ORG (default: Fly asks, or uses your only one).
# Two optional settings for the address are also read from the environment:
#   ADTP_FIRST_CONTACT=open   deliver a stranger's first message at once instead of holding it for approval
#   ADTP_AUTO_REPLY="text"    answer every message with this text, once per thread
#
# It needs flyctl (https://fly.io/docs/flyctl/install/), signed in with `fly auth login`.
# The two API tokens are generated once and kept in .env.fly.<app-name> at the
# repository root (ignored by git). They are never printed.
set -euo pipefail

usage() { sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//' >&2; exit 2; }

APP="${1:-}"; ADDRESS="${2:-}"; HOST="${3:-}"; TYPE="${4:-human}"; DESCRIPTION="${5:-}"
[ -n "$APP" ] && [ -n "$ADDRESS" ] && [ -n "$HOST" ] || usage
case "$ADDRESS" in *@*.*) ;; *) echo "launch: \"$ADDRESS\" is not an address (name@domain)" >&2; exit 2 ;; esac
case "$TYPE" in human|agent) ;; *) echo "launch: the kind of address is human or agent, not \"$TYPE\"" >&2; exit 2 ;; esac
case "$HOST" in *://*|*/*) echo "launch: give the host as a bare name, like node.example.com" >&2; exit 2 ;; esac

LOCAL="${ADDRESS%@*}"
DOMAIN="${ADDRESS##*@}"
REGION="${FLY_REGION:-iad}"
VOLUME="adtp_data"

FLY="$(command -v fly || command -v flyctl || true)"
[ -n "$FLY" ] || { echo "launch: flyctl is not installed: https://fly.io/docs/flyctl/install/" >&2; exit 1; }
"$FLY" auth whoami >/dev/null 2>&1 || { echo "launch: not signed in to Fly. Run: fly auth login" >&2; exit 1; }

# fly.toml and the Dockerfile are at the repository root.
cd "$(dirname "$0")/../.."

step() { printf '\n== %s\n' "$1"; }

step "App $APP"
if "$FLY" status --app "$APP" >/dev/null 2>&1; then
  echo "exists"
else
  "$FLY" apps create "$APP" ${FLY_ORG:+--org "$FLY_ORG"}
fi

step "Volume for the signing key and the messages"
if "$FLY" volumes list --app "$APP" 2>/dev/null | grep -q "$VOLUME"; then
  echo "exists"
else
  "$FLY" volumes create "$VOLUME" --app "$APP" --region "$REGION" --size 1 --yes
fi

step "Settings"
TOKENS=".env.fly.$APP"
if [ ! -f "$TOKENS" ]; then
  ( umask 077
    { echo "# API tokens of the ADTP node $APP (https://$HOST). Keep this file private."
      echo "ADTP_ADMIN_TOKEN=$(openssl rand -hex 24)"
      echo "ADTP_AGENT_TOKEN=$(openssl rand -hex 24)"
    } > "$TOKENS" )
  echo "generated the two API tokens into $TOKENS"
fi
ADMIN_TOKEN="$(sed -n 's/^ADTP_ADMIN_TOKEN=//p' "$TOKENS")"
AGENT_TOKEN="$(sed -n 's/^ADTP_AGENT_TOKEN=//p' "$TOKENS")"
[ -n "$ADMIN_TOKEN" ] && [ -n "$AGENT_TOKEN" ] || { echo "launch: $TOKENS does not hold both tokens; delete it to make new ones" >&2; exit 1; }

SETTINGS=(
  "ADTP_DOMAIN=$DOMAIN"
  "ADTP_PUBLIC_URL=https://$HOST"
  "ADTP_LOCAL=$LOCAL"
  "ADTP_TYPE=$TYPE"
  "ADTP_ADMIN_TOKEN=$ADMIN_TOKEN"
  "ADTP_AGENT_TOKEN=$AGENT_TOKEN"
)
if [ -n "$DESCRIPTION" ]; then
  SETTINGS+=("ADTP_LISTED=true" "ADTP_DESCRIPTION=$DESCRIPTION")
else
  SETTINGS+=("ADTP_LISTED=false")
fi
if [ -n "${ADTP_FIRST_CONTACT:-}" ]; then SETTINGS+=("ADTP_FIRST_CONTACT=$ADTP_FIRST_CONTACT"); fi
if [ -n "${ADTP_AUTO_REPLY:-}" ]; then SETTINGS+=("ADTP_AUTO_REPLY=$ADTP_AUTO_REPLY"); fi
# Staged: they take effect with the deploy below. Fly does not echo the values.
"$FLY" secrets set --app "$APP" --stage "${SETTINGS[@]}" >/dev/null
echo "$ADDRESS ($TYPE), served at https://$HOST, $([ -n "$DESCRIPTION" ] && echo listed || echo "not listed")"
if [ "${ADTP_FIRST_CONTACT:-}" = open ]; then echo "open to first contact: strangers' first messages are delivered without approval"; fi
if [ -n "${ADTP_AUTO_REPLY:-}" ]; then echo "answers every message automatically"; fi

step "Build and deploy (the first time takes a few minutes)"
"$FLY" deploy --app "$APP" --primary-region "$REGION" --ha=false

step "HTTPS certificate for $HOST"
"$FLY" certs add "$HOST" --app "$APP" || "$FLY" certs show "$HOST" --app "$APP"

cat <<EOF

== What is left for you: DNS

1. Point $HOST at Fly, with the record(s) Fly printed just above.
   (Shown again by: fly certs show $HOST --app $APP)

2. Tell other nodes where $DOMAIN's cards and directory are:

     Name   _adtp.$DOMAIN
     Type   TXT
     Value  v=adtp0; card=https://$HOST/.well-known/adtp/{local}; directory=https://$HOST/.well-known/adtp

Once DNS has propagated and Fly has issued the certificate:

     curl https://$HOST/healthz
     curl https://$HOST/.well-known/adtp/$LOCAL

Admin pages: https://$HOST/admin
Sign in with the value of ADTP_ADMIN_TOKEN in $TOKENS (on this machine).
EOF
