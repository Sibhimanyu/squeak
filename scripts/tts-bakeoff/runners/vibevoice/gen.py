import json, os, time, wave, resource
import numpy as np
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
from mlx_audio.tts.utils import load
REPO = "gafiatulin/vibevoice-1.5b-mlx"   # fp16 MLX conversion of microsoft/VibeVoice-1.5B (MIT)
CFG, STEPS = 1.5, 10
lines = json.load(open(f"{ROOT}/lines.json"))
t = time.time(); model = load(REPO); load_s = time.time() - t
REF = f"{ROOT}/ref.wav"
def gen(text):
    res = list(model.generate(text=text, ref_audio=REF, cfg_scale=CFG, ddpm_steps=STEPS))
    return np.concatenate([np.array(r.audio).reshape(-1) for r in res]), res[0].sample_rate
variant = "vibevoice-clone"
out = f"{ROOT}/out/{variant}"; os.makedirs(out, exist_ok=True)
gen("Warm up line.")
res = []
for l in lines:
    t = time.time(); a, sr = gen(l["text"]); g = time.time() - t
    pcm = (np.clip(a, -1, 1) * 32767).astype("<i2")
    with wave.open(f"{out}/{l['id']}.wav", "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes(pcm.tobytes())
    res.append({"id": l["id"], "gen_seconds": round(g, 3), "audio_seconds": round(len(pcm) / sr, 3), "spoken_text": l["text"]})
    print(variant, l["id"], round(g, 1), "s for", round(len(pcm) / sr, 1), "s audio", flush=True)
json.dump({"model": "VibeVoice 1.5B (MLX fp16, mlx-audio)", "variant": variant, "device": "mlx",
           "notes": f"Voice clone from ref.wav as the speaker prompt, plain single-speaker text, cfg_scale {CFG}, ddpm_steps {STEPS}. VibeVoice has no emotion control; delivery follows the text's punctuation only.",
           "load_seconds": round(load_s, 3), "lines": res}, open(f"{out}/timings.json", "w"), indent=2)
print("peak RSS GB", resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e9)
