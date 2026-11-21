#!/bin/bash
# Real-model harness benchmark: the same four tasks through the harness before tonight's changes (8783a2c) and
# through main, with Claude Sonnet 5.5. Asks for an Anthropic API key with hidden typing (never printed or saved).
# Spend: about $1-2 per run; each run stops after HARNESS_BENCH_MAX_REQUESTS requests (default 60).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${HARNESS_BENCH_DIR:-$REPO/.bench}"
NODE="${NODE:-$(command -v node || true)}"
[ -n "$NODE" ] || NODE_ELECTRON="$REPO/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
run_node() { if [ -n "$NODE" ]; then "$NODE" "$@"; else ELECTRON_RUN_AS_NODE=1 "$NODE_ELECTRON" "$@"; fi; }
read -r -s -p "Anthropic API key (typing is hidden): " ANTHROPIC_API_KEY; echo
export ANTHROPIC_API_KEY HARNESS_BENCH=1 HARNESS_BENCH_REAL=1
mkdir -p "$OUT"
OLD="$OUT/old-harness"
[ -d "$OLD" ] || { git -C "$REPO" worktree add -q --detach "$OLD" 8783a2c; ln -s "$REPO/node_modules" "$OLD/node_modules"; }
cp "$REPO/tests/unit/harness-bench.test.ts" "$OLD/tests/unit/"
echo "Running the old harness…"
(cd "$OLD" && HARNESS_BENCH_OUT="$OUT/real-old.json" run_node node_modules/vitest/vitest.mjs run tests/unit/harness-bench.test.ts >/dev/null 2>&1 || true)
echo "Running the new harness…"
(cd "$REPO" && HARNESS_BENCH_OUT="$OUT/real-new.json" run_node node_modules/vitest/vitest.mjs run tests/unit/harness-bench.test.ts >/dev/null 2>&1 || true)
unset ANTHROPIC_API_KEY
for f in real-old real-new; do [ -f "$OUT/$f.json" ] && python3 -c "import json;d=json.load(open('$OUT/$f.json'));print('$f', 'index', d['index'], 'autonomy', str(d['autonomy'])+'%', 'step-ins', d['stepIns'], 'steps', d['steps'], 'est \$', d.get('estUsd'))"; done
echo "Done. Results: $OUT/real-old.json and $OUT/real-new.json"
