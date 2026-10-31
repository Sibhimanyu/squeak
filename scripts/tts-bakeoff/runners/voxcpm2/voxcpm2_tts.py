import sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from scout_common import *
import mlx.core as mx
from mlx_audio.tts.utils import load_model

REPO = "mlx-community/VoxCPM2-bf16"  # Apache-2.0
t0 = time.time(); model = load_model(REPO); LOAD = round(time.time() - t0, 2)

STYLE = {
    "01-greeting": "friendly and bright, a little urgent, brisk pace",
    "02-blocked": "urgent and concerned, serious, quick pace",
    "03-done": "cheerful and pleased, upbeat, smiling",
    "04-options": "neutral, calm and clear, even pace",
    "05-wrong-pin": "gentle and apologetic, soft, slightly slow",
    "06-taking-while": "warm and reassuring, relaxed, comforting",
    "07-failed": "disappointed but sympathetic, soft, a little downcast",
    "08-callback": "warm and upbeat, friendly, cheerful goodbye",
}


def gen(text, **kw):
    mx.random.seed(7)
    return first_audio(model.generate(text=text, **kw))


def design(ln):
    a, sr = gen(ln["text"], instruct="A young woman, " + STYLE[ln["id"]]); return a, sr, f"({'A young woman, ' + STYLE[ln['id']]}){ln['text']}"


def clone_styled(ln):
    a, sr = gen(ln["text"], ref_audio=REF_WAV, instruct=STYLE[ln["id"]]); return a, sr, f"({STYLE[ln['id']]}){ln['text']}"


def clone_plain(ln):
    a, sr = gen(ln["text"], ref_audio=REF_WAV); return a, sr, ln["text"]


M = "VoxCPM2 2B (mlx-audio bf16)"
for name, fn, notes in [
    ("voxcpm2-design-emotion", design, "Voice design: '(A young woman, <delivery description>)text' per line, no reference."),
    ("voxcpm2-clone-styled", clone_styled, "Clone of ROOT/ref.wav plus the per-line '(<delivery description>)' prefix."),
    ("voxcpm2-clone-plain", clone_plain, "Clone of ROOT/ref.wav only (baseline)."),
]:
    V = Variant(name, M, "mlx", notes); V.meta["load_seconds"] = LOAD
    try:
        V.run(fn); V.save()
    except Exception as e:
        print("FAILED", name, repr(e), flush=True)
