#!/usr/bin/env bash
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
export HF_HUB_DISABLE_XET=1 HF_HUB_DOWNLOAD_TIMEOUT=60 PYTORCH_ENABLE_MPS_FALLBACK=1
SRC="$ROOT/envs/indextts2-src"
CK="$SRC/checkpoints_2"
if [ ! -f "$CK/config.yaml" ] || [ ! -f "$CK/gpt.pth" ]; then
  for i in $(seq 1 20); do
    "$ROOT/envs/indextts2/bin/python" -c "
from huggingface_hub import snapshot_download
snapshot_download('IndexTeam/IndexTTS-2', local_dir='$CK')" && break
    sleep 3
  done
fi
cd "$SRC"
exec "$ROOT/envs/indextts2/bin/python" "$HERE/gen.py" "$ROOT" "$SRC" "$CK"
