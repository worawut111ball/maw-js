#!/bin/bash
# maw-service — manage maw serve like brew services
# Usage: maw-service [start|stop|restart|status|logs]

PLIST="$HOME/Library/LaunchAgents/homebrew.maw.plist"
LABEL="homebrew.maw"
LOG="$HOME/.maw/serve.log"
ERRLOG="$HOME/.maw/serve.error.log"

case "${1:-status}" in
  start)
    launchctl load "$PLIST" 2>/dev/null
    sleep 1
    if launchctl list | grep -q "$LABEL"; then
      echo "✅ maw serve started — http://localhost:3456"
    else
      echo "❌ failed to start"
    fi
    ;;
  stop)
    launchctl unload "$PLIST" 2>/dev/null
    echo "⏹  maw serve stopped"
    ;;
  restart)
    launchctl unload "$PLIST" 2>/dev/null
    sleep 1
    launchctl load "$PLIST" 2>/dev/null
    sleep 1
    echo "🔄 maw serve restarted — http://localhost:3456"
    ;;
  status)
    if launchctl list | grep -q "$LABEL"; then
      PID=$(launchctl list | grep "$LABEL" | awk '{print $1}')
      echo "✅ maw serve running (PID $PID) — http://localhost:3456"
    else
      echo "⏹  maw serve not running"
    fi
    ;;
  logs)
    tail -f "$LOG"
    ;;
  errors)
    tail -f "$ERRLOG"
    ;;
  *)
    echo "Usage: maw-service [start|stop|restart|status|logs|errors]"
    ;;
esac
