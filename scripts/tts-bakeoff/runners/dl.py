import sys, os
os.environ.setdefault("HF_HUB_DISABLE_XET","1"); os.environ.setdefault("HF_HUB_DOWNLOAD_TIMEOUT","60")
from huggingface_hub import snapshot_download
repo=sys.argv[1]; allow=sys.argv[2:] or None
for i in range(15):
    try:
        print(snapshot_download(repo, allow_patterns=allow, max_workers=4)); break
    except Exception as e: print("retry",i,type(e).__name__,str(e)[:100], flush=True)
