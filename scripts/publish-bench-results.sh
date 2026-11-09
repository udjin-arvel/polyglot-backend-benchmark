#!/bin/sh
set -eu
src="${1:-bench/results}"
dest="${2:-client/public/bench}"
mkdir -p "$dest"
list=$(mktemp)
trap 'rm -f "$list"' EXIT
for f in "$src"/*.json; do
  [ -f "$f" ] || continue
  base=$(basename "$f")
  case "$base" in
    index.json) continue ;;
  esac
  cp "$f" "$dest/$base"
  printf '%s\n' "$base" >>"$list"
done
sort "$list" | jq -R . | jq -s . >"$dest/index.json"
