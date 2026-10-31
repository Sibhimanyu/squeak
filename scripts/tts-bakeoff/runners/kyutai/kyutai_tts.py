import json, sys, time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from scout_common import *
import mlx.core as mx, mlx.nn as nn, numpy as np, sentencepiece
from moshi_mlx import models
from moshi_mlx.models.tts import DEFAULT_DSM_TTS_REPO, DEFAULT_DSM_TTS_VOICE_REPO, TTSModel
from moshi_mlx.utils.loaders import hf_get

PLAIN_VOICE = "unmute-prod-website/default_voice.wav"  # Kyutai's own recording, CC0
# Expresso speaker ex03 (CC-BY-NC): one speaker, many styles. Line -> style clip.
EXPRESSO = {
    "01-greeting": "expresso/ex03-ex01_happy_001_channel1_334s.wav",
    "02-blocked": "expresso/ex03-ex01_confused_001_channel1_909s.wav",
    "03-done": "expresso/ex03-ex01_happy_001_channel2_257s.wav",
    "04-options": "expresso/ex03-ex02_narration_001_channel1_674s.wav",
    "05-wrong-pin": "expresso/ex03-ex02_sad-sympathetic_001_channel1_454s.wav",
    "06-taking-while": "expresso/ex03-ex01_calm_001_channel1_1143s.wav",
    "07-failed": "expresso/ex03-ex02_sympathetic-sad_008_channel1_215s.wav",
    "08-callback": "expresso/ex03-ex01_happy_001_channel2_257s.wav",
}

t0 = time.time()
mx.random.seed(299792458)
repo = DEFAULT_DSM_TTS_REPO
cfgp = hf_get("config.json", repo)
raw = json.load(open(hf_get(cfgp)))
mimi_w = hf_get(hf_get(raw["mimi_name"], repo))
moshi_w = hf_get(hf_get(raw.get("moshi_name", "model.safetensors"), repo))
tok = hf_get(hf_get(raw["tokenizer_name"], repo))
lm_config = models.LmConfig.from_config_dict(raw)
lm_config.transformer.max_seq_len = lm_config.transformer.context
model = models.Lm(lm_config)
model.set_dtype(mx.bfloat16)
model.load_pytorch_weights(str(moshi_w), lm_config, strict=True)
text_tok = sentencepiece.SentencePieceProcessor(str(tok))
audio_tok = models.mimi.Mimi(models.mimi_202407(lm_config.generated_codebooks))
audio_tok.load_pytorch_weights(str(mimi_w), strict=True)
tts = TTSModel(model, audio_tok, text_tok, voice_repo=DEFAULT_DSM_TTS_VOICE_REPO, temp=0.6, cfg_coef=1,
               max_padding=8, initial_padding=2, final_padding=2, padding_bonus=0, raw_config=raw)
cfg_cond = None
if tts.valid_cfg_conditionings:
    cfg_cond = tts.cfg_coef; tts.cfg_coef = 1.0
    no_text = no_prefix = False
else:
    no_text = no_prefix = True
mimi = tts.mimi
LOAD = time.time() - t0


def synth(text, voice):
    entries = tts.prepare_script([text], padding_between=1)
    attrs = [tts.make_condition_attributes([tts.get_voice_path(voice)], cfg_cond)]
    res = tts.generate([entries], attrs, prefixes=None, cfg_is_no_prefix=no_prefix, cfg_is_no_text=no_text)
    frames = res.frames
    wavs = mx.concat([mimi.decode_step(f) for f in frames], axis=-1)
    end = res.end_steps[0]
    n = wavs.shape[-1] if end is None else int(mimi.sample_rate * (end + tts.final_padding) / mimi.frame_rate)
    return np.array(mx.clip(wavs[0, 0, :n], -1, 1)), mimi.sample_rate


plain_name = "kyutai-defaultvoice-plain"
V1 = Variant(plain_name, "Kyutai TTS 1.6B (en_fr), moshi_mlx bf16", "mlx",
             f"No emotion control: text only, voice embedding {PLAIN_VOICE} (CC0), cfg distilled 1.0 (conditioning), temp 0.6. Seed fixed.")
V2 = Variant("kyutai-expresso-emotion", "Kyutai TTS 1.6B (en_fr), moshi_mlx bf16", "mlx",
             "Per-line Expresso speaker ex03 style clip as voice embedding (happy/confused/narration/sad-sympathetic/calm), "
             "same speaker across lines. Expresso voices are CC-BY-NC (non-commercial). temp 0.6.")
for V in (V1, V2):
    V.meta["load_seconds"] = round(LOAD, 2)
V1.run(lambda ln: (*synth(ln["text"], PLAIN_VOICE), ln["text"]))
V1.save()
V2.run(lambda ln: (*synth(ln["text"], EXPRESSO[ln["id"]].replace(".wav", ".wav") ), ln["text"]))
V2.save()
