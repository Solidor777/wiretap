#!/usr/bin/env sh
# Wiretap sidecar - run to start the local terminal bridge. Ctrl-C to stop it.
cd "$(dirname "$0")" || exit 1
command -v node >/dev/null 2>&1 || { echo "Node.js is required but was not found on PATH."; exit 1; }
[ -d node_modules ] || { echo "Installing dependencies..."; npm install; }
echo "Starting Wiretap sidecar...  (Ctrl-C to stop)"
exec npm run server:start
