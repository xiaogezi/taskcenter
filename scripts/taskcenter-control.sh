#!/bin/bash

set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
NODE_COMMAND=""
for candidate in /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node; do
    if [[ -x "$candidate" ]]; then
        NODE_COMMAND="$candidate"
        break
    fi
done
if [[ -z "$NODE_COMMAND" ]]; then
    NODE_COMMAND="$(command -v node 2>/dev/null || true)"
fi
if [[ -z "$NODE_COMMAND" ]]; then
    echo "启动失败：没有找到 Node.js。"
    exit 1
fi
exec "$NODE_COMMAND" "$PROJECT_DIR/scripts/taskcenter-control.mjs" "${1:-status}"
