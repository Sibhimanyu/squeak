#!/bin/bash
# usage: whisper_check.sh <variant>
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
for f in "$ROOT"/out/$1/*.wav; do
  ffmpeg -y -loglevel error -i "$f" -ar 16000 -ac 1 /tmp/wc_$$.wav
  echo "$(basename $f .wav): $(/opt/homebrew/bin/whisper-cli -m ~/Library/Application\ Support/squeak/whisper/ggml-base.en.bin -f /tmp/wc_$$.wav -nt 2>/dev/null | tr -s '\n ' ' ')"
done
