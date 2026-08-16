#!/bin/bash
# Build dsh-subagent-rules: verify lib/ is present and pack the release tgz.
# The plugin is hand-written zero-dependency ESM — no tsc step needed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if [ ! -f lib/index.js ]; then
  echo "build: lib/index.js missing" >&2
  exit 1
fi

if [ ! -f lib/client.js ]; then
  echo "build: lib/client.js missing" >&2
  exit 1
fi

node --check lib/index.js
node --check lib/client.js
echo "=== Build complete (lib verified, ${PWD}) ==="
