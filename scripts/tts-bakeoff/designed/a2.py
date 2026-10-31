# usage: a2.py icl|xvec|cv|moodicl
import sys; sys.path.insert(0,"/tmp/squeak-designed-voices")
from common import *
import mlx.core as mx
from mlx_audio.tts.utils import load_model
mode=sys.argv[1]
REF_TEXT=json.load(open(OUT+"/refs/meta.json"))["text"]
stats=json.load(open(OUT+"/stats.json")) if os.path.exists(OUT+"/stats.json") else {}
model=load_model(CV if mode=="cv" else BASE)
def ref(v,mood): return mx.array(read_wav(f"{OUT}/refs/{v}/{mood}.wav"))
if mode=="cv":
    cfg=model.config.talker_config; used=set(cfg.spk_id.values())|set(v for v in (cfg.codec_language_id or {}).values() if isinstance(v,int))
    SLOT=cfg.vocab_size-1
    assert SLOT not in used, used
    emb_layer=model.talker.get_input_embeddings(); print("emb",emb_layer.weight.shape,emb_layer.weight.dtype, type(emb_layer))
    cfg.spk_id["designed"]=SLOT; model.supported_speakers.append("designed")
    # speaker vectors come from the Base speaker encoder
    base=load_model(BASE)
    SPK={v:base.extract_speaker_embedding(ref(v,"neutral")) for v in VOICES}
    del base
    print("cv speaker norm vs preset norm:", float(mx.linalg.norm(SPK["warm_us_woman"])), float(mx.linalg.norm(emb_layer.weight[cfg.spk_id["aiden"]].astype(mx.float32))))
for v in VOICES:
    for level in (["off"] if mode in("icl",) else ["off","strong"]):
        if mode=="moodicl" and level=="strong": pass
        if mode=="cv":
            w=emb_layer.weight; w[SLOT]=SPK[v].reshape(-1).astype(w.dtype); mx.eval(w)
        for ln in LINES:
            mood=LINE_MOOD[ln["id"]]
            mx.random.seed(1234); mx.reset_peak_memory(); t=time.time()
            if mode=="icl":
                g=model.generate(text=ln["text"],ref_audio=ref(v,"neutral"),ref_text=REF_TEXT,lang_code="en",verbose=False)
            elif mode=="moodicl":
                # off => neutral reference, strong => the mood's reference
                g=model.generate(text=ln["text"],ref_audio=ref(v,"neutral" if level=="off" else mood),ref_text=REF_TEXT,lang_code="en",verbose=False)
            elif mode=="xvec":
                # Base, speaker embedding only (no ref_text -> no ICL), instruct pushed through the instruct path
                inst=None if level=="off" else INSTRUCT[mood]["strong"]
                R=ref(v,"neutral")
                orig=model._prepare_generation_inputs
                def patched(**kw): return orig(ref_audio=R,**kw)
                model._prepare_generation_inputs=patched
                g=model._generate_with_instruct(text=ln["text"],speaker=None,language="en",instruct=inst,temperature=0.9,max_tokens=1500,top_k=50,top_p=1.0,repetition_penalty=1.05,verbose=False)
            elif mode=="cv":
                kw={"voice":"designed","lang_code":"en","verbose":False}
                if level=="strong": kw["instruct"]=INSTRUCT[mood]["strong"]
                g=model.generate(text=ln["text"],**kw)
            a,r=collect(g); dt=time.time()-t
            p=f"{OUT}/a2_{mode}/{v}/{level}/{ln['id']}.wav"; write_wav(p,a,r)
            stats[p]={"s":dt,"peak_gb":mx.get_peak_memory()/1e9}
            print(p,round(dt,1),len(a)/r,flush=True)
            if mode=="xvec": model._prepare_generation_inputs=orig
        json.dump(stats,open(OUT+"/stats.json","w"))
