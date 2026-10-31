import json, os, sys, time, gc, traceback
import numpy as np, soundfile as sf
import mlx.core as mx
from mlx_audio.tts.utils import load_model
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
lines = json.load(open(f"{ROOT}/lines.json"))
ref_text = open(f"{ROOT}/ref.txt").read().strip()
HF = "mlx-community/Qwen3-TTS-12Hz-"
DESIGN = "A warm, friendly young American woman, clear and natural, a helpful voice assistant. Delivery: "
EMO = lambda l: l["emotion"]

# variant -> (repo, kwargs builder)
VARIANTS = {
  "qwen3-voicedesign-instruct": (HF + "1.7B-VoiceDesign-8bit", lambda l: dict(instruct=DESIGN + EMO(l))),
  "qwen3-base-clone": (HF + "1.7B-Base-8bit", lambda l: dict(ref_audio=f"{ROOT}/ref.wav", ref_text=ref_text)),
}
for spk in os.environ.get("QWEN_SPEAKERS", "serena,ryan").split(","):
    VARIANTS[f"qwen3-customvoice-{spk}-instruct"] = (HF + "1.7B-CustomVoice-8bit", lambda l, s=spk: dict(voice=s, instruct="Speak in a " + EMO(l) + " tone."))
    VARIANTS[f"qwen3-customvoice06-{spk}-instruct"] = (HF + "0.6B-CustomVoice-8bit", lambda l, s=spk: dict(voice=s, instruct="Speak in a " + EMO(l) + " tone."))
NOTES = {
 "voicedesign": "VoiceDesign: one fixed voice description + the line's emotion in the instruct text.",
 "clone": "Base model voice cloning (ICL) from ROOT/ref.wav + ref.txt; no emotion control (Base rejects instruct).",
 "customvoice": "CustomVoice preset speaker; emotion given as instruct text.",
}
only = sys.argv[1:] 
def gen_one(model, kw, text):
    chunks = []; sr = 24000
    for r in model.generate(text=text, lang_code="en", verbose=False, **kw):
        chunks.append(np.array(r.audio, dtype=np.float32)); sr = r.sample_rate
    return np.concatenate(chunks), sr

groups = {}
for v, (repo, fn) in VARIANTS.items():
    if only and v not in only: continue
    groups.setdefault(repo, []).append((v, fn))
for repo, vs in groups.items():
    try:
        local = f"{ROOT}/envs/models/{repo.split('/')[-1]}"; t = time.time(); model = load_model(local if os.path.exists(local + '/model.safetensors') else repo); load = time.time() - t
    except Exception as e:
        print("LOAD FAIL", repo, e); traceback.print_exc(); continue
    for v, fn in vs:
        out = f"{ROOT}/out/{v}"; os.makedirs(out, exist_ok=True)
        try:
            gen_one(model, fn(lines[0]), "Warm up line.")
            res = []
            for l in lines:
                kw = fn(l); t = time.time(); a, sr = gen_one(model, kw, l["text"]); mx.eval(mx.zeros(1)); g = time.time() - t
                sf.write(f"{out}/{l['id']}.wav", np.clip(a, -1, 1), sr, subtype="PCM_16")
                res.append({"id": l["id"], "gen_seconds": round(g, 3), "audio_seconds": round(len(a) / sr, 3),
                            "spoken_text": l["text"], "input": {k: v2 for k, v2 in kw.items() if k != "ref_audio"}})
            kind = "voicedesign" if "voicedesign" in v else "clone" if "clone" in v else "customvoice"
            json.dump({"model": repo, "variant": v, "device": "mlx", "notes": NOTES[kind] + " Text spoken verbatim.",
                       "load_seconds": round(load, 2), "peak_memory_gb": round(mx.get_peak_memory() / 1e9, 2),
                       "lines": res}, open(f"{out}/timings.json", "w"), indent=2)
            print("done", v, [r["gen_seconds"] for r in res], flush=True)
        except Exception as e:
            print("VARIANT FAIL", v, e); traceback.print_exc()
    del model; gc.collect(); mx.clear_cache()
