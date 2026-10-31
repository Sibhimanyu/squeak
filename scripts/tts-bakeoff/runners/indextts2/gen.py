import json, os, sys, time, wave
root, src, ck = sys.argv[1:4]
sys.path.insert(0, src)
import torch
from indextts.infer_v2 import IndexTTS2

device = "mps" if torch.backends.mps.is_available() else "cpu"
force = os.environ.get("INDEXTTS_DEVICE")
if force: device = force
lines = json.load(open(f"{root}/lines.json"))
ref = f"{root}/ref.wav"

# order: happy, angry, sad, afraid, disgusted, melancholic, surprised, calm
VEC = {
 "01-greeting":   [0.6, 0, 0, 0, 0, 0, 0.3, 0.2],
 "02-blocked":    [0, 0, 0, 0.5, 0, 0, 0.3, 0.1],
 "03-done":       [0.8, 0, 0, 0, 0, 0, 0.3, 0],
 "04-options":    [0, 0, 0, 0, 0, 0, 0, 0.8],
 "05-wrong-pin":  [0, 0, 0.3, 0, 0, 0.3, 0, 0.4],
 "06-taking-while":[0.3, 0, 0, 0, 0, 0, 0, 0.7],
 "07-failed":     [0, 0, 0.6, 0, 0, 0.6, 0, 0.1],
 "08-callback":   [0.7, 0, 0, 0, 0, 0, 0.2, 0.3],
}
variants = {
 "indextts2-clone-plain": dict(
   notes="IndexTTS2 (IndexTeam/IndexTTS-2), voice cloned from ref.wav; no emotion control (emotion taken from the speaker reference only).",
   kw=lambda l: {}),
 "indextts2-clone-emotext": dict(
   notes="Voice cloned from ref.wav; emotion from the line's 'emotion' field via IndexTTS2 text-to-emotion (QwenEmotion -> 8-d vector), use_emo_text=True, emo_alpha=0.6.",
   kw=lambda l: dict(use_emo_text=True, emo_text=l["emotion"], emo_alpha=0.6)),
 "indextts2-clone-emovec": dict(
   notes="Voice cloned from ref.wav; hand-set emotion vector per line [happy,angry,sad,afraid,disgusted,melancholic,surprised,calm], emo_alpha=1.0 (weights are moderate). Vectors: " + "; ".join(f"{k}={v}" for k, v in VEC.items()),
   kw=lambda l: dict(emo_vector=VEC[l["id"]], emo_alpha=1.0)),
}

t0 = time.perf_counter()
tts = IndexTTS2(cfg_path=f"{ck}/config.yaml", model_dir=ck, use_fp16=(device != "cpu"), device=device,
                use_cuda_kernel=False, use_deepspeed=False, use_qwen_emo=True)
load_s = time.perf_counter() - t0
print("loaded", device, load_s, flush=True)

def infer(text, out, **kw):
    tts.infer(spk_audio_prompt=ref, text=text, output_path=out, verbose=False, **kw)
    if device == "mps": torch.mps.synchronize()

warm = "/tmp/indextts2-warm.wav"
infer("Warm up line.", warm)
infer("Warm up line.", warm, use_emo_text=True, emo_text="calm", emo_alpha=0.6)

for name, v in variants.items():
    od = f"{root}/out/{name}"; os.makedirs(od, exist_ok=True)
    res = []
    for l in lines:
        out = f"{od}/{l['id']}.wav"
        t = time.perf_counter()
        infer(l["text"], out, **v["kw"](l))
        g = time.perf_counter() - t
        with wave.open(out) as w: dur = w.getnframes() / w.getframerate()
        res.append(dict(id=l["id"], gen_seconds=round(g, 2), audio_seconds=round(dur, 2), spoken_text=l["text"]))
        print(name, l["id"], round(g, 2), round(dur, 2), flush=True)
    json.dump(dict(model="IndexTTS2", variant=name, device=device, notes=v["notes"],
                   load_seconds=round(load_s, 2), lines=res), open(f"{od}/timings.json", "w"), indent=2)
