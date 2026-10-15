#!/bin/bash
# End-to-end check over HTTP. Creates a to-do "MuseThings smoke test", renames, completes and trashes it.
# Run it at the Mac the first time: macOS asks whether node may control Things and read its data. Click Allow.
# Usage: MUSETHINGS_KEY=<key> scripts/smoke.sh [base-url]   (default http://127.0.0.1:8787)
set -euo pipefail
BASE="${1:-http://127.0.0.1:8787}"
: "${MUSETHINGS_KEY:?Set MUSETHINGS_KEY to the key printed by keygen}"
AUTH=(-H "Authorization: Bearer $MUSETHINGS_KEY")
JSON=(-H 'Content-Type: application/json')
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[process.argv[1]]))' "$1"; }

echo "1. health:  $(curl -fsS "$BASE/health")"
code=$(curl -s -o /dev/null -w '%{http_code}' "$BASE/lists/today")
[ "$code" = 401 ] && echo "2. no key → 401 ✔" || { echo "2. no key gave $code, expected 401 ✘"; exit 1; }
curl -fsS "${AUTH[@]}" "$BASE/lists/today" > /dev/null && echo "3. read Today ✔"
id=$(curl -fsS "${AUTH[@]}" "${JSON[@]}" -X POST "$BASE/todos" -d '{"title":"MuseThings smoke test","when":"today"}' | field id)
echo "4. created $id ✔"
title=$(curl -fsS "${AUTH[@]}" "${JSON[@]}" -X PATCH "$BASE/todos/$id" -d '{"title":"MuseThings smoke test ✓"}' | field title)
echo "5. renamed to \"$title\" ✔"
status=$(curl -fsS "${AUTH[@]}" -X POST "$BASE/todos/$id/complete" | field status)
echo "6. status $status ✔"
list=$(curl -fsS "${AUTH[@]}" -X DELETE "$BASE/todos/$id" | field list)
echo "7. moved to $list ✔"
echo "All good."
