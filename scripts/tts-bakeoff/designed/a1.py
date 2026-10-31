# Approach 1: VoiceDesign with a fixed seed per voice; plus presets from CustomVoice. Usage: a1.py design|preset
import sys; sys.path.insert(0,"/tmp/squeak-designed-voices")
from common import *
import mlx.core as mx
from mlx_audio.tts.utils import load_model
which=sys.argv[1]
stats=json.load(open(OUT+"/stats.json")) if os.path.exists(OUT+"/stats.json") else {}
if which=="design":
    model=load_model(VD)
    for vname,desc in VOICES.items():
        for level in ("off","strong"):
            for ln in LINES:
                mood=LINE_MOOD[ln["id"]]
                inst=desc if level=="off" else desc+" "+INSTRUCT[mood]["strong"]
                mx.random.seed(1234)
                mx.reset_peak_memory(); t=time.time()
                a,r=collect(model.generate(text=ln["text"],instruct=inst,lang_code="en",verbose=False))
                dt=time.time()-t
                p=f"{OUT}/a1/{vname}/{level}/{ln['id']}.wav"; write_wav(p,a,r)
                stats[p]={"s":dt,"peak_gb":mx.get_peak_memory()/1e9}
                print(p,round(dt,1),flush=True)
        json.dump(stats,open(OUT+"/stats.json","w"))
else:
    model=load_model(CV)
    for sp in PRESETS:
        for level in ("off","strong"):
            for ln in LINES:
                mood=LINE_MOOD[ln["id"]]
                kw={"voice":sp,"lang_code":"en","verbose":False}
                if level=="strong": kw["instruct"]=INSTRUCT[mood]["strong"]
                mx.random.seed(1234)
                mx.reset_peak_memory(); t=time.time()
                a,r=collect(model.generate(text=ln["text"],**kw)); dt=time.time()-t
                p=f"{OUT}/preset/{sp}/{level}/{ln['id']}.wav"; write_wav(p,a,r)
                stats[p]={"s":dt,"peak_gb":mx.get_peak_memory()/1e9}
                print(p,round(dt,1),flush=True)
        json.dump(stats,open(OUT+"/stats.json","w"))
