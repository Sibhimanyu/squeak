/**
 * The Python workers of the three expressive engines (voice-engines.ts), all on mlx-audio: they run on the Mac's GPU
 * from weights in their own folder and never reach the network (`HF_HUB_OFFLINE`). Written to the engine's folder by
 * its setup, so a daemon bundled in the Mac app needs no checkout. Same protocol as Kokoro's worker
 * (natural-worker.ts) with two more request fields:
 *   in : {"id": 1, "text": "...", "voice": "ryan", "speed": 1.0, "out": "/tmp/x.wav", "mood": "urgent", "level": "subtle"}
 *   out: {"id": 1, "ok": true, "ms": 1234}   or   {"id": 1, "ok": false, "error": "..."}
 * `mood` is urgent | cheerful | apologetic | sympathetic | warm | neutral and `level` off | subtle | strong
 * (voice-mood.ts); `off` always arrives as neutral. Every worker writes a 24 kHz mono 16-bit WAV whatever the model's
 * own rate is, so the daemon's telephone filter and cache see one format. argv: <model folder> <engine folder>.
 */

/** First line of every MLX worker: a script that starts with it is Squeak's own, and is replaced when Squeak's changes. */
export const WORKER_MARKER = "# Squeak voice worker: written by Squeak and replaced when it updates.";

const PRELUDE = `${WORKER_MARKER}
import json
import os
import sys
import time
import wave

os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"

# Only the protocol's JSON lines may reach the daemon: mlx-audio and its libraries print progress ("Initialized
# encoder codebooks", "Loaded English tokenizer") to stdout, from Python and from C. The real stdout is kept for the
# protocol and everything else, file descriptor 1 included, goes to stderr.
_protocol = os.fdopen(os.dup(1), "w")
os.dup2(2, 1)
sys.stdout = sys.stderr


def reply(message):
    _protocol.write(json.dumps(message) + "\\n")
    _protocol.flush()

import numpy as np

RATE = 24000


def to_pcm24k(audio, rate):
    samples = np.array(audio, dtype=np.float32).reshape(-1)
    if int(rate) != RATE:
        from math import gcd

        from scipy.signal import resample_poly

        divisor = gcd(RATE, int(rate))
        samples = resample_poly(samples, RATE // divisor, int(rate) // divisor).astype(np.float32)
    return (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")


def collect(results):
    chunks = []
    rate = RATE
    for result in results:
        chunks.append(np.array(result.audio, dtype=np.float32).reshape(-1))
        rate = result.sample_rate
    if not chunks:
        raise RuntimeError("the model made no audio")
    return np.concatenate(chunks), rate


def serve(make):
    reply({"ready": True})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request = {}
        try:
            request = json.loads(line)
            began = time.time()
            audio, rate = make(request)
            pcm = to_pcm24k(audio, rate)
            with wave.open(request["out"], "wb") as out:
                out.setnchannels(1)
                out.setsampwidth(2)
                out.setframerate(RATE)
                out.writeframes(pcm.tobytes())
            reply({"id": request.get("id"), "ok": True, "ms": int((time.time() - began) * 1000)})
        except Exception as error:
            reply({"id": request.get("id"), "ok": False, "error": str(error)[:300]})


`;

/** Qwen3-TTS CustomVoice (Apache-2.0): a preset speaker, and the mood as an English instruction sentence. */
export const QWEN3_WORKER_PY = `${PRELUDE}from mlx_audio.tts.utils import load_model

INSTRUCT = {
    "neutral": {
        "subtle": "Speak clearly and calmly, at an even pace.",
        "strong": "Speak in a very clear, steady, matter-of-fact voice, like reading out a menu.",
    },
    "urgent": {
        "subtle": "Speak in a concerned voice, a little quicker, like giving an important heads-up.",
        "strong": "Speak in an urgent, serious voice, quick and tense, like giving an important warning.",
    },
    "cheerful": {
        "subtle": "Speak in a pleased, upbeat voice.",
        "strong": "Speak in a delighted, cheerful voice, bright and proud of the result.",
    },
    "apologetic": {
        "subtle": "Speak in a gentle, apologetic voice, a little slower.",
        "strong": "Speak in a soft, sincerely apologetic voice, slow and kind.",
    },
    "sympathetic": {
        "subtle": "Speak in a sympathetic voice, a little softer.",
        "strong": "Speak in a disappointed but sympathetic voice, downcast and soft.",
    },
    "warm": {
        "subtle": "Speak in a warm, reassuring voice.",
        "strong": "Speak in a very warm, relaxed, smiling voice, comforting and friendly.",
    },
}


def designed_voices(model):
    """Squeak's designed voices (qwen3-designed-voices.ts): one speaker embedding each, put in a spare row of the
    speaker table when asked for, so emotion instructions work as for the presets."""
    path = os.path.join(sys.argv[2], "designed-voices.json")
    if not os.path.exists(path):
        return lambda voice: voice
    import base64

    import mlx.core as mx

    with open(path) as handle:
        embeddings = json.load(handle)
    config = model.config.talker_config
    slot = config.vocab_size - 1
    config.spk_id["designed"] = slot
    if "designed" not in model.supported_speakers:
        model.supported_speakers.append("designed")
    table = model.talker.get_input_embeddings()
    current = [None]

    def speaker(voice):
        if voice not in embeddings:
            return voice
        if current[0] != voice:
            vector = np.frombuffer(base64.b64decode(embeddings[voice]), dtype="<f4")
            weight = table.weight
            weight[slot] = mx.array(vector).astype(weight.dtype)
            mx.eval(weight)
            current[0] = voice
        return "designed"

    return speaker


def main():
    model = load_model(sys.argv[1])
    speaker = designed_voices(model)

    def make(request):
        mood = request.get("mood", "neutral")
        level = request.get("level", "off")
        options = {"voice": speaker(request.get("voice", "aiden")), "lang_code": "en", "verbose": False}
        if level in ("subtle", "strong"):
            options["instruct"] = INSTRUCT.get(mood, INSTRUCT["neutral"])[level]
        return collect(model.generate(text=request["text"], **options))

    serve(make)


main()
`;

/** Ming-3.0 TTS (MIT): a built-in voice named by an IP caption, the mood as Ming's emotion keys and speed/pitch levels. */
export const MING_WORKER_PY = `${PRELUDE}from mlx_audio.tts.models.bailingmm.bailingmm import ming3_instruction
from mlx_audio.tts.utils import load_model

# Ming's caption keys are Chinese: emotion 高兴 happy, 悲伤 sad, 恐惧 fear, 中性 neutral; speed 慢速 slow, 中速 medium,
# 快速 fast; pitch and volume 低 low, 中 medium, 高 high.
CONTROLS = {
    "neutral": {
        "subtle": dict(emotion="中性", speed="中速"),
        "strong": dict(emotion="中性", speed="中速"),
    },
    "urgent": {
        "subtle": dict(emotion="中性", speed="快速"),
        "strong": dict(emotion="恐惧", speed="快速", pitch="高"),
    },
    "cheerful": {
        "subtle": dict(emotion="高兴", speed="中速"),
        "strong": dict(emotion="高兴", speed="快速", pitch="高"),
    },
    "apologetic": {
        "subtle": dict(emotion="中性", speed="慢速"),
        "strong": dict(emotion="悲伤", speed="慢速", volume="低"),
    },
    "sympathetic": {
        "subtle": dict(emotion="中性", speed="慢速"),
        "strong": dict(emotion="悲伤", speed="中速"),
    },
    "warm": {
        "subtle": dict(emotion="中性", speed="中速"),
        "strong": dict(emotion="高兴", speed="中速"),
    },
}


def main():
    model = load_model(sys.argv[1])

    def make(request):
        mood = request.get("mood", "neutral")
        level = request.get("level", "off")
        controls = CONTROLS.get(mood, CONTROLS["neutral"]).get(level, {}) if level in ("subtle", "strong") else {}
        caption = ming3_instruction(ip=request.get("voice", "US_Emma"), **controls)
        return collect(model.generate(text=request["text"], instruct=caption, use_zero_spk_emb=True, verbose=False))

    serve(make)


main()
`;

/**
 * Chatterbox (MIT): a clone of a short reference clip (made with Kokoro at setup, in \`<engine folder>/refs\`), the mood
 * as exaggeration and cfg_weight. Its speech tokenizer is a second repo, kept in \`<engine folder>/s3tokenizer\`.
 */
export const CHATTERBOX_WORKER_PY = `${PRELUDE}import huggingface_hub
from mlx_audio.tts.utils import load_model

# (exaggeration, cfg_weight) by mood and level: the calm moods stay near neutral, the lively ones go further.
LIVELY = {"subtle": (0.7, 0.4), "strong": (0.9, 0.3)}
CALM = {"subtle": (0.6, 0.45), "strong": (0.7, 0.4)}
SETTINGS = {
    "urgent": LIVELY,
    "cheerful": LIVELY,
    "apologetic": CALM,
    "sympathetic": CALM,
    "warm": CALM,
}


def main():
    folder = sys.argv[2]
    tokenizer = os.path.join(folder, "s3tokenizer")
    real_download = huggingface_hub.snapshot_download

    def local_download(repo_id=None, *args, **kwargs):
        # The speech tokenizer is fetched by name at load: answer from the engine's own folder instead.
        if str(repo_id).endswith("S3TokenizerV2"):
            return tokenizer
        return real_download(repo_id, *args, **kwargs)

    huggingface_hub.snapshot_download = local_download
    model = load_model(sys.argv[1])
    conditionals = {}

    def make(request):
        voice = request.get("voice", "af_heart")
        mood = request.get("mood", "neutral")
        level = request.get("level", "off")
        exaggeration, cfg = SETTINGS.get(mood, {}).get(level, (0.5, 0.5))
        if voice not in conditionals:
            clip = os.path.join(folder, "refs", voice + ".wav")
            if not os.path.exists(clip):
                raise RuntimeError("no reference clip for " + voice)
            conditionals[voice] = model.prepare_conditionals(clip, 24000, 0.5)
        return collect(
            model.generate(
                text=request["text"],
                conds=conditionals[voice],
                exaggeration=exaggeration,
                cfg_weight=cfg,
                verbose=False,
            )
        )

    serve(make)


main()
`;

/** Makes Chatterbox's reference clips with Kokoro (run by Kokoro's own Python): argv model, voices, folder, text, ids... */
export const REFERENCE_CLIPS_PY = `import os
import sys
import wave

import numpy as np
from kokoro_onnx import Kokoro

model, voices, folder, text = sys.argv[1:5]
kokoro = Kokoro(model, voices)
os.makedirs(folder, exist_ok=True)
for voice in sys.argv[5:]:
    samples, rate = kokoro.create(text, voice=voice, speed=1.0, lang="en-us")
    pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
    with wave.open(os.path.join(folder, voice + ".wav"), "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(rate)
        out.writeframes(pcm.tobytes())
`;

/** What the reference clips say: about eight seconds of plain, even speech. */
export const REFERENCE_TEXT =
  "I checked the logs this morning, and everything looks fine. The new build is faster, the tests are green, and I think we can ship it after lunch.";
