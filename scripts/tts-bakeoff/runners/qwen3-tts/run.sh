#!/bin/bash
# VoiceDesign comes from the HF cache (already there); the others are curl-fetched into ROOT/envs/models.
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$HERE/../.."
export HF_HUB_DISABLE_XET=1 HF_HUB_DOWNLOAD_TIMEOUT=60
for M in 1.7B-CustomVoice-8bit 1.7B-Base-8bit 0.6B-CustomVoice-8bit; do
  [ -f "$ROOT/envs/models/Qwen3-TTS-12Hz-$M/model.safetensors" ] && [ -z "$(pgrep -f "fetch.sh.*$M")" ] || "$HERE/fetch.sh" mlx-community/Qwen3-TTS-12Hz-$M
done
exec "$ROOT/envs/qwen3-tts/bin/python" "$HERE/run.py" "$@"
