import sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from scout_common import *
from mlx_audio.tts.utils import load_model

REPO = "mlx-community/Spark-TTS-0.5B-bf16"
t0 = time.time(); model = load_model(REPO)
model.eval()
model._audio_tokenizer.model.eval()  # ECAPA BatchNorm must run in eval mode (batch of 1)
LOAD = round(time.time() - t0, 2)

# Spark has no emotion knob; the controllable mode only has gender / pitch / speed levels.
# very_low | low | moderate | high | very_high. Crude per-line prosody stand-in for emotion.
CTRL = {
    "01-greeting": ("high", "high"), "02-blocked": ("high", "high"), "03-done": ("high", "moderate"),
    "04-options": ("moderate", "moderate"), "05-wrong-pin": ("low", "low"), "06-taking-while": ("low", "low"),
    "07-failed": ("low", "low"), "08-callback": ("high", "moderate"),
}


def clone(ln):
    r = next(model.generate(text=ln["text"], ref_audio=REF_WAV, ref_text=REF_TXT))
    return to_np(r.audio), r.sample_rate, ln["text"]


LV = {"very_low": 0.0, "low": 0.5, "moderate": 1.0, "high": 1.5, "very_high": 2.0}


def ctrl(ln):
    pitch, speed = (LV[x] for x in CTRL[ln["id"]])
    r = next(model.generate(text=ln["text"], gender="female", pitch=pitch, speed=speed))
    return to_np(r.audio), r.sample_rate, ln["text"]


V = Variant("spark-clone", "Spark-TTS 0.5B (mlx-audio bf16)", "mlx",
            "Zero-shot clone of ROOT/ref.wav + ref.txt; no emotion control exists, delivery follows the reference.")
V.meta["load_seconds"] = LOAD; V.run(clone); V.save()
V = Variant("spark-female-pitchspeed", "Spark-TTS 0.5B (mlx-audio bf16)", "mlx",
            "Controllable mode: gender=female, per-line pitch/speed level (urgent/cheerful = high, apologetic/sad = low, neutral = moderate). "
            "Spark has no true emotion control; this is a crude prosody proxy.")
V.meta["load_seconds"] = LOAD; V.run(ctrl); V.save()
