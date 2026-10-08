#!/usr/bin/env bash
# Writes the CLI's JSON report for every log (and a comparison for each pair) into <out-dir>, with
# the provenance block removed (its build id hashes the core sources, so it changes with any edit).
# Run before and after a performance change, then `diff -r before after`: the analysis output must
# be byte-identical.
# The CLI exits non-zero for a failed run or a violated budget; its JSON is still captured, and an
# empty output (a crash) fails the strip step.
# Usage: dev/snapshot-cli-output.sh <out-dir> <log>... [-- <baseline>:<candidate>...]
set -euo pipefail
out=$1; shift; mkdir -p "$out"
cli="$(dirname "$0")/../packages/cli/bin/sparkforensics-analyze.mjs"
logs=(); pairs=(); inpairs=0
for a in "$@"; do if [ "$a" = -- ]; then inpairs=1; elif [ $inpairs = 1 ]; then pairs+=("$a"); else logs+=("$a"); fi; done
strip() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const w=(o)=>{if(o&&typeof o==="object"){delete o.generator;Object.values(o).forEach(w)}};w(j);process.stdout.write(JSON.stringify(j,null,1))})'; }
for f in "${logs[@]}"; do { node --max-old-space-size=8192 "$cli" "$f" 2>/dev/null || true; } | strip > "$out/$(basename "$f").json"; done
for p in "${pairs[@]}"; do b=${p%%:*}; c=${p##*:}; { node --max-old-space-size=8192 "$cli" "$c" --baseline "$b" 2>/dev/null || true; } | strip > "$out/cmp-$(basename "$c").json"; done
(cd "$out" && sha256sum *.json > SHA256SUMS)
