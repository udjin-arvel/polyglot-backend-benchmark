#!/bin/sh
set -eu

GO_URL="${SMOKE_GO:-http://127.0.0.1:8081}"
NODE_URL="${SMOKE_NODE:-http://127.0.0.1:8082}"
PHP_URL="${SMOKE_PHP:-http://127.0.0.1:8083}"
PYTHON_URL="${SMOKE_PY:-http://127.0.0.1:8084}"

fail() {
  echo "SMOKE FAIL: $*" >&2
  exit 1
}

req() {
  method="$1"
  url="$2"
  body="${3:-}"
  if [ -n "$body" ]; then
    curl -sS -X "$method" -H "Content-Type: application/json" -d "$body" -w "\n%{http_code}" "$url"
  else
    curl -sS -X "$method" -w "\n%{http_code}" "$url"
  fi
}

parse_resp() {
  resp="$1"
  out_body="$2"
  out_code="$3"
  printf '%s' "$resp" | sed '$d' >"$out_body"
  printf '%s' "$resp" | tail -n 1 >"$out_code"
}

assert_code() {
  got="$1"
  want="$2"
  ctx="$3"
  [ "$got" = "$want" ] || fail "$ctx: expected HTTP $want, got $got"
}

compare_json() {
  a="$1"
  b="$2"
  ctx="$3"
  jq -S . <"$a" >/tmp/smoke_a.json
  jq -S . <"$b" >/tmp/smoke_b.json
  diff -u /tmp/smoke_a.json /tmp/smoke_b.json >/dev/null 2>&1 || fail "$ctx: JSON mismatch"
}

run_backend() {
  name="$1"
  base="$2"
  dir="/tmp/smoke_${name}"
  mkdir -p "$dir"
  echo "== $name ($base)"

  tmpb="/tmp/smoke_req_body"
  tmpc="/tmp/smoke_req_code"

  parse_resp "$(req GET "$base/health")" "$tmpb" "$tmpc"
  assert_code "$(cat "$tmpc")" "200" "$name health"
  jq -e '.status == "ok"' <"$tmpb" >/dev/null

  parse_resp "$(req GET "$base/items?limit=2&offset=0&sort=-created_at")" "$dir/list.json" "$tmpc"
  assert_code "$(cat "$tmpc")" "200" "$name list"
  jq -e '.total >= 100000 and (.items | length) == 2' <"$dir/list.json" >/dev/null

  id=$(jq -r '.items[0].id' <"$dir/list.json")
  parse_resp "$(req GET "$base/items/$id")" "$dir/one.json" "$tmpc"
  assert_code "$(cat "$tmpc")" "200" "$name get"

  parse_resp "$(req GET "$base/items/abc")" "$tmpb" "$tmpc"
  assert_code "$(cat "$tmpc")" "400" "$name bad id"

  parse_resp "$(req GET "$base/items/999999999")" "$tmpb" "$tmpc"
  assert_code "$(cat "$tmpc")" "404" "$name not found"

  parse_resp "$(req GET "$base/stats")" "$dir/stats.json" "$tmpc"
  assert_code "$(cat "$tmpc")" "200" "$name stats"
  jq -e '(.stats | length) == 20' <"$dir/stats.json" >/dev/null

  parse_resp "$(req POST "$base/items" '{"title":"smoke-test-item","price":"1.23","category":"books"}')" "$tmpb" "$tmpc"
  assert_code "$(cat "$tmpc")" "201" "$name create"
  new_id=$(jq -r '.id' <"$tmpb")

  parse_resp "$(req PUT "$base/items/$new_id" '{"title":"smoke-test-item-2","price":"2.50","category":"books"}')" "$tmpb" "$tmpc"
  assert_code "$(cat "$tmpc")" "200" "$name update"

  parse_resp "$(req POST "$base/items" '{"title":"","price":"1","category":"books"}')" "$tmpb" "$tmpc"
  assert_code "$(cat "$tmpc")" "422" "$name validation"

  del=$(req DELETE "$base/items/$new_id")
  parse_resp "$del" "$tmpb" "$tmpc"
  assert_code "$(cat "$tmpc")" "204" "$name delete"
}

echo "Smoke: polyglot backends"

run_backend go "$GO_URL"
run_backend node "$NODE_URL"
run_backend php "$PHP_URL"
run_backend python "$PYTHON_URL"

compare_json /tmp/smoke_go/list.json /tmp/smoke_node/list.json "go vs node list"
compare_json /tmp/smoke_go/one.json /tmp/smoke_node/one.json "go vs node get"
compare_json /tmp/smoke_go/stats.json /tmp/smoke_node/stats.json "go vs node stats"
compare_json /tmp/smoke_go/list.json /tmp/smoke_php/list.json "go vs php list"
compare_json /tmp/smoke_go/stats.json /tmp/smoke_php/stats.json "go vs php stats"
compare_json /tmp/smoke_go/list.json /tmp/smoke_python/list.json "go vs python list"
compare_json /tmp/smoke_go/stats.json /tmp/smoke_python/stats.json "go vs python stats"

echo "SMOKE OK"
