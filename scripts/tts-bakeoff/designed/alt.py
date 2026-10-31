import sys; sys.path.insert(0,"/tmp/squeak-designed-voices")
from common import *
import mlx.core as mx
from mlx_audio.tts.utils import load_model
ALT={"energetic2":"A young American man in his early twenties with a clear tenor voice, mid-pitched and natural. Friendly, lively and upbeat, with clear diction.",
     "energetic3":"A young adult American male voice, clear and bright, slightly nasal tenor, confident and cheerful, medium-fast pace, crisp diction."}
REF_TEXT=json.load(open(OUT+"/refs/meta.json"))["text"]
vd=load_model(VD)
for v,d in ALT.items():
    mx.random.seed(1234); a,r=collect(vd.generate(text=REF_TEXT,instruct=d,lang_code="en",verbose=False)); write_wav(f"{OUT}/refs/{v}/neutral.wav",a,r)
del vd
base=load_model(BASE); cv=load_model(CV)
cfg=cv.config.talker_config; SLOT=cfg.vocab_size-1; cfg.spk_id["designed"]=SLOT; cv.supported_speakers.append("designed")
w=cv.talker.get_input_embeddings().weight
for v in ALT:
    w[SLOT]=base.extract_speaker_embedding(mx.array(read_wav(f"{OUT}/refs/{v}/neutral.wav"))).reshape(-1).astype(w.dtype); mx.eval(w)
    for level in ("off","strong"):
        for ln in LINES:
            mood=LINE_MOOD[ln["id"]]; kw={"voice":"designed","lang_code":"en","verbose":False}
            if level=="strong": kw["instruct"]=INSTRUCT[mood]["strong"]
            mx.random.seed(1234); mx.reset_peak_memory(); t=time.time()
            a,r=collect(cv.generate(text=ln["text"],**kw)); write_wav(f"{OUT}/a2alt_cv/{v}/{level}/{ln['id']}.wav",a,r)
