#!/bin/sh
set -eu

: "${HOME:=/root}"
export HOME
: "${MAW_HOME:=$HOME/.maw}"
: "${NODE_NAME:=$(hostname)}"

mkdir -p "$MAW_HOME"

export MAW_HOST=0.0.0.0
export TMUX_TMPDIR=/tmp/tmux-host

echo "[${NODE_NAME}] tmux socket: $(ls /tmp/tmux-host/default 2>/dev/null && echo 'OK' || echo 'NOT FOUND')"
echo "[${NODE_NAME}] tmux sessions: $(tmux -S /tmp/tmux-host/default list-sessions 2>/dev/null || echo 'none')"
echo "[${NODE_NAME}] maw serve starting..."
exec "$@"
