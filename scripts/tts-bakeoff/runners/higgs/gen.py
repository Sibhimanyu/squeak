import json, os, sys, time, wave, resource
import numpy as np
ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
from mlx_audio.tts.utils import load
from mlx_audio.tts.models.higgs_audio import serve
from mlx_audio.tts.models.higgs_audio.serve import ReferenceContext
import mlx.core as mx

REPO = "mlx-community/higgs-audio-v2-3B-mlx-q8"
lines = json.load(open(f"{ROOT}/lines.json"))
ref_text = open(f"{ROOT}/ref.txt").read().strip()
t = time.time(); model = load(REPO); load_s = time.time() - t

import soundfile as sf
ref_audio, sr = sf.read(f"{ROOT}/ref.wav", dtype="float32")
if ref_audio.ndim > 1: ref_audio = ref_audio.mean(axis=1)

SCENE = {"text": ""}
_orig = serve.encode_reference
def encode_reference(ref_audio_24k, ref_text, *, config, tokenizer, codec, embed_tokens, audio_codebook_embeddings):
    """Same as upstream, but with Higgs v2's system turn carrying the scene description when SCENE is set."""
    ctx = _orig(ref_audio_24k, ref_text, config=config, tokenizer=tokenizer, codec=codec,
                embed_tokens=embed_tokens, audio_codebook_embeddings=audio_codebook_embeddings)
    if not SCENE["text"]:
        return ctx
    sysmsg = ("<|begin_of_text|><|start_header_id|>system<|end_header_id|>\n\n"
              "Generate audio following instruction.\n\n<|scene_desc_start|>\n" + SCENE["text"] +
              "\n<|scene_desc_end|><|eot_id|>")
    # upstream prefix starts with <|begin_of_text|>; swap it for system turn + the same user/assistant turns
    prefix = (sysmsg + "<|start_header_id|>user<|end_header_id|>\n\n" + (ref_text or "") + "<|eot_id|>"
              "<|start_header_id|>assistant<|end_header_id|>\n\n<|audio_out_bos|>")
    ids = tokenizer.encode(prefix, add_special_tokens=False)
    emb = embed_tokens(mx.array([ids], dtype=mx.int32))[0]
    mx.eval(emb)
    return ReferenceContext(prefix_emb=emb, audio_emb=ctx.audio_emb, prefix_len=len(ids),
                            T_ref_delayed=ctx.T_ref_delayed, T_ref=ctx.T_ref, ref_text=ctx.ref_text)
serve.encode_reference = encode_reference

BASE = ("A friendly, competent phone assistant named Squeak speaks to its owner over a phone call. "
        "Voice: clear, natural, conversational, not robotic, not theatrical. Quiet room, close microphone.")

def gen(text, scene):
    SCENE["text"] = scene
    res = list(model.generate(text=text, ref_audio=ref_audio, ref_text=ref_text, temperature=0.7, top_p=0.95))
    a = np.concatenate([np.array(r.audio).reshape(-1) for r in res]); return a, res[0].sample_rate

def run(variant, notes, scene_for):
    out = f"{ROOT}/out/{variant}"; os.makedirs(out, exist_ok=True)
    gen("Warm up line.", scene_for({"emotion": "neutral"}))
    res = []
    for l in lines:
        t = time.time(); a, sr_ = gen(l["text"], scene_for(l)); g = time.time() - t
        pcm = (np.clip(a, -1, 1) * 32767).astype("<i2")
        with wave.open(f"{out}/{l['id']}.wav", "wb") as w:
            w.setnchannels(1); w.setsampwidth(2); w.setframerate(sr_); w.writeframes(pcm.tobytes())
        res.append({"id": l["id"], "gen_seconds": round(g, 3), "audio_seconds": round(len(pcm) / sr_, 3),
                    "spoken_text": l["text"] if not scene_for(l) else f"[scene: {scene_for(l)}] {l['text']}"})
        print(variant, l["id"], round(g, 1), "s for", round(len(pcm) / sr_, 1), "s audio", flush=True)
    json.dump({"model": "Higgs Audio v2 3B (MLX q8, mlx-audio)", "variant": variant, "device": "mlx",
               "notes": notes, "load_seconds": round(load_s, 3), "lines": res}, open(f"{out}/timings.json", "w"), indent=2)

run("higgs-clone", "Voice clone from ref.wav + ref.txt (mlx-audio ChatML clone prompt), no scene/system prompt, temperature 0.7, top_p 0.95. Higgs has no emotion knob; emotion is left to the text.",
    lambda l: "")
run("higgs-clone-scene", "Same clone prompt, plus a system turn with a Higgs v2 <|scene_desc_start|> scene: " + BASE + " Per line: 'Delivery: <line emotion>.' Spoken words unchanged (scene is not spoken).",
    lambda l: BASE + f" Delivery: {l['emotion']}.")
print("peak RSS GB", resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 1e9)
