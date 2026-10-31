#!/usr/bin/env python3
"""Live view of the bake-off: model downloads in the Hugging Face cache and clips made per variant."""
import json
import os
import pathlib
import sys
import threading
import time

ROOT = pathlib.Path(__file__).resolve().parent
HUB = pathlib.Path.home() / ".cache/huggingface/hub"
STARTED = time.time() - 3 * 3600  # repos touched in the last few hours belong to this run
SKIP = ("gemma", "musicgen", "ACE-Step", "acestep")
LINES = len(json.loads((ROOT / "lines.json").read_text()))
totals, history = {}, {}


def size(path):
    n = 0
    for dirpath, _, files in os.walk(path):
        for f in files:
            p = os.path.join(dirpath, f)
            if not os.path.islink(p):
                try:
                    n += os.path.getsize(p)
                except OSError:
                    pass
    return n


def fetch_total(repo):
    try:
        from huggingface_hub import HfApi
        info = HfApi().model_info(repo, files_metadata=True)
        totals[repo] = sum((s.size or 0) for s in info.siblings)
    except Exception:
        totals[repo] = None


def human(n):
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.1f} {unit}" if unit != "B" else f"{n} B"
        n /= 1024


def bar(frac, width=28):
    filled = int(round(frac * width))
    return "█" * filled + "░" * (width - filled)


def frame():
    now = time.time()
    rows = []
    for d in sorted(HUB.glob("models--*")):
        if d.stat().st_mtime < STARTED and not any((d / "blobs").glob("*.incomplete")):
            continue
        repo = d.name[len("models--"):].replace("--", "/")
        if any(s.lower() in repo.lower() for s in SKIP):
            continue
        have = size(d / "blobs")
        active = any((d / "blobs").glob("*.incomplete"))
        if repo not in totals:
            totals[repo] = "pending"
            threading.Thread(target=fetch_total, args=(repo,), daemon=True).start()
        h = history.setdefault(repo, [])
        h.append((now, have))
        while h and now - h[0][0] > 10:
            h.pop(0)
        rate = (h[-1][1] - h[0][1]) / (h[-1][0] - h[0][0]) if len(h) > 1 and h[-1][0] > h[0][0] else 0
        rows.append((repo, have, totals.get(repo), active, rate))

    out = ["\033[1mSqueak TTS bake-off — live\033[0m   " + time.strftime("%H:%M:%S"), "",
           "\033[1mDownloads\033[0m (Hugging Face cache)"]
    total_rate = left = 0
    for repo, have, total, active, rate in rows:
        total_rate += max(rate, 0)
        if active and isinstance(total, int):
            left += max(0, total - have)
        if isinstance(total, int) and total > 0:
            frac = min(1, have / total)
            done = frac >= 0.999
            pct = f"{frac:6.1%}"
        else:
            frac, done, pct = (0 if active else 1), not active, "   ?  "
        state = "\033[32mdone\033[0m" if done else ("\033[33m" + (f"{human(rate)}/s" if rate > 0 else "idle") + "\033[0m")
        tot = human(total) if isinstance(total, int) else "?"
        out.append(f"  {repo[:52]:52s} {bar(frac)} {pct}  {human(have):>9s} / {tot:<9s} {state}")
    out.append(f"  {'all downloads':52s} {'':28s}         {'':>9s}   {'':9s} \033[1m{human(total_rate)}/s\033[0m")
    if total_rate > 0 and left:
        out.append(f"  {human(left)} still to fetch in active downloads, about {left / total_rate / 60:.0f} min at this speed")

    out += ["", f"\033[1mClips made\033[0m (out/, {LINES} lines each)"]
    for v in sorted((ROOT / "out").glob("*")) if (ROOT / "out").exists() else []:
        if not v.is_dir():
            continue
        n = len(list(v.glob("*.wav")))
        ok = (v / "timings.json").exists()
        mark = "\033[32m✓\033[0m" if ok and n >= LINES else ("\033[33m…\033[0m" if n else " ")
        out.append(f"  {mark} {v.name:44s} {bar(n / LINES, 16)} {n}/{LINES}")
    envs = sorted(p.name for p in (ROOT / "envs").glob("*")) if (ROOT / "envs").exists() else []
    out += ["", "\033[2mEnvironments: " + ", ".join(envs) + "\033[0m",
            "\033[2mpip installs and git clones don't show here, only model weights. Ctrl-C to close.\033[0m"]
    rows_avail = os.get_terminal_size().lines - 1 if sys.stdout.isatty() else len(out)
    out = out[:rows_avail]
    # Redraw in place on the alternate screen: no scrollback, no scrolling.
    sys.stdout.write("\033[H" + "\n".join(line + "\033[K" for line in out) + "\033[J")
    sys.stdout.flush()


if __name__ == "__main__":
    sys.stdout.write("\033[?1049h\033[?25l")
    try:
        while True:
            frame()
            time.sleep(2)
    except KeyboardInterrupt:
        pass
    finally:
        sys.stdout.write("\033[?25h\033[?1049l")
        sys.stdout.flush()
