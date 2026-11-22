#!/usr/bin/env bash
# Split screen for recording the demo: the Stratus side on the left, Side B's
# agent log on the right. Needs tmux. Any flags are passed on to run.sh.
#
#   bash demo/split.sh                    local mode
#   bash demo/split.sh --tamper
#   SIDE_B_LOG='ssh side-b "cd adtp/demo/side-b && docker compose logs -f --tail 0 --no-log-prefix agent"' \
#     bash demo/split.sh --public         public run: show the remote agent's log on the right
set -euo pipefail
cd "$(dirname "$0")"
command -v tmux >/dev/null || { echo "split.sh needs tmux (brew install tmux / apt install tmux)" >&2; exit 1; }

session=adtp-demo
side_b_log=${SIDE_B_LOG:-docker compose logs --follow --tail 0 --no-log-prefix echo-agent}
flags="$*"

if [[ " $flags " != *" --public "* ]]; then
  # Start the nodes first so the recording shows only the exchange.
  docker compose up --detach --wait stratus-node echo-node echo-agent >/dev/null
fi

tmux kill-session -t "$session" 2>/dev/null || true
tmux new-session -d -s "$session" -x "${COLUMNS:-200}" -y "${LINES:-50}" "$side_b_log"
tmux set-option -t "$session" pane-border-status top >/dev/null
tmux select-pane -t "$session" -T "Side B: echo agent log"
tmux split-window -h -b -t "$session" "sleep 1; bash run.sh $flags; printf '\n(press q to close) '; while read -rsn1 k; do [[ \$k == q ]] && break; done; tmux kill-session -t $session"
tmux select-pane -t "$session" -T "Side A: Stratus agent"

if [[ -t 1 ]]; then
  exec tmux attach -t "$session"
else
  echo "started tmux session '$session': attach with: tmux attach -t $session"
fi
