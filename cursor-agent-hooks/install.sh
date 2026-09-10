#!/usr/bin/env bash
# Install Cursor Agent Observability hooks into ~/.cursor/hooks.json (file-based; CLI-reliable).
set -euo pipefail

KIT="$(cd "$(dirname "$0")" && pwd)"
TARGET="${DBDOG_CURSOR_HOOKS_TARGET:-$HOME/.cursor/hooks.json}"
PLACEHOLDER='/ABSOLUTE/PATH/TO/dbdog-labs/cursor-agent-hooks'

if ! command -v node >/dev/null 2>&1; then
  echo "node >= 18 required" >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "jq required for merge install" >&2
  exit 1
fi

mkdir -p "$(dirname "$TARGET")"
if [[ ! -f "$TARGET" ]]; then
  echo '{"version":1,"hooks":{}}' >"$TARGET"
fi

cp "$TARGET" "$TARGET.bak.$(date +%Y%m%d%H%M%S)"

RENDERED="$(mktemp)"
sed "s|$PLACEHOLDER|$KIT|g" "$KIT/hooks.json" >"$RENDERED"

# Merge: rendered hook events overlay existing keys (same event name replaced as a whole list).
jq --slurpfile snip "$RENDERED" '
  .version = (.version // 1)
  | .hooks = ((.hooks // {}) + $snip[0].hooks)
' "$TARGET" >"$TARGET.new"
mv "$TARGET.new" "$TARGET"
rm -f "$RENDERED"

echo "Installed dbdog cursor-agent-hooks → $TARGET"
echo "Kit: $KIT"
echo "Events: $(jq -r '.hooks | keys | join(", ")' "$TARGET")"
echo
echo "Next:"
echo "  1) Set env (e.g. in shell profile or wrap agent):"
echo "       export DBDOG_OBS_REPORT_URL='http://<mcp>/api/v2/llmobs/spans'"
echo "       export DBDOG_OBS_API_KEY='dbdog_xxx'"
echo "  2) Start a new Cursor CLI agent session"
echo "  3) Ask: 诊断: …"
