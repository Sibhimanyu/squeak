# Setup step: one VoiceDesign reference clip per designed voice (neutral) and one per mood.
import sys; sys.path.insert(0,"/tmp/squeak-designed-voices")
from common import *
import mlx.core as mx
from mlx_audio.tts.utils import load_model
REF_TEXT="Hi, it's Squeak. I took a look at the project, and I have a short update for you. Tell me how you would like to go on."
model=load_model(VD); meta={}
for v,desc in VOICES.items():
    for mood in ["neutral","urgent","cheerful","apologetic","sympathetic","warm"]:
        inst=desc if mood=="neutral" else desc+" "+INSTRUCT[mood]["strong"]
        mx.random.seed(1234); mx.reset_peak_memory(); t=time.time()
        a,r=collect(model.generate(text=REF_TEXT,instruct=inst,lang_code="en",verbose=False))
        p=f"{OUT}/refs/{v}/{mood}.wav"; write_wav(p,a,r); meta[p]={"s":time.time()-t,"dur":len(a)/r}
        print(p,meta[p],flush=True)
json.dump({"text":REF_TEXT,"clips":meta},open(OUT+"/refs/meta.json","w"),indent=1)
