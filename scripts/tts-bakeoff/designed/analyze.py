import json,glob,os,itertools,numpy as np
c=json.load(open("out/score_cache.json"))
keys=[k for k in c if "/out/" in k and "/a1u/" not in k and "/refs/" not in k]
E={k:np.array(c[k]["e"]) for k in keys}
mu=np.mean(list(E.values()),0)
def n(v): return v/np.linalg.norm(v)
Z={k:n(E[k]-mu) for k in keys}
def parse(k): p=k.split("/out/")[1].split("/"); return p[0],p[1],p[2]
groups={}
for k in keys:
    ap,v,l=parse(k); groups.setdefault((ap,v,l),[]).append(k)
# class: speaker identity = (voice) ; compare to prototype of same voice across approaches? use per-approach within and between
print("centered within-voice mean cos | nearest other voice (centroid cos, same approach+level)")
for ap in sorted({g[0] for g in groups}):
    for l in ("off","strong"):
        vs=[v for (a,v,ll) in groups if a==ap and ll==l]
        if not vs: continue
        cen={v:n(np.mean([Z[k] for k in groups[(ap,v,l)]],0)) for v in vs}
        for v in vs:
            ks=groups[(ap,v,l)]
            w=np.mean([Z[a]@Z[b] for a,b in itertools.combinations(ks,2)])
            # between: lines of v vs lines of other voices
            b=np.mean([Z[a]@Z[x] for x in itertools.chain(*[groups[(ap,u,l)] for u in vs if u!=v]) for a in ks])
            print(f"{ap:12s} {l:6s} {v:20s} within={w:.3f} between={b:.3f} gap={w-b:.3f}")
# unseeded control
ck=[k for k in c if "/a1u/" in k]
Eu={k:np.array(c[k]["e"]) for k in ck}
for k in ck: Z[k]=n(Eu[k]-mu)
for v in ("warm_us_woman","calm_uk_man"):
    for l in ("off","strong"):
        ks=[k for k in ck if f"/{v}/{l}/" in k]
        w=[Z[a]@Z[b] for a,b in itertools.combinations(ks,2)]
        print(f"a1u(unseeded) {l:6s} {v:20s} within={np.mean(w):.3f} min={np.min(w):.3f}")
# seeded a1 min
for v in ("warm_us_woman","calm_uk_man"):
    for l in ("off","strong"):
        ks=groups[("a1",v,l)]; w=[Z[a]@Z[b] for a,b in itertools.combinations(ks,2)]; print(f"a1(seeded)   {l:6s} {v:20s} within={np.mean(w):.3f} min={np.min(w):.3f}")
# fidelity to a1 off centroid
print("Cross-approach: cosine of each approach/voice centroid to the a1/off centroid of that voice (centered)")
for v in ("warm_us_woman","calm_uk_man","friendly_in_woman","energetic_us_man"):
    ref=n(np.mean([Z[k] for k in groups[("a1",v,"off")]],0))
    print(v," ".join(f"{ap}/{l}={n(np.mean([Z[k] for k in groups[(ap,v,l)]],0))@ref:.2f}" for ap in ("a2_icl","a2_moodicl","a2_xvec","a2_cv") for l in ("off","strong") if (ap,v,l) in groups))
