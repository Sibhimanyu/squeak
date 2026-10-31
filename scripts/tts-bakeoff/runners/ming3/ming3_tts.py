import sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from scout_common import *
from mlx_audio.tts.utils import load_model
from mlx_audio.tts.models.bailingmm.bailingmm import ming3_instruction

REPO = "mlx-community/Ming-3.0-tts-0.5B-bf16"
t0 = time.time(); model = load_model(REPO); LOAD = round(time.time() - t0, 2)

# Ming-3.0 emotion keys are Chinese: 高兴 happy / 悲伤 sad / 愤怒 angry / 恐惧 fear / 厌恶 disgust / 惊讶 surprise / 中性 neutral
# speed 慢速/中速/快速, pitch & volume 低/中/高
CTRL = {
    "01-greeting": dict(emotion="高兴", speed="快速"),
    "02-blocked": dict(emotion="恐惧", speed="快速", pitch="高"),
    "03-done": dict(emotion="高兴", pitch="高"),
    "04-options": dict(emotion="中性", speed="中速"),
    "05-wrong-pin": dict(emotion="悲伤", speed="慢速", volume="低"),
    "06-taking-while": dict(emotion="中性", speed="慢速"),
    "07-failed": dict(emotion="悲伤", speed="中速"),
    "08-callback": dict(emotion="高兴", speed="中速"),
}
FREEFORM = {
    "01-greeting": "Speak in a friendly, bright female voice, a little urgent, at a brisk pace.",
    "02-blocked": "Speak in a concerned, urgent female voice, quick and serious, like giving an important heads-up.",
    "03-done": "Speak in a cheerful, pleased female voice, upbeat and proud of the result.",
    "04-options": "Speak in a calm, neutral, clear female voice, evenly paced like reading out a menu.",
    "05-wrong-pin": "Speak in a gentle, apologetic female voice, soft and kind, slightly slower.",
    "06-taking-while": "Speak in a warm, reassuring female voice, relaxed and comforting.",
    "07-failed": "Speak in a disappointed but sympathetic female voice, a little downcast, softer.",
    "08-callback": "Speak in a warm, upbeat female voice, friendly and smiling, cheerful goodbye.",
}


def g(**kw):
    r = first_audio(model.generate(**kw))
    return r


def clone_emotion(ln):
    a, sr = g(text=ln["text"], instruct=ming3_instruction(**CTRL[ln["id"]]), ref_audio=REF_WAV, ref_text=REF_TXT)
    return a, sr, ln["text"]


def clone_plain(ln):
    a, sr = g(text=ln["text"], ref_audio=REF_WAV, ref_text=REF_TXT)
    return a, sr, ln["text"]


def emma_emotion(ln):
    a, sr = g(text=ln["text"], instruct=ming3_instruction(ip="US_Emma", **CTRL[ln["id"]]))
    return a, sr, ln["text"]


def freeform(ln):
    a, sr = g(text=ln["text"], instruct=FREEFORM[ln["id"]], use_zero_spk_emb=True)
    return a, sr, ln["text"]


M = "Ming-3.0-tts 0.5B (mlx-audio bf16)"
for name, fn, notes in [
    ("ming3-clone-emotion", clone_emotion, "Clone of ROOT/ref.wav + per-line Ming3 JSON caption: emotion (高兴/悲伤/恐惧/中性) + speed/pitch/volume levels."),
    ("ming3-clone-plain", clone_plain, "Clone of ROOT/ref.wav, no caption (baseline)."),
    ("ming3-usemma-emotion", emma_emotion, "Built-in voice US_Emma (ip caption) with the same per-line emotion/speed/pitch caption as clone-emotion."),
    ("ming3-freeform", freeform, "Voice design: English freeform delivery sentence per line, zero speaker embedding (voice is whatever the instruction yields)."),
]:
    V = Variant(name, M, "mlx", notes); V.meta["load_seconds"] = LOAD
    try:
        V.run(fn); V.save()
    except Exception as e:
        print("FAILED", name, repr(e), flush=True)
