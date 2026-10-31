# usage: score2.py <approach-dir-name>...   (out/<approach>/<voice>/<level>/<line>.wav)
import sys, importlib.util, subprocess, glob, itertools, pathlib
sys.path.insert(0,"/tmp/squeak-designed-voices")
from common import *
import mlx.core as mx
spec=importlib.util.spec_from_file_location("bscore",ROOT+"/scripts/tts-bakeoff/score.py"); bs=importlib.util.module_from_spec(spec); spec.loader.exec_module(bs)
TEXT={l["id"]:l["text"] for l in LINES}
CACHE=OUT+"/score_cache.json"
cache=json.load(open(CACHE)) if os.path.exists(CACHE) else {}
def run(c): return subprocess.run(c,capture_output=True,text=True)
def wer_of(path):
    lid=pathlib.Path(path).stem
    ph=path.replace("/out/","/phone/"); os.makedirs(os.path.dirname(ph),exist_ok=True)
    bs.phone_copy(pathlib.Path(path),pathlib.Path(ph))
    # task says: highpass300/lowpass3400/8k mulaw (score.py also loudnorms; same function)
    hyp=bs.transcribe(pathlib.Path(ph)); return bs.wer(TEXT[lid],hyp),hyp
def pitch(a,sr=24000):
    # autocorrelation f0 on voiced frames, 60-400 Hz
    fl=int(0.04*sr); hop=int(0.02*sr); f0=[]
    lo=int(sr/400); hi=int(sr/60)
    thr=np.sqrt((a**2).mean())*0.5
    for i in range(0,len(a)-fl,hop):
        x=a[i:i+fl]; x=x-x.mean()
        if np.sqrt((x**2).mean())<thr: continue
        ac=np.correlate(x,x,"full")[fl-1:]
        if ac[0]<=0: continue
        k=lo+np.argmax(ac[lo:hi]); 
        if ac[k]/ac[0]>0.4: f0.append(sr/k)
    return float(np.median(f0)) if f0 else 0.0
def feats(path):
    a=read_wav(path); act=a[np.abs(a)>0.01]
    return {"dur":len(a)/24000,"f0":pitch(a),"db":float(20*np.log10(np.sqrt((act**2).mean())+1e-9))}
base=None
def emb(path):
    global base
    if base is None: base=load_model(BASE)
    e=np.array(base.extract_speaker_embedding(mx.array(read_wav(path)))).reshape(-1); return e/np.linalg.norm(e)
from mlx_audio.tts.utils import load_model
stats=json.load(open(OUT+"/stats.json")) if os.path.exists(OUT+"/stats.json") else {}
def cos_pairs(E): return [float(a@b) for a,b in itertools.combinations(E,2)]
res={}
for ap in sys.argv[1:]:
    for vdir in sorted(glob.glob(f"{OUT}/{ap}/*")):
        v=os.path.basename(vdir)
        for level in ("off","strong"):
            files=sorted(glob.glob(f"{vdir}/{level}/*.wav"))
            if not files: continue
            E=[];W=[];F={};T=[];Mm=[]
            for f in files:
                c=cache.setdefault(f,{})
                if "e" not in c: c["e"]=emb(f).tolist()
                if "w" not in c: c["w"],c["hyp"]=wer_of(f)
                if "f" not in c: c["f"]=feats(f)
                E.append(np.array(c["e"])); W.append(c["w"]); F[pathlib.Path(f).stem]=c["f"]
                if f in stats: T.append(stats[f]["s"]); Mm.append(stats[f]["peak_gb"])
            json.dump(cache,open(CACHE,"w"))
            res[f"{ap}/{v}/{level}"]={"n":len(files),"cons":float(np.mean(cos_pairs(E))),"cons_min":float(np.min(cos_pairs(E))),"wer":float(np.mean(W)),"s_line":float(np.mean(T)) if T else None,"peak_gb":float(max(Mm)) if Mm else None,"feats":F,"centroid":np.mean(E,0).tolist()}
json.dump(res,open(OUT+"/results_"+"_".join(sys.argv[1:])+".json","w"),indent=1)
for k,r in res.items(): print(f"{k:42s} n={r['n']} cons={r['cons']:.3f} min={r['cons_min']:.3f} wer={r['wer']*100:.1f}% s={r['s_line']} gb={r['peak_gb']}")
# emotion delta off->strong
for ap in sys.argv[1:]:
    for vdir in sorted(glob.glob(f"{OUT}/{ap}/*")):
        v=os.path.basename(vdir); a=res.get(f"{ap}/{v}/off"); b=res.get(f"{ap}/{v}/strong")
        if not (a and b): continue
        ids=[i for i in a["feats"] if i in b["feats"] and LINE_MOOD[i]!="neutral"]
        d=lambda k:np.mean([abs(b["feats"][i][k]-a["feats"][i][k]) for i in ids]); 
        rd=np.mean([abs(b["feats"][i]["dur"]/a["feats"][i]["dur"]-1) for i in ids])
        print(f"EMO {ap}/{v}: |dur| {rd*100:.0f}%  |f0| {d('f0'):.1f}Hz  |loud| {d('db'):.1f}dB  (non-neutral lines, off vs strong)")
