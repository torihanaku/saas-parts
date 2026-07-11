#!/usr/bin/env bash
# Detect added imports whose target files don't exist on disk.
# Prevents CI breakage from rebase/merge artifacts (#832: `server/routes/ai-visibility.ts`
# imported but not created → Cloud Run start failure).
#
# Called from both .husky/pre-push (local) and .github/workflows/ci.yml (remote)
# so `--no-verify` doesn't bypass the check.
#
# Usage: bash scripts/check-phantom-imports.sh [MERGE_BASE] [HEAD_REF]
#   MERGE_BASE: base ref to diff against (default: origin/main, falls back to HEAD~1)
#   HEAD_REF:   head ref to diff from (default: HEAD)
# Exit codes: 0 = clean or python3 unavailable; 1 = phantom imports detected.

MERGE_BASE="${1:-}"
HEAD_REF="${2:-HEAD}"

if [ -z "$MERGE_BASE" ]; then
  MERGE_BASE=$(git merge-base HEAD origin/main 2>/dev/null || git rev-parse HEAD~1 2>/dev/null || git rev-parse HEAD)
fi

if ! command -v python3 >/dev/null 2>&1; then
  echo "⚠️  python3 not found — skipping phantom import check."
  exit 0
fi

MISSING=$(git diff "$MERGE_BASE" "$HEAD_REF" --name-only -- '*.ts' '*.tsx' 2>/dev/null | while read -r file; do
  [ -f "$file" ] || continue
  # '^\+import ' excludes '+++' hunk headers (no trailing space) and '@@' range markers.
  git diff "$MERGE_BASE" "$HEAD_REF" -- "$file" 2>/dev/null \
    | grep -E '^\+import ' \
    | grep -E "from [\"'][./]" \
    | sed -E "s/.*from [\"']([^\"']+)[\"'].*/\1/" \
    | while read -r imp; do
        # Only relative imports (leading "."). POSIX-safe prefix check.
        [ "${imp#.}" != "$imp" ] || continue
        dir=$(dirname "$file")
        # os.path.normpath collapses ".." portably.
        candidate=$(python3 -c "import os, sys; print(os.path.normpath(os.path.join(sys.argv[1], sys.argv[2])))" "$dir" "$imp")
        found=""
        if [ -f "$candidate" ]; then
          found=1
        else
          for ext in ts tsx js json; do
            [ -f "${candidate}.${ext}" ] && found=1 && break
          done
        fi
        # TypeScript ESM convention: .js imports resolve to .ts files
        if [ -z "$found" ] && [ "${candidate%.js}" != "$candidate" ]; then
          base="${candidate%.js}"
          [ -f "${base}.ts" ] && found=1
          [ -z "$found" ] && [ -f "${base}.tsx" ] && found=1
        fi
        [ -z "$found" ] && [ -f "${candidate}/index.ts" ] && found=1
        [ -z "$found" ] && [ -f "${candidate}/index.tsx" ] && found=1
        if [ -z "$found" ]; then
          echo "  $file → $imp"
        fi
      done
done || true)

if [ -n "$MISSING" ]; then
  echo "❌ Phantom import(s) detected (referenced file not found):"
  echo "$MISSING"
  echo "   Fix the import path or create the target file before pushing."
  exit 1
fi

echo "✅ Phantom import check passed."
