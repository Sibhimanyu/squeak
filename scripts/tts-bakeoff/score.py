#!/usr/bin/env python3
"""Score every out/<variant>/ folder: phone-line copy, Whisper intelligibility, speed; then build index.html.

Stdlib only. Needs ffmpeg and whisper-cli on PATH-like locations below.
"""
import html
import json
import pathlib
import random
import re
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent
OUT = ROOT / "out"
PHONE = ROOT / "phone"
FFMPEG = "/opt/homebrew/bin/ffmpeg"
WHISPER = "/opt/homebrew/bin/whisper-cli"
WHISPER_MODEL = pathlib.Path.home() / "Library/Application Support/squeak/whisper/ggml-base.en.bin"
LINES = json.loads((ROOT / "lines.json").read_text())
NUMBERS = {"1": "one", "2": "two", "42": "forty two", "3": "three"}


def words(text):
    text = text.lower().replace("-", " ")
    text = re.sub(r"\[[^\]]*\]|\([^)]*\)|<[^>]*>", " ", text)
    out = []
    for w in re.findall(r"[a-z0-9']+", text):
        out.extend(NUMBERS.get(w, w).split())
    return [w.replace("'", "") for w in out]


def wer(ref, hyp):
    r, h = words(ref), words(hyp)
    d = list(range(len(h) + 1))
    for i in range(1, len(r) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(h) + 1):
            cur = min(d[j] + 1, d[j - 1] + 1, prev + (r[i - 1] != h[j - 1]))
            prev, d[j] = d[j], cur
    return d[len(h)] / max(1, len(r))


def run(cmd):
    return subprocess.run(cmd, capture_output=True, text=True, check=False)


def phone_copy(src, dst):
    # What the caller hears: 300-3400 Hz band, 8 kHz, mono, mu-law round trip, back to PCM WAV for the browser.
    dst.parent.mkdir(parents=True, exist_ok=True)
    tmp = dst.with_suffix(".ulaw.wav")
    run([FFMPEG, "-y", "-loglevel", "error", "-i", str(src), "-af", "highpass=f=300,lowpass=f=3400,loudnorm=I=-18:TP=-2",
         "-ar", "8000", "-ac", "1", "-c:a", "pcm_mulaw", str(tmp)])
    run([FFMPEG, "-y", "-loglevel", "error", "-i", str(tmp), "-c:a", "pcm_s16le", str(dst)])
    tmp.unlink(missing_ok=True)


def transcribe(wav):
    sixteen = wav.with_suffix(".16k.wav")
    run([FFMPEG, "-y", "-loglevel", "error", "-i", str(wav), "-ar", "16000", "-ac", "1", str(sixteen)])
    res = run([WHISPER, "-m", str(WHISPER_MODEL), "-f", str(sixteen), "-nt", "-np"])
    sixteen.unlink(missing_ok=True)
    return " ".join(res.stdout.split())


def main():
    results = []
    for vdir in sorted(p for p in OUT.iterdir() if p.is_dir()):
        tfile = vdir / "timings.json"
        if not tfile.exists():
            continue
        t = json.loads(tfile.read_text())
        per = {x["id"]: x for x in t.get("lines", [])}
        row = {"variant": vdir.name, "model": t.get("model", ""), "device": t.get("device", ""),
               "notes": t.get("notes", ""), "load": t.get("load_seconds"), "lines": {}}
        for line in LINES:
            wav = vdir / f"{line['id']}.wav"
            if not wav.exists():
                continue
            pw = PHONE / vdir.name / f"{line['id']}.wav"
            if not pw.exists() or pw.stat().st_mtime < wav.stat().st_mtime:
                phone_copy(wav, pw)
            cache = pw.with_suffix(".txt")
            if not cache.exists() or cache.stat().st_mtime < pw.stat().st_mtime:
                cache.write_text(transcribe(pw))
            heard = cache.read_text()
            info = per.get(line["id"], {})
            row["lines"][line["id"]] = {"heard": heard, "wer": wer(line["text"], heard),
                                        "gen": info.get("gen_seconds"), "audio": info.get("audio_seconds"),
                                        "spoken": info.get("spoken_text", "")}
        ls = row["lines"].values()
        gens = [x["gen"] for x in ls if x["gen"]]
        auds = [x["audio"] for x in ls if x["audio"]]
        row["n"] = len(row["lines"])
        row["wer"] = sum(x["wer"] for x in ls) / max(1, len(row["lines"]))
        row["gen_avg"] = sum(gens) / len(gens) if gens else None
        row["rtf"] = sum(gens) / sum(auds) if gens and auds and sum(auds) else None
        results.append(row)
        print(f"{row['variant']:40s} lines={row['n']} WER={row['wer']:.1%} gen/line={row['gen_avg'] or 0:.1f}s "
              f"RTF={row['rtf'] or 0:.2f}")
    (ROOT / "results.json").write_text(json.dumps(results, indent=2))
    build_page(results)


def build_page(results):
    rel = lambda p: html.escape(str(p.relative_to(ROOT)))
    letters = [f"V{i + 1:02d}" for i in range(len(results))]
    order = list(range(len(results)))
    random.Random(7).shuffle(order)
    summary = "".join(
        f"<tr><td class=name data-blind='{letters[i]}'>{html.escape(r['variant'])}</td><td>{html.escape(r['device'])}</td>"
        f"<td>{r['n']}/8</td><td>{r['wer']:.0%}</td><td>{(r['gen_avg'] or 0):.1f}s</td><td>{(r['rtf'] or 0):.2f}</td>"
        f"<td>{(r['load'] or 0):.0f}s</td><td class=notes>{html.escape(r['notes'])}</td></tr>"
        for i, r in enumerate(results))
    blocks = []
    for line in LINES:
        cells = []
        for i in order:
            r = results[i]
            x = r["lines"].get(line["id"])
            if not x:
                continue
            full = OUT / r["variant"] / f"{line['id']}.wav"
            ph = PHONE / r["variant"] / f"{line['id']}.wav"
            cells.append(
                f"<div class=cell><div class=name data-blind='{letters[i]}'>{html.escape(r['variant'])}</div>"
                f"<label>phone <audio controls preload=none src='{rel(ph)}'></audio></label>"
                f"<label>full <audio controls preload=none src='{rel(full)}'></audio></label>"
                f"<div class=meta>WER {x['wer']:.0%} · {(x['gen'] or 0):.1f}s to make · heard: “{html.escape(x['heard'])}”</div>"
                f"<div class=stars data-key='{html.escape(r['variant'])}|{line['id']}'>"
                + "".join(f"<button data-v={s}>{s}</button>" for s in range(1, 6)) + "</div></div>")
        blocks.append(f"<section><h2>{html.escape(line['id'])} <span>({html.escape(line['emotion'])})</span></h2>"
                      f"<p class=text>{html.escape(line['text'])}</p><div class=grid>{''.join(cells)}</div></section>")
    page = f"""<!doctype html><meta charset=utf-8><title>Squeak TTS bake-off</title>
<style>
body{{font:14px -apple-system,system-ui;margin:24px;background:#111;color:#eee}} h2 span{{color:#999;font-weight:400}}
table{{border-collapse:collapse}} td,th{{padding:4px 10px;border-bottom:1px solid #333;text-align:left}} .notes{{color:#aaa;max-width:520px}}
.grid{{display:grid;grid-template-columns:repeat(auto-fill,minmax(330px,1fr));gap:10px}}
.cell{{background:#1c1c1c;border-radius:8px;padding:10px}} .cell .name{{font-weight:600;margin-bottom:6px}}
audio{{width:100%;height:30px}} label{{display:block;color:#888;font-size:12px}} .meta{{color:#999;font-size:12px;margin-top:4px}}
.text{{font-size:16px}} .stars button{{background:#2a2a2a;color:#ddd;border:0;border-radius:4px;margin:4px 2px 0 0;padding:3px 8px;cursor:pointer}}
.stars button.on{{background:#e0b400;color:#000}} body.blind .name{{font-size:0}} body.blind .name::before{{content:attr(data-blind);font-size:14px}}
</style>
<h1>Squeak TTS bake-off</h1>
<p><label style="display:inline;color:#eee"><input type=checkbox id=blind> Blind (hide model names)</label> ·
Ratings save in this browser · <button id=export>Copy my ratings</button></p>
<p>“phone” is what a caller hears (300–3400 Hz, 8 kHz μ-law). WER is Whisper base.en on the phone copy (lower is clearer).
Speed: seconds to make one line after load; RTF = make time ÷ audio length (under 1 is faster than real time).</p>
<table><tr><th>variant</th><th>device</th><th>lines</th><th>WER</th><th>per line</th><th>RTF</th><th>load</th><th>emotion control</th></tr>{summary}</table>
{''.join(blocks)}
<script>
const K='squeak-tts-ratings',R=JSON.parse(localStorage[K]||'{{}}');
document.querySelectorAll('.stars').forEach(s=>{{const k=s.dataset.key;const paint=()=>s.querySelectorAll('button').forEach(b=>b.classList.toggle('on',+b.dataset.v<=(R[k]||0)));
paint();s.onclick=e=>{{if(e.target.dataset.v){{R[k]=+e.target.dataset.v;localStorage[K]=JSON.stringify(R);paint();}}}};}});
blind.onchange=()=>document.body.classList.toggle('blind',blind.checked);
document.addEventListener('play',e=>document.querySelectorAll('audio').forEach(a=>a!==e.target&&a.pause()),true);
document.getElementById("export").onclick=()=>navigator.clipboard.writeText(JSON.stringify(R,null,1));
</script>"""
    (ROOT / "index.html").write_text(page)
    print("wrote", ROOT / "index.html")


if __name__ == "__main__":
    main()
