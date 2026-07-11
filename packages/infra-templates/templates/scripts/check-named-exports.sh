#!/usr/bin/env bash
# Validate {{SERVER_ENTRYPOINT}} import graph by briefly running it with stubbed env.
#
# Catches "phantom named exports" that `scripts/check-phantom-imports.sh` misses:
# the target file exists but does not export the named symbol the import asks for.
#
# Example caught bug (2026-04-18, #881):
#   `import { getUserId } from "../lib/auth"` — auth.ts exists, but getUserId
#   was moved to lib/user-context.ts. Phantom-import detection passes (file
#   present), yet Bun runtime crashes with
#   `SyntaxError: Export named 'getUserId' not found in module auth.ts`.
#
# Strategy: run `bun {{SERVER_ENTRYPOINT}}` with stubbed env for ≤3 seconds. Three
# outcomes:
#   (a) Listens on port → all imports resolved, startup reached Bun.serve (PASS)
#   (b) Crashes at config_missing / Supabase connect → imports OK, env failed (PASS)
#   (c) Crashes with SyntaxError / Cannot find module → import error (FAIL)
#
# Called from both .husky/pre-push (local) and .github/workflows/ci.yml (remote)
# so `--no-verify` doesn't bypass the check.
#
# Exit codes: 0 = imports resolved; 1 = named-export or missing-module error.

set -e

LOG=$(mktemp "${TMPDIR:-/tmp}/bun-import-check.XXXXXX")
trap 'rm -f "$LOG"' EXIT

# Stub env vars satisfy the server's startup validation but are obviously fake.
# Add one VAR=stub line per required env var ({{STUB_ENV_*}}). No real credentials.
# PORT different from 8080 to avoid clashing with running local dev.
PORT=18880 \
APP_URL=http://localhost \
NODE_ENV=test \
{{STUB_ENV_1}} \
{{STUB_ENV_2}} \
  bun {{SERVER_ENTRYPOINT}} > "$LOG" 2>&1 &
PID=$!

# Give Bun at most 4 seconds to reach either (a) port listen or (b) env check.
# Real import errors surface in <500ms.
for _ in 1 2 3 4 5 6 7 8; do
  sleep 0.5
  if ! kill -0 "$PID" 2>/dev/null; then
    break
  fi
  if grep -q "{{READY_LOG_PATTERN}}" "$LOG" 2>/dev/null; then
    break
  fi
done

# Stop the server (may already be dead if it crashed).
kill "$PID" 2>/dev/null || true
wait "$PID" 2>/dev/null || true

# Only treat import-graph errors as failures. Env-validation failures are expected.
if grep -qE "(SyntaxError:.*Export named|error: Cannot find module|error: Could not resolve|Export named .* not found in module)" "$LOG"; then
  echo "❌ Import resolution error detected:"
  grep -E "(SyntaxError|Cannot find module|Could not resolve|Export named .* not found)" "$LOG" | head -10
  echo ""
  echo "--- full startup log tail ---"
  tail -30 "$LOG"
  exit 1
fi

echo "✅ Named export validation passed ({{SERVER_ENTRYPOINT}} imports resolved)."
