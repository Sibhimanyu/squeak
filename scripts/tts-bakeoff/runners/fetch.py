import sys, time
from huggingface_hub import snapshot_download
for repo in sys.argv[1:]:
    for i in range(30):
        try:
            p = snapshot_download(repo); print("OK", repo, p, flush=True); break
        except Exception as e:
            print("retry", repo, i, type(e).__name__, flush=True); time.sleep(3)
