#!/usr/bin/env bash
# The ADTP v0 demo: one signed message from the Stratus agent to the echo agent
# on another domain, with discovery, verification, an ack, status updates and
# a reply. Prints a timestamped transcript and writes demo/transcript.{md,json}.
#
#   bash demo/run.sh             local two-node mode (builds and starts everything it needs)
#   bash demo/run.sh --tamper    flip one byte in transit; Side B must reject it
#   bash demo/run.sh --watch     transcribe a message sent by the real Stratus agent instead of sending one
#   bash demo/run.sh --public    run against the real Side A node started from demo/side-a
#   bash demo/run.sh --build     local mode: rebuild the image first (after changing the code)
#   bash demo/run.sh --reset     local mode: wipe both nodes' data first
#   bash demo/run.sh --down      local mode: stop everything and delete its data
set -euo pipefail
cd "$(dirname "$0")"

# Note: arrays are expanded as ${a[@]+"${a[@]}"} so that empty ones work under `set -u` on macOS's bash 3.2.
public=0; reset=0; down=0; build=(); args=()
for arg in "$@"; do
  case "$arg" in
    --public) public=1 ;;
    --reset)  reset=1 ;;
    --down)   down=1 ;;
    --build)  build=(--build) ;;
    --tamper|--watch) args+=("$arg") ;;
    -h|--help) sed -n '2,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

# Transcripts are written by a container into this directory; run it as the
# calling user so the files are yours.
run_as=(--user "$(id -u):$(id -g)")

if [[ $public -eq 1 ]]; then
  cd side-a
  [[ -f .env ]] || { echo "demo/side-a/.env is missing: copy .env.example and fill it in" >&2; exit 1; }
  exec docker compose --progress quiet --profile run run --rm --no-deps "${run_as[@]}" runner node dist/demo/run.js ${args[@]+"${args[@]}"}
fi

if [[ $down -eq 1 ]]; then
  exec docker compose --profile run down --volumes --remove-orphans
fi
if [[ $reset -eq 1 ]]; then
  docker compose --profile run down --volumes --remove-orphans >/dev/null 2>&1 || true
fi

# Bring both sides up (a no-op if they already are; the image is built the first time), then run the exchange.
docker compose up ${build[@]+"${build[@]}"} --detach --wait --quiet-pull stratus-node echo-node echo-agent >/dev/null 2>&1 || {
  echo "Starting the demo nodes failed. Showing the output:" >&2
  docker compose up ${build[@]+"${build[@]}"} --detach --wait stratus-node echo-node echo-agent
}
exec docker compose --progress quiet --profile run run --rm --no-deps "${run_as[@]}" runner node dist/demo/run.js ${args[@]+"${args[@]}"}
