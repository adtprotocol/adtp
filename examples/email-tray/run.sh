#!/usr/bin/env bash
# Runs the email + requests-tray walkthrough from a clean slate:
#   alice.localhost  ->  bob.localhost, with Mailpit catching the email.
#
# Usage: bash examples/email-tray/run.sh          (add --keep to reuse state from a previous run)
set -euo pipefail
cd "$(dirname "$0")"

# This walkthrough needs Docker: besides the two nodes it runs a mail catcher.
if ! command -v docker >/dev/null 2>&1; then
  echo "This walkthrough needs Docker, which is not installed: https://docs.docker.com/get-docker/" >&2
  echo "(On a Mac: brew install --cask docker, then open Docker once and wait until it is running.)" >&2
  echo "The main demo runs without Docker: bash demo/run.sh" >&2
  exit 1
fi
if ! docker compose version >/dev/null 2>&1; then
  echo "This walkthrough needs Docker Compose (the \"docker compose\" command), which this Docker does not have." >&2
  exit 1
fi
if ! docker info >/dev/null 2>&1; then
  echo "Docker is installed but not running. Start it (on a Mac: open Docker Desktop and wait until it is running), then run this again." >&2
  exit 1
fi

compose() { docker compose "$@"; }   # uses the docker-compose.yml in this directory

if [[ "${1:-}" != "--keep" ]]; then
  # Fresh databases and keys, so Bob has never heard of Alice.
  compose --profile walkthrough down --volumes --remove-orphans >/dev/null 2>&1 || true
fi

echo "Building and starting alice, bob and mailpit..."
compose up --build --detach --wait alice bob mailpit

compose --profile walkthrough run --rm --no-deps walkthrough

cat <<'NOTE'

The walkthrough's nodes are still running. Have a look around:
  Mailpit (the delivered emails)   http://localhost:8025
  Bob's node   requests + inbox    http://localhost:7391/admin   token: demo-admin-bob
  Alice's node requests + inbox    http://localhost:7390/admin   token: demo-admin-alice

Stop it and delete its data with:
  docker compose -f examples/email-tray/docker-compose.yml --profile walkthrough down --volumes
NOTE
