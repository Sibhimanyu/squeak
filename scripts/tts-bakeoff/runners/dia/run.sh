#!/bin/bash
# Regenerates out/{dia-clone,dia-clone-nonverbal}. Env is shared by orpheus/dia/csm (mlx-audio).
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export HF_HUB_DISABLE_XET=1 HF_HUB_DOWNLOAD_TIMEOUT=60
PY="$ROOT/envs/mlxaudio-orpheus-dia-csm/bin/python"
for v in dia-clone dia-clone-nonverbal; do "$PY" "$ROOT/runners/tts_run.py" "$v"; done
