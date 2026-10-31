import re, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from scout_common import *
import mlx.core as mx
from mlx_audio.tts.utils import load_model

REPO = "bosonai/higgs-audio-v3-tts-4b"  # Boson Higgs v3 Research and Non-Commercial licence
t0 = time.time(); model = load_model(REPO); LOAD = round(time.time() - t0, 2)

# Sentence-level tags (PROMPTING.md): emotion (21), prosody speed/pitch/expressive. Prefixed to every sentence of the line.
TAGS = {
    "01-greeting": "<|emotion:enthusiasm|><|prosody:speed_fast|>",
    "02-blocked": "<|emotion:determination|><|prosody:speed_fast|><|prosody:expressive_high|>",
    "03-done": "<|emotion:elation|>",
    "04-options": "<|prosody:expressive_low|>",
    "05-wrong-pin": "<|emotion:shame|><|prosody:speed_slow|>",
    "06-taking-while": "<|emotion:affection|><|prosody:speed_slow|>",
    "07-failed": "<|emotion:sadness|>",
    "08-callback": "<|emotion:contentment|><|prosody:expressive_high|>",
}


def tag(ln):
    sents = re.split(r"(?<=[.!?])\s+", ln["text"])
    return " ".join(TAGS[ln["id"]] + s for s in sents)


def gen(text, **kw):
    mx.random.seed(7)
    return first_audio(model.generate(text=text, temperature=1.0, max_new_tokens=2048, **kw))


def clone_tags(ln):
    t = tag(ln); a, sr = gen(t, ref_audio=REF_WAV, ref_text=REF_TXT); return a, sr, t


def clone_plain(ln):
    a, sr = gen(ln["text"], ref_audio=REF_WAV, ref_text=REF_TXT); return a, sr, ln["text"]


def novoice_tags(ln):
    t = tag(ln); a, sr = gen(t); return a, sr, t


M = "Higgs Audio v3 TTS 4B (mlx-audio, bf16)"
for name, fn, notes in [
    ("higgsv3-clone-tags", clone_tags, "Clone of ROOT/ref.wav + sentence-level <|emotion:..|>/<|prosody:..|> tags on every sentence."),
    ("higgsv3-clone-plain", clone_plain, "Clone of ROOT/ref.wav, no tags (baseline)."),
    ("higgsv3-default-tags", novoice_tags, "No reference (model's default voice) with the same tags."),
]:
    V = Variant(name, M, "mlx", notes + " Licence: research + non-commercial."); V.meta["load_seconds"] = LOAD
    try:
        V.run(fn); V.save()
    except Exception as e:
        print("FAILED", name, repr(e), flush=True)
