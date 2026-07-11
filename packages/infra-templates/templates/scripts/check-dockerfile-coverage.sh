#!/usr/bin/env bash
# Verify Dockerfile final stage COPY instructions cover all relative imports
# from server-side TypeScript files that are bundled into the runtime image.
#
# Root cause this prevents (2026-04-18, #881 layer 2):
#   `server/routes/navigator.ts` imported from `../../shared/schemas/navigator`
#   (added in #872), but the Dockerfile final stage did not include
#   `COPY shared/ shared/`. Bun runtime crashed at Cloud Run startup with
#   `error: Cannot find module '../../shared/schemas/navigator'
#    from '/app/server/routes/navigator.ts'`, container exit(1), deploy failed.
#
# Algorithm:
#   1. Parse Dockerfile final stage (after the last FROM) COPY instructions
#      to build a set of destination directories in the runtime /app.
#   2. For every TS file that IS copied into the image (server-prod.ts,
#      cache.ts, server/**), extract relative import paths (`../...`, `./...`).
#   3. Resolve each import to an absolute project-root-relative path.
#   4. If the resolved path escapes the source file's top-level COPY tree,
#      check whether some COPY destination covers it. If not, flag.
#
# Called from both .husky/pre-push (local) and .github/workflows/ci.yml (CI)
# so `--no-verify` cannot bypass.
#
# Exit codes: 0 = coverage OK or python3 unavailable; 1 = gap detected.

if ! command -v python3 >/dev/null 2>&1; then
  echo "⚠️  python3 not found — skipping Dockerfile coverage check."
  exit 0
fi

PROJECT_ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
cd "$PROJECT_ROOT" || exit 1

python3 - <<'PY'
import re
import sys
from pathlib import Path

PROJECT_ROOT = Path.cwd()
DOCKERFILE = PROJECT_ROOT / "Dockerfile"

# Dockerfile-copied entrypoints. Their imports live inside the runtime image,
# so every transitive import must also be inside the image.
# {{SCAN_ROOTS}}: Dockerfile final stage に COPY されるサーバー側エントリポイント/ディレクトリ
SCAN_ROOTS = ["{{SERVER_ENTRYPOINT}}", "{{SERVER_DIR}}"]

# Matches ESM/CJS relative imports: `from "../x"`, `from './y'`, `import "./z"`
IMPORT_RE = re.compile(r"""(?x)
    (?:from|import)\s*
    \(?
    \s*
    ['"]
    (\.\.?/[^'"]+)
    ['"]
""")

def parse_final_stage_copies(dockerfile: Path):
    """Return set of destination paths (relative to /app) from final stage COPY."""
    lines = dockerfile.read_text().splitlines()
    from_indexes = [i for i, l in enumerate(lines) if re.match(r"^\s*FROM\s", l)]
    start = from_indexes[-1] if from_indexes else 0

    dests = set()
    for raw in lines[start:]:
        line = raw.strip()
        # Skip comments / empty
        if not line or line.startswith("#"):
            continue
        # `COPY [--from=X] [--chown=Y] <src> <dst>`
        m = re.match(r"^COPY\s+((?:--\S+\s+)*)([^\s]+)\s+([^\s]+)\s*$", line)
        if not m:
            continue
        src, dst = m.group(2), m.group(3)
        # Normalize dst → what path is created in /app
        if dst == ".":
            # `COPY server-prod.ts .` → /app/server-prod.ts
            # `COPY server/ .` → /app/<contents> but that form is unusual; treat as root
            basename = src.rstrip("/").split("/")[-1]
            if "/" in src.rstrip("/"):
                # absolute from builder like "/app/dist/" → basename "dist"
                dests.add(basename)
            else:
                dests.add(basename)
        else:
            dests.add(dst.rstrip("/").lstrip("./"))
    return dests

def collect_ts_files():
    """Files whose imports we must check — they end up in the runtime image."""
    out = []
    for root in SCAN_ROOTS:
        p = PROJECT_ROOT / root
        if p.is_file() and p.suffix in (".ts", ".tsx"):
            out.append(p)
        elif p.is_dir():
            for sub in p.rglob("*.ts"):
                s = str(sub)
                if ".test." in sub.name or "/node_modules/" in s:
                    continue
                out.append(sub)
    return out

def resolve_import(source: Path, imp: str):
    """Resolve relative import to a project-root-relative path (file or directory)."""
    resolved = (source.parent / imp).resolve()
    try:
        rel = resolved.relative_to(PROJECT_ROOT)
    except ValueError:
        return None
    return rel

def is_covered(rel: Path, dests: set):
    """True if rel (or any extension variant) is under a COPY destination."""
    # Try both the path itself and common extension forms
    candidates = [rel]
    for ext in (".ts", ".tsx", ".js", ".json"):
        candidates.append(Path(str(rel) + ext))
    for idx in ("index.ts", "index.tsx"):
        candidates.append(rel / idx)

    for cand in candidates:
        parts = cand.parts
        for i in range(1, len(parts) + 1):
            prefix = "/".join(parts[:i])
            if prefix in dests:
                return True
    return False

def source_top(rel: Path) -> str:
    parts = rel.parts
    return parts[0] if parts else ""

def resolve_to_file(source: Path, imp: str) -> Path | None:
    """Return the actual on-disk TS file that this import resolves to, or None."""
    base = (source.parent / imp).resolve()
    candidates = [base]
    for ext in (".ts", ".tsx", ".js", ".json"):
        candidates.append(Path(str(base) + ext))
    for idx in ("index.ts", "index.tsx"):
        candidates.append(base / idx)
    for cand in candidates:
        if cand.is_file():
            return cand
    return None

TYPE_ONLY_EXPORT_RE = re.compile(
    r"^\s*export\s+(?:default\s+)?(?:interface|type|enum)\s+",
    re.MULTILINE,
)
VALUE_EXPORT_RE = re.compile(
    r"^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+",
    re.MULTILINE,
)
EXPORT_STAR_RE = re.compile(r"^\s*export\s*\*\s+from", re.MULTILINE)

def is_type_only_target(target_file: Path | None) -> bool:
    """A file is 'type-only' if it has type/interface exports but NO value exports."""
    if target_file is None or not target_file.is_file():
        return False
    text = target_file.read_text(errors="ignore")
    if VALUE_EXPORT_RE.search(text) or EXPORT_STAR_RE.search(text):
        return False
    return bool(TYPE_ONLY_EXPORT_RE.search(text))

def main():
    if not DOCKERFILE.exists():
        print("❌ Dockerfile not found.", file=sys.stderr)
        return 1

    covered = parse_final_stage_copies(DOCKERFILE)
    files = collect_ts_files()

    gaps = []  # (source_rel, import_str, resolved_rel)
    scanned = 0

    for f in files:
        source_rel = f.relative_to(PROJECT_ROOT)
        src_top = source_top(source_rel)
        try:
            text = f.read_text(errors="ignore")
        except Exception:
            continue
        for m in IMPORT_RE.finditer(text):
            scanned += 1
            imp = m.group(1)
            resolved = resolve_import(f, imp)
            if resolved is None:
                continue  # escaped project root (package?)
            # Only flag imports that leave the source's own COPY tree.
            # Same-top imports are always covered if the source itself was copied.
            if source_top(resolved) == src_top:
                continue
            if is_covered(resolved, covered):
                continue
            # `import type { ... }` and imports from pure-type files are stripped
            # at runtime by Bun's TS handling — safe to skip even if the target
            # isn't COPY'd.
            if "import type" in m.group(0) or m.group(0).strip().startswith("import type"):
                continue
            target = resolve_to_file(f, imp)
            if is_type_only_target(target):
                continue
            gaps.append((source_rel, imp, resolved))

    if gaps:
        print("❌ Dockerfile COPY coverage gap detected.")
        print()
        print("   以下の server-side import が Dockerfile final stage の COPY で")
        print("   カバーされていないディレクトリを参照しています。")
        print("   Cloud Run container startup で `Cannot find module` crash します。")
        print()
        # Deduplicate by (top-level-dir-needed)
        uniq = {}
        for src, imp, res in gaps:
            key = res.parts[0] if res.parts else str(res)
            uniq.setdefault(key, []).append((src, imp, res))
        for top, items in sorted(uniq.items()):
            print(f"  Missing: COPY for '{top}/' (or sub-path)")
            for src, imp, res in items[:3]:
                print(f"    example: {src}  imports  '{imp}'")
                print(f"             resolves to  {res}")
            if len(items) > 3:
                print(f"    ... {len(items) - 3} more")
            print()
        print(f"   Dockerfile final stage に COPY 追加してください。")
        print(f"   (Covered dests の現状: {', '.join(sorted(covered))})")
        return 1

    print(f"✅ Dockerfile COPY coverage OK ({scanned} imports, {len(files)} files scanned).")
    print(f"   Covered: {', '.join(sorted(covered))}")
    return 0

sys.exit(main())
PY
