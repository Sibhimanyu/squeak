#!/bin/bash
D="$HOME/Library/Application Support/squeak/voice-tts"
exec "$D/venv/bin/python" "$(dirname "$0")/run.py"
