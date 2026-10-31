#!/bin/bash
# Regenerates out/{orpheus-tara-plain,orpheus-tara-tags}. Env is shared by orpheus/dia/csm (mlx-audio).
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export HF_HUB_DISABLE_XET=1 HF_HUB_DOWNLOAD_TIMEOUT=60
PY="$ROOT/envs/mlxaudio-orpheus-dia-csm/bin/python"
for v in orpheus-tara-plain orpheus-tara-tags; do "$PY" "$ROOT/runners/tts_run.py" "$v"; done
