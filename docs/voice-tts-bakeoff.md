# Call voice bake-off (2026-10-31)

Which local text-to-speech model should speak Squeak's phone calls, now that we want emotion and not just Kokoro's
plain voice. Twenty-two variants of eleven models were run on the same lines on this Mac and scored the same way. The
harness is in `scripts/tts-bakeoff/` and reruns with no network beyond the model downloads. This page is the record:
read it before choosing, adding or retuning a voice engine (`src/voice/natural-*.ts`, `docs/voice.md`).

## Outcome

Squeak offers a picker of engines rather than one winner, because nobody has rated the emotion by ear yet and the
numbers below cannot measure it:

- **Kokoro**: kept as the default. Clearest and fastest, no emotion control.
- **Qwen3-TTS**: emotion described in plain words (an instruct sentence), so each kind of call can sound different.
  VoiceDesign was clear (3.0%) and fast (1.8 s), but it invents the voice again on every render, so a call would
  change voice between sentences. CustomVoice (fixed speakers) keeps one voice, but its first test speaker, Serena
  (a Chinese-native voice), garbled Squeak's words (9.5%: "Greg" for "Squeak", "Gameez" for "Good news", dropped
  "1," and "2,"). Offer English-native speakers, and check each one with Whisper before listing it.
- **Ming-3.0 0.5B**: the best speed and clarity of the emotion models (1.8%, 1.7 s). Its emotion keys are coarse:
  happy, sad, angry, fear, disgust, surprise and neutral, written in Chinese (高兴, 悲伤, …), plus speed, pitch and
  volume levels.
- **Chatterbox**: MIT, with one emotion dial (`exaggeration`, with `cfg_weight` lowered as it rises). It clones any
  reference clip, so it can take Kokoro's voices.

Runners-up worth a second look if one of the above disappoints: **VoxCPM2** (the clearest after Kokoro, but 7–11 s
a line) and **CSM-1B** (2.7%, 2.6 s, no emotion control).

## Method

- **Machine**: MacBook Pro, Apple M5 Pro, 24 GB unified memory, macOS 26. MLX through `mlx-audio` 0.6.x wherever a port
  existed (all but Kokoro, which is ONNX on the CPU).
- **Lines** (`lines.json`): eight of Squeak's real call lines, each with the intended delivery: friendly but urgent
  greeting, blocked on approval, finished, the options list, wrong PIN, "taking a while", build failed with code words
  ("conductor relay", "TypeScript", "line 42"), and the call-back goodbye.
- **One voice for the cloning models**: `ref.wav` is Kokoro `af_heart` reading `ref.txt` (8.3 s), so the cloning
  models are compared on delivery, not on whose voice is nicer.
- **What a caller hears** (`score.py`): each clip is band-passed 300–3400 Hz, loudness-normalised, taken to 8 kHz μ-law
  and back. "WER" is Whisper `base.en` on that phone copy against the line's text (digits and words count the same,
  tags are ignored). It measures whether the words survive the line. It does not measure emotion or naturalness.
- **Speed**: seconds to make one line after the model is loaded and warmed with one throwaway line. RTF is make time
  ÷ audio length (under 1 is faster than real time).
- **Caveat on speed**: six installs ran at once and the timings were taken while other models downloaded or loaded,
  so treat them as upper bounds. They were not re-run serially, because testing was stopped there.

## Results

Sorted by WER (lower is clearer over the phone). Peak memory is MLX's own peak where the runner recorded it.

| variant | WER | s/line | RTF | load s | peak GB | emotion control |
|---|---|---|---|---|---|---|
| kokoro-af_heart | 1.2% | 1.6 | 0.30 | 0.4 | | none |
| voxcpm2-clone-plain | 1.2% | 9.0 | 1.49 | 1.9 | | none |
| ming3-clone-emotion | 1.8% | 1.7 | 0.29 | 2.3 | | Chinese emotion key + speed/pitch/volume caption |
| voxcpm2-clone-styled | 1.8% | 10.9 | 1.72 | 1.9 | | style prefix |
| voxcpm2-design-emotion | 1.8% | 7.2 | 1.16 | 1.9 | | `(A young woman, <delivery>)` voice design |
| chatterbox-turbo-clone-tags | 2.3% | 5.4 | 0.82 | 4.3 | | `[sigh]` / `[chuckle]` tags |
| csm-clone | 2.7% | 2.6 | 0.46 | 5.3 | 3.8 | none (context audio only) |
| kyutai-expresso-emotion | 2.9% | 13.7 | 2.18 | 1.6 | | emotional reference voices (Expresso set) |
| qwen3-voicedesign-instruct | 3.0% | 1.8 | 0.32 | 19.8 | 6.8 | instruct sentence (voice + emotion) |
| ming3-usemma-emotion | 3.0% | 1.7 | 0.29 | 2.3 | | built-in US_Emma + emotion caption |
| ming3-freeform | 3.6% | 1.6 | 0.30 | 2.3 | | English free-form instruction |
| chatterbox-clone-ex0.5 | 3.6% | 2.9 | 0.50 | 1.5 | | exaggeration 0.5 (default) |
| spark-clone | 3.7% | 1.8 | 0.30 | 2.2 | | none |
| chatterbox-clone-emotion | 3.7% | 2.6 | 0.47 | 1.1 | | exaggeration 0.4–0.9, cfg 0.25–0.5 per line |
| ming3-clone-plain | 4.6% | 1.6 | 0.30 | 2.3 | | none |
| spark-female-pitchspeed | 5.1% | 1.7 | 0.31 | 2.2 | | gender/pitch/speed only |
| dia-clone | 6.2% | 9.0 | 2.21 | 1.9 | 8.5 | none |
| kyutai-defaultvoice-plain | 6.3% | 13.5 | 2.21 | 1.6 | | none |
| qwen3-customvoice-serena-instruct | 9.5% | 10.9 | 1.52 | 6.6 | 7.2 | instruct sentence, preset speaker |
| orpheus-tara-plain | 9.9% | 6.5 | 0.74 | 3.9 | 6.2 | none |
| dia-clone-nonverbal | 10.0% | 10.5 | 2.17 | 1.7 | 10.3 | `(laughs)` / `(sighs)`, 4 lines only |
| orpheus-tara-tags | 10.4% | 7.7 | 0.82 | 3.6 | 6.2 | `<chuckle>` / `<sigh>` tags |

Per-line transcripts and timings: `scripts/tts-bakeoff/results.json`.

## What each model taught us

- **Kokoro-82M** (ONNX, Apache-2.0): still the clearest. It has no emotion at all.
- **Qwen3-TTS 1.7B** (`mlx-community/Qwen3-TTS-12Hz-1.7B-*-8bit`, Apache-2.0): **VoiceDesign** takes `--instruct`
  (voice and delivery in words) and is fast and clear, but its voice is not stable from one render to the next.
  **CustomVoice** has fixed speakers plus instruct, and with a Chinese-native speaker it mangled English words. Base
  (cloning) was not tested: its download was stopped. The first load is about 20 s (VoiceDesign).
- **Ming-3.0-tts 0.5B** (`mlx-community/Ming-3.0-tts-0.5B-bf16`, found by the scout; check the licence on the model
  card before shipping): very fast, clear, emotion through a caption (`ming3_instruction` in mlx-audio's `bailingmm`).
  Cloning and the built-in `US_Emma` both work.
- **Chatterbox** (`mlx-community/Chatterbox-TTS-fp16`, MIT): needs `mlx-community/S3TokenizerV2` at load. Turbo
  ignores exaggeration and cfg, takes `[sigh]`-style tags, and was slower than the base model here.
- **VoxCPM2 2B** (bf16): very clear, slow. Voice design by a parenthesised prefix.
- **CSM-1B** (Sesame, 8-bit): every line came through. No emotion knob.
- **Spark-TTS 0.5B**: fast. Only gender, pitch and speed controls.
- **Kyutai TTS 1.6B** (moshi_mlx): emotion by picking an emotional reference voice from the Expresso set. Over 2×
  slower than real time here.
- **Dia 1.6B**: cuts off the end of lines (an end-of-speech problem in the MLX port), up to 10 GB peak. Dia 2 has no
  mlx-audio module yet.
- **Orpheus 3B** (4-bit, Llama licence): tags are audible but smear neighbouring words. The worst for exact text.
- **Not finished**, stopped when testing ended: IndexTTS2 (PyTorch on MPS, slow to set up), Higgs Audio v2/v3 and
  VibeVoice 1.5B (multi-GB downloads still going). Their runners are in the harness but produced no clips.

## Gotchas found on this Mac

- Hugging Face downloads stall here. Set `HF_HUB_DISABLE_XET=1 HF_HUB_DOWNLOAD_TIMEOUT=60` and retry
  `snapshot_download` in a loop (it resumes). Measured: about 31 MB/s on the interface with eight downloads at
  once, about 19 MB/s of that landing in the cache.
- A speed test like fast.com run during downloads reports only the leftover bandwidth (it read 40 Mbps while the
  interface was doing about 260).
- Two MLX workers means two copies of the model in GPU memory, and `nice` does nothing for the GPU. One worker per
  MLX engine.
- Whisper `base.en` hears "back off" as "backoff", "PIN" as "pin", and so on. Those count as small WER and are not
  model faults.

## Rerunning or adding a model

```bash
cd scripts/tts-bakeoff
# each runner makes its own venv in envs/ and writes out/<variant>/{<line>.wav,timings.json}
runners/<model>/run.sh
python3 score.py               # phone copies, Whisper, results.json, index.html (listen + blind 1–5 ratings)
open -g -a Terminal progress.command   # optional live view of downloads and clips
```

`CONTRACT.md` is the brief each runner was written to: venv per model, warm-up line excluded from timings, the same
words spoken (tags allowed), and the emotion steering recorded in `notes`. Give it to an agent when adding a model.
Never keep the `envs/`, `out/` or `phone/` folders in git. They are gitignored and hold many GB.
