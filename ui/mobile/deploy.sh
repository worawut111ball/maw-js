#!/usr/bin/env bash
# Copy the phone UI into maw's served folder. Run after editing ui/mobile/*. (Server code needs a maw restart.)
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"; dist="${MAW_UI_DIR:-$HOME/.maw/ui/dist}"
cp "$here/m.html" "$dist/m.html"
cp "$here"/pwa/{manifest.json,sw.js,icon-192.png,icon-512.png,apple-touch-icon.png} "$dist/"
mkdir -p "$dist/m-ext" && cp "$here"/ext/*.js "$dist/m-ext/"
echo "deployed → $dist"
