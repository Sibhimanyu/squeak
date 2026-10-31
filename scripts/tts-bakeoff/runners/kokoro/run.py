import json, os, sys, time, wave
import numpy as np
from kokoro_onnx import Kokoro
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
D = os.path.expanduser("~/Library/Application Support/squeak/voice-tts")
lines = json.load(open(f"{ROOT}/lines.json"))
variant = "kokoro-af_heart"
out = f"{ROOT}/out/{variant}"; os.makedirs(out, exist_ok=True)
t = time.time(); k = Kokoro(f"{D}/kokoro.onnx", f"{D}/voices.bin"); load = time.time() - t
def gen(text): return k.create(text, voice="af_heart", speed=1.0, lang="en-us")
gen("Warm up line.")
res = []
for l in lines:
    t = time.time(); s, sr = gen(l["text"]); g = time.time() - t
    pcm = (np.clip(s, -1, 1) * 32767).astype("<i2")
    with wave.open(f"{out}/{l['id']}.wav", "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr); w.writeframes(pcm.tobytes())
    res.append({"id": l["id"], "gen_seconds": round(g, 3), "audio_seconds": round(len(pcm) / sr, 3), "spoken_text": l["text"]})
json.dump({"model": "kokoro-onnx (Kokoro-82M)", "variant": variant, "device": "cpu (onnxruntime)",
  "notes": "Kokoro has no emotion control; voice af_heart, speed 1.0, lang en-us, same text for every line. This is Squeak's current voice.",
  "load_seconds": round(load, 3), "lines": res}, open(f"{out}/timings.json", "w"), indent=2)
print(variant, "done")
