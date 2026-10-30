/**
 * The Python worker that runs Kokoro-82M (Apache-2.0) through ONNX Runtime. It is written to the support folder by
 * `squeak voice-tts-setup` (so a daemon bundled in the Mac app needs no checkout) and kept alive by `NaturalVoice`.
 * One JSON object per line in and out:
 *   in : {"id": 1, "text": "...", "voice": "af_heart", "speed": 1.0, "out": "/tmp/x.wav"}
 *   out: {"id": 1, "ok": true, "ms": 1234}   or   {"id": 1, "ok": false, "error": "..."}
 * It writes a 24 kHz mono 16-bit WAV; the daemon makes the telephone clip. The text never leaves this machine.
 */
export const NATURAL_WORKER_PY = `import json
import sys
import time
import wave

import numpy as np
from kokoro_onnx import Kokoro


def main():
    kokoro = Kokoro(sys.argv[1], sys.argv[2])
    print(json.dumps({"ready": True}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request = {}
        try:
            request = json.loads(line)
            began = time.time()
            samples, rate = kokoro.create(
                request["text"],
                voice=request.get("voice", "af_heart"),
                speed=float(request.get("speed", 1.0)),
                lang="en-us",
            )
            pcm = (np.clip(samples, -1.0, 1.0) * 32767).astype("<i2")
            with wave.open(request["out"], "wb") as out:
                out.setnchannels(1)
                out.setsampwidth(2)
                out.setframerate(rate)
                out.writeframes(pcm.tobytes())
            print(json.dumps({"id": request.get("id"), "ok": True, "ms": int((time.time() - began) * 1000)}), flush=True)
        except Exception as error:
            print(json.dumps({"id": request.get("id"), "ok": False, "error": str(error)[:300]}), flush=True)


main()
`;
