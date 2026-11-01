#!/usr/bin/env python3
"""Clarity check of the shared voices on the cloning engines (docs/voice-tts-bakeoff.md, "One voice list across engines").

Renders `lines.json` plus two harder lines through Squeak's own worker script (src/voice/natural-worker-mlx.ts, written
out by the command below) for each engine x voice, makes the phone-line
copy (score.py's `phone_copy`), transcribes it with Whisper and prints the WER per voice and the worst line.

  npx tsx -e 'import {MING_WORKER_PY,CHATTERBOX_WORKER_PY} from "./src/voice/natural-worker-mlx.ts"; import fs from "node:fs";
    fs.mkdirSync("scripts/tts-bakeoff/out/clone-check",{recursive:true});
    fs.writeFileSync("scripts/tts-bakeoff/out/clone-check/worker-ming.py",MING_WORKER_PY);
    fs.writeFileSync("scripts/tts-bakeoff/out/clone-check/worker-chatterbox.py",CHATTERBOX_WORKER_PY)'
  python3 scripts/tts-bakeoff/clone-voices-check.py [ming|chatterbox ...]

The engines are the installed ones (~/Library/Application Support/squeak/voice-tts-*): their venv, weights and refs/.
Results land in out/clone-check/results.json. Pass: WER <= 5% over the voice's lines and no line with a dropped half.
"""
import json, pathlib, subprocess, sys

ROOT = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))
import score  # noqa: E402

SUPPORT = pathlib.Path.home() / "Library/Application Support/squeak"
ENGINES = {"ming": "voice-tts-ming", "chatterbox": "voice-tts-chatterbox"}
VOICES = ["af_heart", "af_bella", "af_nicole", "bf_emma", "am_michael", "am_adam", "bm_george"]
MOODS = {"01-greeting": "cheerful", "02-blocked": "urgent", "03-done": "cheerful", "04-options": "neutral",
         "05-wrong-pin": "apologetic", "06-taking-while": "warm", "07-failed": "sympathetic", "08-callback": "warm"}
EXTRA = [
    {"id": "09-long", "mood": "neutral", "text": "Heads up. The agent working on the voice settings finished its first pass and wants your decision before it goes on. It changed the engine list, the saved settings and the sentence cache, ran the whole test suite, and found nothing wrong, but it would like to know whether to ship now or wait until you have looked at the diff."},
    {"id": "10-names", "mood": "neutral", "text": "Squeak, Conductor and Claude Code are all running. Codex is idle, and the Telegram bot and Cliq are connected."},
]
LINES = [{**l, "mood": MOODS[l["id"]]} for l in score.LINES] + EXTRA
OUT = ROOT / "out" / "clone-check"


def render(engine, voices):
    folder = SUPPORT / ENGINES[engine]
    worker = OUT / f"worker-{engine}.py"
    proc = subprocess.Popen([str(folder / "venv/bin/python3"), str(worker), str(folder / "model"), str(folder)],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=open(OUT / f"{engine}.log", "w"), text=True)
    assert json.loads(proc.stdout.readline()).get("ready")
    n = 0
    for voice in voices:
        d = OUT / engine / voice
        d.mkdir(parents=True, exist_ok=True)
        for ln in [LINES[0]] + LINES:  # first line twice: a warm-up
            n += 1
            out = d / f"{ln['id']}.wav"
            proc.stdin.write(json.dumps({"id": n, "text": ln["text"], "voice": voice, "speed": 1.0, "out": str(out),
                                         "mood": ln["mood"], "level": "subtle"}) + "\n")
            proc.stdin.flush()
            reply = json.loads(proc.stdout.readline())
            if not reply.get("ok"):
                print("FAILED", engine, voice, ln["id"], reply, flush=True)
    proc.stdin.close()
    proc.wait()


def check(engine, voice):
    d = OUT / engine / voice
    rows = {}
    for ln in LINES:
        wav = d / f"{ln['id']}.wav"
        if not wav.exists():
            rows[ln["id"]] = {"wer": 1.0, "heard": "(missing)"}
            continue
        phone = d / f"{ln['id']}.phone.wav"
        score.phone_copy(wav, phone)
        heard = score.transcribe(phone)
        rows[ln["id"]] = {"wer": score.wer(ln["text"], heard), "heard": heard}
    errors = sum(r["wer"] * len(score.words(l["text"])) for l, r in zip(LINES, rows.values()))
    total = sum(len(score.words(l["text"])) for l in LINES)
    worst = max(rows, key=lambda k: rows[k]["wer"])
    return {"wer": errors / total, "worst": worst, "worst_wer": rows[worst]["wer"], "lines": rows}


def main():
    engines = sys.argv[1:] or list(ENGINES)
    results = {}
    for engine in engines:
        render(engine, VOICES)
        results[engine] = {v: check(engine, v) for v in VOICES}
        for v, r in results[engine].items():
            print(f"{engine:11s} {v:11s} WER {r['wer'] * 100:5.1f}%  worst {r['worst']} {r['worst_wer'] * 100:.0f}%", flush=True)
    (OUT / "results.json").write_text(json.dumps(results, indent=1, ensure_ascii=False))


if __name__ == "__main__":
    main()
