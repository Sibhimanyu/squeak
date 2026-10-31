#!/bin/bash
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export HF_HUB_DISABLE_XET=1 HF_HUB_DOWNLOAD_TIMEOUT=60
"$ROOT/envs/mlxaudio-scout/bin/python" -I "$ROOT/runners/kyutai/kyutai_tts.py"
