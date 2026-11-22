#!/usr/bin/env bash
# The ADTP v0 demo: one signed message from the Stratus agent to the echo agent
# on another domain, with discovery, verification, an ack, status updates and
# a reply. Prints a timestamped transcript and writes demo/transcript.{md,json},
# with signatures and tokens shortened so that the files are safe to share.
#
#   bash demo/run.sh             local two-node mode (builds and starts everything it needs)
#   bash demo/run.sh --tamper    flip one byte in transit; Side B must reject it
#   bash demo/run.sh --watch     transcribe a message sent by the real Stratus agent instead of sending one
#   bash demo/run.sh --public    run against the real Side A node started from demo/side-a
#   bash demo/run.sh --raw       also keep the full transcript, tokens and all, in demo/raw (ignored by git)
#   bash demo/run.sh --build     local mode: rebuild the image first (after changing the code)
#   bash demo/run.sh --reset     local mode: wipe both nodes' data first
#   bash demo/run.sh --down      local mode: stop everything and delete its data
#   bash demo/run.sh --no-docker local mode without containers: the same two nodes as processes on this machine
#
# It runs in Docker when Docker is there. Without Docker it runs the same demo
# with Node.js (22.20 or newer), and says so.
set -euo pipefail
cd "$(dirname "$0")"

# Note: arrays are expanded as ${a[@]+"${a[@]}"} so that empty ones work under `set -u` on macOS's bash 3.2.
public=0; reset=0; down=0; no_docker=0; rebuild=0; build=(); args=()
for arg in "$@"; do
  case "$arg" in
    --public) public=1 ;;
    --reset)  reset=1 ;;
    --down)   down=1 ;;
    --build)  build=(--build); rebuild=1 ;;
    --no-docker) no_docker=1 ;;
    --tamper|--watch|--raw) args+=("$arg") ;;
    -h|--help) sed -n '2,18p' "$(basename "$0")" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown option: $arg (try --help)" >&2; exit 2 ;;
  esac
done

# ---- What can run the demo on this machine -------------------------------------------

# Prints ok, missing (no docker command), no-compose (docker without Compose v2) or stopped (Docker is not running).
docker_state() {
  command -v docker >/dev/null 2>&1 || { echo missing; return; }
  docker compose version >/dev/null 2>&1 || { echo no-compose; return; }
  docker info >/dev/null 2>&1 || { echo stopped; return; }
  echo ok
}

# Node.js 22.20 or newer: the first release that runs this code as it is.
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node -e 'const [major, minor] = process.versions.node.split(".").map(Number); process.exit(major > 22 || (major === 22 && minor >= 20) ? 0 : 1)'
}

docker_hint='  Docker    https://docs.docker.com/get-docker/
            On a Mac: brew install --cask docker, then open Docker once and wait until it is running.'
node_hint='  Node.js   https://nodejs.org/ (version 22.20 or newer)
            On a Mac: brew install node@22'
start_docker='Start it (on a Mac: open Docker Desktop and wait until it is running), then run this again.'

# The same demo as ordinary processes on this machine: no containers, nothing left behind.
run_without_docker() {
  cd ..
  if [[ ! -d node_modules ]]; then
    echo "Installing dependencies (first run only)..." >&2
    npm ci --no-audit --no-fund >/dev/null
  fi
  if [[ ! -f dist/demo/local.js || $rebuild -eq 1 ]]; then
    echo "Building..." >&2
    npm run build >/dev/null
  fi
  exec node dist/demo/local.js ${args[@]+"${args[@]}"}
}

state=$(docker_state)
if [[ $no_docker -eq 1 || $state != ok ]]; then
  case "$state" in
    missing)    why="Docker is not installed" ;;
    no-compose) why="This Docker has no Compose (the \"docker compose\" command)" ;;
    stopped)    why="Docker is installed but not running" ;;
    *)          why="" ;;
  esac
  if [[ $public -eq 1 ]]; then
    # --public talks to the node started with Docker from demo/side-a: there is no other way to run it.
    if [[ $state == ok ]]; then
      echo "--public cannot be combined with --no-docker: it runs against the node started with Docker from demo/side-a." >&2
    elif [[ $state == stopped ]]; then
      echo "$why, and --public needs it. $start_docker" >&2
    else
      printf '%s, and --public needs it.\n\n%s\n' "$why" "$docker_hint" >&2
    fi
    exit 1
  fi
  if [[ $down -eq 1 ]]; then
    echo "Nothing to stop: without Docker the demo removes its own data when it ends." >&2
    exit 0
  fi
  if ! node_ok; then
    have_node=""
    command -v node >/dev/null 2>&1 && have_node="The Node.js here ($(node --version)) is older than 22.20, so it cannot run the demo either."
    if [[ $state == ok ]]; then
      printf '%s\n\n%s\n' "--no-docker needs Node.js 22.20 or newer. ${have_node:-There is no Node.js on this machine.}" "$node_hint" >&2
    elif [[ $state == stopped ]]; then
      echo "$why. $start_docker" >&2
      [[ -n $have_node ]] && echo "$have_node" >&2
    else
      echo "The demo needs Docker, or Node.js 22.20 or newer. $why. ${have_node:-There is no Node.js on this machine either.}" >&2
      printf '\n%s\n%s\n\nEither one is enough. Install it and run this again.\n' "$docker_hint" "$node_hint" >&2
    fi
    exit 1
  fi
  if [[ -n $why && $no_docker -eq 0 ]]; then
    echo "$why, so the demo runs with Node.js instead: the same two nodes, as processes on this machine." >&2
    [[ $state == stopped ]] && echo "(To use containers, start Docker and run this again.)" >&2
    echo >&2
  fi
  run_without_docker
fi

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

# Ctrl-C stops the script. Without this, an interrupted step would look like a failed one and be tried again.
trap 'echo >&2; echo "Stopped." >&2; exit 130' INT

# The image is built the first time (and with --build). That takes minutes, and silence
# for that long looks like a hang, so say what is happening and show the build's progress.
if [[ $rebuild -eq 1 ]] || ! docker image inspect adtp-node:demo >/dev/null 2>&1; then
  echo "Building the demo image. The first time takes a few minutes, longer on a slow connection. Progress follows." >&2
  docker compose build stratus-node
  build=()
  echo >&2
fi

# Bring both sides up (a no-op if they already are), then run the exchange.
docker compose up ${build[@]+"${build[@]}"} --detach --wait --quiet-pull stratus-node echo-node echo-agent >/dev/null 2>&1 || {
  echo "Starting the demo nodes failed. Showing the output:" >&2
  docker compose up ${build[@]+"${build[@]}"} --detach --wait stratus-node echo-node echo-agent
}
exec docker compose --progress quiet --profile run run --rm --no-deps "${run_as[@]}" runner node dist/demo/run.js ${args[@]+"${args[@]}"}
