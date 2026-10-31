#!/bin/bash
set -e
R="$(cd "$(dirname "$0")/../.." && pwd)"
export HF_HUB_DISABLE_XET=1 HF_HUB_DOWNLOAD_TIMEOUT=60
"$R/envs/higgs-vibevoice/bin/python" "$R/runners/higgs/gen.py" "$@"
