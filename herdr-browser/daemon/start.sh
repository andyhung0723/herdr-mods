#!/usr/bin/env bash
# Start Herdr Agent Browser Daemon
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec node "$DIR/server.mjs"
