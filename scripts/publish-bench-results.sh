#!/bin/sh
set -eu
src="${1:-bench/results}"
dest="${2:-client/public/bench}"
mkdir -p "$dest"
for f in "$src"/*.json; do
  [ -f "$f" ] || continue
  base=$(basename "$f")
  case "$base" in
    index.json) continue ;;
  esac
  cp "$f" "$dest/$base"
done
ls -1 "$dest" | jq -R . | jq -s . >"$dest/index.json"
