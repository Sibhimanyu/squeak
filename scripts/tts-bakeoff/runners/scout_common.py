"""Shared helpers for the scout runners (mlx-audio env: envs/mlxaudio-scout)."""
import json, os, time, wave
from pathlib import Path
import numpy as np

ROOT = Path(__file__).resolve().parent.parent
os.environ.setdefault("HF_HUB_DISABLE_XET", "1")
os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT", "60")
LINES = json.loads((ROOT / "lines.json").read_text())
REF_WAV = str(ROOT / "ref.wav")
REF_TXT = (ROOT / "ref.txt").read_text().strip()


def to_np(a):
    a = np.array(a, dtype=np.float32).reshape(-1) if not hasattr(a, "shape") or len(a.shape) < 2 else np.array(a, dtype=np.float32)
    if a.ndim > 1:
        a = a.reshape(-1) if 1 in a.shape else a.mean(axis=0 if a.shape[0] < a.shape[1] else 1)
    return a


def write_wav(path, audio, sr):
    a = np.clip(to_np(audio), -1, 1)
    pcm = (a * 32767).astype("<i2")
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1); w.setsampwidth(2); w.setframerate(int(sr)); w.writeframes(pcm.tobytes())
    return len(pcm) / sr


class Variant:
    def __init__(self, name, model, device, notes):
        self.dir = ROOT / "out" / name
        self.dir.mkdir(parents=True, exist_ok=True)
        self.meta = {"model": model, "variant": name, "device": device, "notes": notes, "load_seconds": 0, "lines": []}

    def run(self, gen_fn, lines=LINES):
        """gen_fn(line) -> (audio, sample_rate, spoken_text). First line is also run once as a throwaway warm-up."""
        gen_fn(lines[0])
        for ln in lines:
            t = time.time()
            audio, sr, spoken = gen_fn(ln)
            dt = time.time() - t
            dur = write_wav(self.dir / f"{ln['id']}.wav", audio, sr)
            self.meta["lines"].append({"id": ln["id"], "gen_seconds": round(dt, 2), "audio_seconds": round(dur, 2), "spoken_text": spoken})
            print(f"{self.meta['variant']} {ln['id']}: gen {dt:.1f}s audio {dur:.1f}s", flush=True)

    def save(self):
        (self.dir / "timings.json").write_text(json.dumps(self.meta, indent=2))


def first_audio(gen):
    """Concatenate all chunks a mlx-audio generator yields."""
    chunks = []; sr = None
    for r in gen:
        chunks.append(to_np(r.audio)); sr = r.sample_rate
    return np.concatenate(chunks), sr
