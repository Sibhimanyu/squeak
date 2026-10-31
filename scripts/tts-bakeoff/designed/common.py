import json, os, sys, time, wave
import numpy as np
os.environ["HF_HUB_DISABLE_XET"]="1"
ROOT="/Users/sibhi-zstch1643/conductor/workspaces/squeak/ushuaia"
M=ROOT+"/.context/tts-bakeoff/envs/models"
CV=M+"/Qwen3-TTS-12Hz-1.7B-CustomVoice-8bit"
BASE=M+"/Qwen3-TTS-12Hz-1.7B-Base-8bit"
VD=open("/tmp/squeak-designed-voices/vd_path").read().strip()
OUT="/tmp/squeak-designed-voices/out"
LINES=json.load(open(ROOT+"/.context/tts-bakeoff/lines.json"))
LINE_MOOD={"01-greeting":"warm","02-blocked":"urgent","03-done":"cheerful","04-options":"neutral","05-wrong-pin":"apologetic","06-taking-while":"warm","07-failed":"sympathetic","08-callback":"cheerful"}
INSTRUCT={
 "neutral":{"subtle":"Speak clearly and calmly, at an even pace.","strong":"Speak in a very clear, steady, matter-of-fact voice, like reading out a menu."},
 "urgent":{"subtle":"Speak in a concerned voice, a little quicker, like giving an important heads-up.","strong":"Speak in an urgent, serious voice, quick and tense, like giving an important warning."},
 "cheerful":{"subtle":"Speak in a pleased, upbeat voice.","strong":"Speak in a delighted, cheerful voice, bright and proud of the result."},
 "apologetic":{"subtle":"Speak in a gentle, apologetic voice, a little slower.","strong":"Speak in a soft, sincerely apologetic voice, slow and kind."},
 "sympathetic":{"subtle":"Speak in a sympathetic voice, a little softer.","strong":"Speak in a disappointed but sympathetic voice, downcast and soft."},
 "warm":{"subtle":"Speak in a warm, reassuring voice.","strong":"Speak in a very warm, relaxed, smiling voice, comforting and friendly."},
}
VOICES={
 "warm_us_woman":"A warm, friendly American woman in her early thirties with a natural, mid-pitched, smooth voice. Clear diction, relaxed and approachable.",
 "calm_uk_man":"A calm, deep British man in his forties with a low-pitched, steady, resonant voice and a refined southern English accent. Clear diction, unhurried.",
 "friendly_in_woman":"A friendly Indian-English woman in her late twenties with a bright, mid-pitched voice and a clear, natural Indian English accent. Warm and articulate.",
 "energetic_us_man":"An energetic young American man in his early twenties with a bright, mid-to-high-pitched voice, quick and enthusiastic, clear diction.",
}
PRESETS=["aiden","ryan"]
def write_wav(path, audio, rate=24000):
    a=np.asarray(audio,dtype=np.float32).reshape(-1)
    if rate!=24000:
        from math import gcd; from scipy.signal import resample_poly
        g=gcd(24000,rate); a=resample_poly(a,24000//g,rate//g).astype(np.float32)
    pcm=(np.clip(a,-1,1)*32767).astype("<i2")
    os.makedirs(os.path.dirname(path),exist_ok=True)
    with wave.open(path,"wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(24000); w.writeframes(pcm.tobytes())
def collect(gen):
    ch=[]; rate=24000
    for r in gen:
        ch.append(np.array(r.audio,dtype=np.float32).reshape(-1)); rate=r.sample_rate
    return np.concatenate(ch), rate
def read_wav(path):
    with wave.open(path) as w:
        return np.frombuffer(w.readframes(w.getnframes()),dtype="<i2").astype(np.float32)/32768
