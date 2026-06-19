#!/usr/bin/env bash
# Summon installer (macOS/Linux/Git-Bash) — build the agent + harness and put `summon` on your PATH.
# Idempotent. On Windows PowerShell, run install.ps1 instead.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

command -v node >/dev/null 2>&1 || { echo "ERROR: node not found. Summon needs Node >= 22." >&2; exit 1; }
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 22 ]; then
  echo "ERROR: Node >= 22 required (found $(node --version))." >&2; exit 1
fi

echo "Summon — installing"
echo "  1/3  npm install"
npm install
echo "  2/3  build (tui · ai · agent · coding-agent)"
npm run build
echo "  3/3  link the 'summon' command"
( cd packages/coding-agent && npm link )

# Post-link sanity check so a broken PATH/shim fails loudly instead of silently.
if command -v summon >/dev/null 2>&1; then
  echo "  ok   summon $(summon --version 2>&1 | head -n1) is on your PATH"
else
  echo "  WARN 'summon' is not on your PATH yet. Ensure your npm global bin dir is on PATH:" >&2
  echo "       npm bin -g   →   add that directory to PATH, then reopen your shell." >&2
fi

cat <<'EOF'

Done. Summon is installed.
  summon            # start, then run /login once to connect your Claude subscription (OAuth)

The harness is built in: spawn_agent / spawn_agents / run_team / run_blueprint.
Config lives in ~/.summon/. Switch themes with `summon themes <name>` (default: summon).
EOF
