#!/bin/bash
# Download Qwen3-TTS MLX repos with curl resume into ROOT/envs/models/<repo-name> (HF here stalls; snapshot_download restarts files).
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
for R in "$@"; do
  D="$ROOT/envs/models/${R##*/}"; mkdir -p "$D/speech_tokenizer"
  curl -s -m 60 "https://huggingface.co/api/models/$R/tree/main?recursive=1" | python3 -c "
import json,sys
for f in json.load(sys.stdin):
    if f['type']=='file': print(f['path'], f['size'])" > "$D/.files" || continue
  while read P S; do
    mkdir -p "$D/$(dirname "$P")"
    for i in $(seq 1 200); do
      [ "$(stat -f%z "$D/$P" 2>/dev/null || echo 0)" = "$S" ] && break
      curl -sL --retry 3 --connect-timeout 20 --speed-limit 20000 --speed-time 30 -C - -o "$D/$P" "https://huggingface.co/$R/resolve/main/$P"
    done
  done < "$D/.files"
done
