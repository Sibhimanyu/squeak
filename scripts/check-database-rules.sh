#!/usr/bin/env bash
# Checks firebase/database.rules.json against the local Realtime Database
# emulator: every allowed shape is allowed and every other write is refused.
#
#   (cd firebase && firebase emulators:exec --only database --project demo-squeak ../scripts/check-database-rules.sh)
#
# Needs Java (the emulator is a jar). Touches nothing in the cloud.
#
# Or against a deployed database, cleaning up after itself:
#   SQUEAK_RULES_DATABASE_URL=https://<db>.firebasedatabase.app scripts/check-database-rules.sh
set -uo pipefail

if [[ -n ${SQUEAK_RULES_DATABASE_URL:-} ]]; then
  DB=${SQUEAK_RULES_DATABASE_URL%/}
  NS="x=1"
else
  DB="http://127.0.0.1:${FIREBASE_DATABASE_EMULATOR_PORT:-9000}"
  NS="ns=demo-squeak-default-rtdb"
fi
CH="AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
RELAY="BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"
SIG64=$(printf 'a%.0s' {1..64})
failures=0

expect() {
  local want=$1 what=$2 method=$3 path=$4 body=${5:-}
  local args=(-s -o /dev/null -w '%{http_code}' -X "$method" "$DB/$path.json?$NS")
  [[ -n $body ]] && args+=(-d "$body")
  local code
  code=$(curl "${args[@]}")
  local got=refused
  [[ $code == 200 ]] && got=allowed
  if [[ $got == "$want" ]]; then
    echo "ok    $want  $what"
  else
    echo "FAIL  wanted $want, got $code  $what"
    failures=$((failures + 1))
  fi
}

# The channel's shape.
expect allowed "write a snapshot" PUT "channels/$CH/state/snapshot" '{"box":"x","at":1}'
expect allowed "write a signed command" PUT "channels/$CH/commands/c-1" '{"box":"x","sig":"s","device":"phone","at":2}'
expect allowed "write a live turn" PUT "channels/$CH/live/s12" '{"box":"x"}'
expect allowed "read a collection" GET "channels/$CH/commands"
expect allowed "delete a command" DELETE "channels/$CH/commands/c-1"
expect refused "read the channel root (would list kinds)" GET "channels/$CH"
expect refused "read every channel" GET "channels"
expect refused "read the database root" GET ""
expect refused "short channel id" PUT "channels/short/state/snapshot" '{"box":"x"}'
expect refused "unknown kind" PUT "channels/$CH/other/x" '{"box":"x"}'
expect refused "extra field" PUT "channels/$CH/state/snapshot" '{"box":"x","evil":1}'
expect refused "no box" PUT "channels/$CH/state/snapshot" '{"at":1}'
expect refused "box not a string" PUT "channels/$CH/state/snapshot" '{"box":1}'
expect refused "device too long" PUT "channels/$CH/commands/c-2" "{\"box\":\"x\",\"device\":\"$(printf 'd%.0s' {1..64})\"}"
expect refused "write a whole collection at once" PUT "channels/$CH/commands" '{"a":{"box":"x"}}'
expect refused "write outside channels" PUT "elsewhere/x" '{"box":"x"}'

# The Cliq relay: create or delete, never rewrite.
expect allowed "create a Cliq record" PUT "cliq/$RELAY/inbox/r-1" "{\"box\":\"x\",\"sig\":\"$SIG64\",\"at\":1}"
expect refused "rewrite a Cliq record" PUT "cliq/$RELAY/inbox/r-1" "{\"box\":\"y\",\"sig\":\"$SIG64\",\"at\":2}"
expect allowed "read the Cliq inbox" GET "cliq/$RELAY/inbox"
expect allowed "delete a Cliq record" DELETE "cliq/$RELAY/inbox/r-1"
expect refused "Cliq record with a short signature" PUT "cliq/$RELAY/inbox/r-2" '{"box":"x","sig":"abc","at":1}'
expect refused "Cliq record without a time" PUT "cliq/$RELAY/inbox/r-3" "{\"box\":\"x\",\"sig\":\"$SIG64\"}"
expect refused "short relay id" PUT "cliq/short/inbox/r-4" "{\"box\":\"x\",\"sig\":\"$SIG64\",\"at\":1}"
expect refused "read every relay" GET "cliq"

# Leave nothing behind (the rules allow deleting each document).
for doc in state/snapshot live/s12 commands/c-1; do
  curl -s -o /dev/null -X DELETE "$DB/channels/$CH/$doc.json?$NS"
done

if ((failures > 0)); then
  echo "$failures rule check(s) failed"
  exit 1
fi
echo "all database rule checks passed"
