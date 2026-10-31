"""Shared harness: python tts_run.py <variant>. Writes ROOT/out/<variant>/*.wav + timings.json."""
import json, os, sys, time, gc
from pathlib import Path
import numpy as np, soundfile as sf
import mlx.core as mx

ROOT = Path(__file__).resolve().parent.parent
LINES = json.loads((ROOT / "lines.json").read_text())
REF_WAV = str(ROOT / "ref.wav")
REF_TXT = (ROOT / "ref.txt").read_text().strip()
variant = sys.argv[1]
only = sys.argv[2:]  # optional line-id filter for debugging

ORPHEUS_TAGS = {
    "01-greeting": "Hello, this is Squeak. Your agent needs an answer. Which way should we go?",
    "02-blocked": "Heads up. Fix the parser is blocked on an approval. It wants to run the database migration, and it can't continue until you say yes.",
    "03-done": "Good news! <chuckle> Fix the parser is done, as you asked. It added three retries with backoff, and all the tests pass.",
    "04-options": "Options. 1, Merge now, recommended. 2, Open a PR first.",
    "05-wrong-pin": "<sigh> Sorry, that PIN is not right. Try again, then press hash.",
    "06-taking-while": "It's taking a while, so I'll let you go. You'll get a card when it's done. Goodbye.",
    "07-failed": "Oh no. <sigh> The build failed in conductor relay. TypeScript says the session ID is undefined on line 42.",
    "08-callback": "Okay, I'll call you back when squeak voice is done. <chuckle> Talk soon, goodbye!",
}
DIA_NV = {
    "03-done": "Good news! (laughs) Fix the parser is done, as you asked. It added three retries with backoff, and all the tests pass.",
    "05-wrong-pin": "(sighs) Sorry, that PIN is not right. Try again, then press hash.",
    "07-failed": "Oh no. (sighs) The build failed in conductor relay. TypeScript says the session ID is undefined on line 42.",
    "08-callback": "Okay, I'll call you back when squeak voice is done. (laughs) Talk soon, goodbye!",
}

def cfg(v):
    if v == "orpheus-tara-plain":
        return dict(model="Orpheus 3B ft (mlx-community/orpheus-3b-0.1-ft-4bit, mlx-audio)", repo="mlx-community/orpheus-3b-0.1-ft-4bit",
            notes="Built-in voice tara, plain text, no tags.", text=lambda l: l["text"],
            kw=lambda l: dict(voice="tara"))
    if v == "orpheus-tara-tags":
        return dict(model="Orpheus 3B ft (mlx-community/orpheus-3b-0.1-ft-4bit, mlx-audio)", repo="mlx-community/orpheus-3b-0.1-ft-4bit",
            notes="Voice tara; inline emotion tags (<chuckle>, <sigh>) inserted where the line's emotion fits; words unchanged.",
            text=lambda l: ORPHEUS_TAGS[l["id"]], kw=lambda l: dict(voice="tara"))
    if v in ("dia-clone", "dia-clone-nonverbal"):
        nv = v.endswith("nonverbal")
        return dict(model="Dia 1.6B (mlx-community/Dia-1.6B-fp16, mlx-audio)", repo="mlx-community/Dia-1.6B-fp16",
            notes="Voice clone: ref.wav as audio prompt, ref transcript prefixed as [S1] text, then [S1] + line."
                  + (" Non-verbals like (laughs)/(sighs) inserted on lines 03, 05, 07, 08 only (others plain)." if nv else ""),
            text=lambda l: "[S1] " + ((DIA_NV.get(l["id"], l["text"])) if nv else l["text"]),
            kw=lambda l: dict(ref_audio=REF_WAV, ref_text="[S1] " + REF_TXT),
            only_ids=(set(DIA_NV) if nv else None))
    if v in ("dia2-clone",):
        raise SystemExit("dia2 handled elsewhere")
    if v == "csm-clone":
        return dict(model="CSM-1B (mlx-community/csm-1b-8bit, mlx-audio)", repo="mlx-community/csm-1b-8bit",
            notes="Voice clone: ref.wav + ref.txt as the speaker-0 context segment (mlx-audio voice_match).",
            text=lambda l: l["text"], kw=lambda l: dict(ref_audio=REF_WAV, ref_text=REF_TXT))
    raise SystemExit("unknown variant " + v)

c = cfg(variant)
from mlx_audio.tts.utils import load_model
t0 = time.time()
model = load_model(c["repo"])
load_s = time.time() - t0

def synth(text, kw):
    chunks = []
    for r in model.generate(text, **kw):
        chunks.append(np.array(r.audio, dtype=np.float32))
        sr = r.sample_rate
    mx.eval()
    return np.concatenate(chunks), sr

warm_kw = c["kw"](LINES[0])
synth(LINES[1]["text"] if not variant.startswith("dia") else "[S1] Hello there, this is a test.", warm_kw)  # warm-up

outd = ROOT / "out" / variant
outd.mkdir(parents=True, exist_ok=True)
res = []
for l in LINES:
    if only and l["id"] not in only: continue
    if c.get("only_ids") and l["id"] not in c["only_ids"]: continue
    text = c["text"](l)
    t = time.time()
    audio, sr = synth(text, c["kw"](l))
    gen = time.time() - t
    peak = float(np.max(np.abs(audio))) or 1.0
    if peak > 1.0: audio = audio / peak
    sf.write(outd / f"{l['id']}.wav", audio, sr, subtype="PCM_16")
    res.append(dict(id=l["id"], gen_seconds=round(gen, 2), audio_seconds=round(len(audio) / sr, 2), spoken_text=text))
    print(variant, l["id"], res[-1]["gen_seconds"], res[-1]["audio_seconds"], flush=True)
    mx.clear_cache()
(outd / "timings.json").write_text(json.dumps(dict(model=c["model"], variant=variant, device="mlx", notes=c["notes"],
    load_seconds=round(load_s, 2), peak_memory_gb=round(mx.get_peak_memory() / 1e9, 2), lines=res), indent=2))
