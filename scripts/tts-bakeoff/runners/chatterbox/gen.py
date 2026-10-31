import json, os, sys, time
import numpy as np, soundfile as sf
import mlx.core as mx
from mlx_audio.tts.utils import load_model

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
REF = os.path.join(ROOT, "ref.wav")
LINES = json.load(open(os.path.join(ROOT, "lines.json")))

# per-line (exaggeration, cfg_weight) for the emotion variant
EMO = {
    "01-greeting": (0.7, 0.3), "02-blocked": (0.9, 0.25), "03-done": (0.9, 0.3),
    "04-options": (0.4, 0.5), "05-wrong-pin": (0.4, 0.4), "06-taking-while": (0.5, 0.4),
    "07-failed": (0.7, 0.3), "08-callback": (0.8, 0.3),
}
TAGS = {
    "01-greeting": "Hello, this is Squeak. Your agent needs an answer. Which way should we go?",
    "02-blocked": "Heads up. Fix the parser is blocked on an approval. It wants to run the database migration, and it can't continue until you say yes.",
    "03-done": "Good news! Fix the parser is done, as you asked. It added three retries with backoff, and all the tests pass. [chuckle]",
    "04-options": "Options. 1, Merge now, recommended. 2, Open a PR first.",
    "05-wrong-pin": "[sigh] Sorry, that PIN is not right. Try again, then press hash.",
    "06-taking-while": "It's taking a while, so I'll let you go. You'll get a card when it's done. Goodbye.",
    "07-failed": "[sigh] Oh no. The build failed in conductor relay. TypeScript says the session ID is undefined on line 42.",
    "08-callback": "Okay, I'll call you back when squeak voice is done. Talk soon, goodbye! [chuckle]",
}

def run(repo, variant, model_name, notes, params_for, text_for):
    out = os.path.join(ROOT, "out", variant); os.makedirs(out, exist_ok=True)
    t = time.time(); model = load_model(repo); load_s = time.time() - t
    sr = model.sample_rate
    def gen(text, kw):
        chunks = [np.array(r.audio).reshape(-1) for r in model.generate(text=text, ref_audio=REF, verbose=False, **kw)]
        mx.eval(); return np.concatenate(chunks)
    gen("Warm up line.", params_for(LINES[0]["id"]))
    rows = []
    for l in LINES:
        kw = params_for(l["id"]); text = text_for(l)
        t = time.time(); a = gen(text, kw); dt = time.time() - t
        sf.write(os.path.join(out, l["id"] + ".wav"), a, sr, subtype="PCM_16")
        rows.append({"id": l["id"], "gen_seconds": round(dt, 2), "audio_seconds": round(len(a) / sr, 2),
                     "spoken_text": text + ("" if not kw else "  | " + json.dumps(kw))})
        print(variant, l["id"], rows[-1]["gen_seconds"], rows[-1]["audio_seconds"], flush=True)
    json.dump({"model": model_name, "variant": variant, "device": "mlx", "notes": notes,
               "load_seconds": round(load_s, 2), "lines": rows}, open(os.path.join(out, "timings.json"), "w"), indent=2)
    del model

CB = "mlx-community/Chatterbox-TTS-fp16"; TB = "mlx-community/Chatterbox-Turbo-TTS-fp16"
which = sys.argv[1:] or ["ex05", "emotion", "turbo"]
if "ex05" in which:
    run(CB, "chatterbox-clone-ex0.5", "Chatterbox (mlx-audio, fp16)", "clone of ref.wav; exaggeration=0.5, cfg_weight=0.5 for all lines",
        lambda i: dict(exaggeration=0.5, cfg_weight=0.5), lambda l: l["text"])
if "emotion" in which:
    run(CB, "chatterbox-clone-emotion", "Chatterbox (mlx-audio, fp16)",
        "clone of ref.wav; exaggeration/cfg_weight per line by emotion (urgent/cheerful 0.8-0.9 with cfg 0.25-0.3; neutral/gentle 0.4 with cfg 0.4-0.5); values appended to spoken_text",
        lambda i: dict(exaggeration=EMO[i][0], cfg_weight=EMO[i][1]), lambda l: l["text"])
if "turbo" in which:
    run(TB, "chatterbox-turbo-clone-tags", "Chatterbox Turbo (mlx-audio, fp16)",
        "clone of ref.wav; Turbo ignores exaggeration/cfg; paralinguistic tags [sigh]/[chuckle] added on fitting lines, words unchanged",
        lambda i: {}, lambda l: TAGS[l["id"]])
