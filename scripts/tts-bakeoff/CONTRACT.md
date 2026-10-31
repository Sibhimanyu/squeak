# TTS bake-off: runner contract

Goal: compare expressive/emotional local TTS models on an Apple M5 Pro (24 GB unified memory, 15 cores, macOS 26)
for Squeak's phone calls (heard over an 8 kHz phone line). Clips are made ahead of the call, so it need not be
real time, but generation time matters (a few seconds per line is fine, a minute is not).

Root: this folder (`scripts/tts-bakeoff/`; call it ROOT). Venvs, audio and the listening page it makes are gitignored.

## Inputs
- `ROOT/lines.json`: 8 lines, each `{id, emotion, text}`. `emotion` is the intended delivery.
- `ROOT/ref.wav` (24 kHz mono, 8.3 s) + `ROOT/ref.txt` (its transcript): the reference voice for any model that
  clones a voice, so cloned models share a voice. Models with good built-in voices may ALSO produce a variant
  with their best built-in English voice.

## What each runner does
- Lives in `ROOT/runners/<model>/` with its own venv at `ROOT/envs/<model>/` (use `uv venv --python 3.11` or 3.12;
  never touch the system Python or `~/Library/Application Support/squeak`).
- `ROOT/runners/<model>/run.sh` (no args) regenerates everything for that model, idempotently.
- Writes one folder per variant: `ROOT/out/<variant>/` with `<line id>.wav` (mono, native sample rate, PCM16)
  and `timings.json`: `{"model": "...", "variant": "...", "device": "mps|mlx|cpu", "notes": "how emotion was
  steered", "load_seconds": n, "lines": [{"id": "...", "gen_seconds": n, "audio_seconds": n, "spoken_text": "..."}]}`.
  `gen_seconds` is wall time for that line after the model is loaded and warmed up with one throwaway line.
- Variant names: `<model>-<how>`, e.g. `chatterbox-clone-ex0.7`, `orpheus-tara-tags`.
- Steer emotion with whatever the model offers (exaggeration knobs, emotion vectors, instruction prompts, inline
  tags like `<sigh>`/`[laugh]`, emotion reference audio). The spoken WORDS must stay the line's `text`
  exactly; tags that are not spoken are fine. Record what you did in `notes` and the exact input in `spoken_text`.
- Prefer Apple-Silicon-native paths: MLX (`mlx-audio`, `mlx-community/*` weights) first, then PyTorch on `mps`,
  CPU only as a last resort (say so in `device`).
- Downloads go to the default Hugging Face cache. Disk has ~220 GB free; RAM is 24 GB, so close other big
  models before loading one, and pick fp16/bf16 or 8-bit weights when full-precision won't fit.
- Other agents are installing other models at the same time. Don't run timed generations while you know a
  heavy download/compile is your own bottleneck; final timings get re-run serially later anyway via `run.sh`.

## Report back
Per model: whether it works, variants produced, load time, typical gen seconds per line, peak memory if easy,
licence (commercial use OK?), and anything that went wrong or was skipped and why. Keep it short.

## Network notes (learned on this Mac)
- Hugging Face downloads here are slow and stall: set `HF_HUB_DISABLE_XET=1 HF_HUB_DOWNLOAD_TIMEOUT=60` and retry
  `snapshot_download` in a loop (see `~/qwen3-tts/fetch_and_test.sh`, which needed 2 attempts for 8 GB).
- An existing working MLX install: `~/qwen3-tts/.venv` (mlx-audio) with
  `mlx-community/Qwen3-TTS-12Hz-1.7B-VoiceDesign-8bit` cached. Read-only reference; don't modify it.
