#!/bin/bash
# Live view of a bake-off run in its own Terminal window: open -g -a Terminal progress.command
printf '\e]0;TTS bake-off progress\a'
printf '\e[8;42;140t'
here="$(cd "$(dirname "$0")" && pwd)"
py="$(ls "$here"/envs/*/bin/python 2>/dev/null | head -1)"
exec "${py:-python3}" "$here/progress.py"
