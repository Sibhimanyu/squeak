#!/usr/bin/env bash
#
# Runs the Mac package's tests and prints one line for both runners:
#
#   macos/scripts/test.sh [swift test args...]     e.g. --filter PondCentreTests
#   -> xctest=325/0 swift-testing=2560/0(runs failed) log=<tmp log>   (tests/failures; non-zero exit when red)
#
# `swift test` runs XCTest and Swift Testing one after the other and prints a summary for each. Grepping for one of
# them hides the other (a red XCTest once reached the branch that way), and a crashed XCTest bundle prints no summary at
# all. This exits non-zero when either runner fails, crashes, or reports nothing, and keeps the full log.
set -uo pipefail
cd "$(dirname "$0")/.."

log="${SQUEAK_TEST_LOG:-$(mktemp -t squeak-mac-test).log}"
swift test "$@" >"$log" 2>&1
code=$?

# XCTest prints a summary per suite and per bundle; the bundle's is the largest count.
xc=$(grep -Eo 'Executed [0-9]+ tests?, with [0-9]+ failures?' "$log" | awk '{print $2, $5}' | sort -n | tail -1)
xc_total=${xc% *}
xc_failed=${xc#* }
# Swift Testing prints one "Test run with N tests ... passed|failed" per run (the package has more than one).
st_lines=$(grep -E 'Test run with [0-9]+ tests? .*(passed|failed)' "$log" | sort -u)
st_total=$(printf '%s\n' "$st_lines" | grep -Eo 'with [0-9]+ tests?' | grep -Eo '[0-9]+' | awk '{s+=$1} END {print s+0}')
st_failed=$(printf '%s\n' "$st_lines" | grep -c ' failed' || true)
[ -z "$st_lines" ] && st_total=none
st="$st_lines"

printf 'xctest=%s/%s swift-testing=%s/%s(runs failed) log=%s\n' "${xc_total:-none}" "${xc_failed:-?}" "${st_total:-none}" "${st_failed}" "$log"

bad=0
[ "$code" -ne 0 ] && bad=1
[ -z "$xc" ] && [ -z "$st" ] && bad=1
[ -n "$xc" ] && [ "$xc_failed" != "0" ] && bad=1
[ "$st_failed" != "0" ] && bad=1
if [ "$bad" -ne 0 ]; then
  grep -E 'error: -\[|✘ Test .* (failed|recorded an issue)|Fatal error|Unexpectedly found nil|crashed' "$log" | head -40
  # No test ran (a build error, a crash before the first summary): show where it stopped.
  [ -z "$xc" ] && [ -z "$st" ] && { grep -E 'error:' "$log" | head -20; tail -15 "$log"; }
  printf 'macos tests: RED (swift test exit %s)\n' "$code" >&2
  exit 1
fi
