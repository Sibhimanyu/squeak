import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Clip } from "./clips.js";

/** Most clips kept: the fixed prompts are about 60, the rest are per-chat lines; the oldest go first. */
const MAX_CLIPS = 200;
/** One clip's mu-law, base64: a clip longer than this is a read-back, not worth keeping. */
const MAX_CLIP_CHARS = 700_000;

/**
 * The Mac's recordings kept on disk (the add-on's `/data`), so a restart of the add-on does not lose them: the
 * first call after one then opens with the Mac's voice at once instead of waiting for Firebase to bring the clips
 * back, or for this machine to make the words itself. Never throws: a store that cannot write just remembers nothing.
 */
export class ClipStore {
  constructor(
    private readonly dir: string,
    private readonly max = MAX_CLIPS,
  ) {}

  private file(text: string): string {
    return path.join(this.dir, `${createHash("sha1").update(text).digest("hex")}.json`);
  }

  save(clips: readonly Clip[]): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
      for (const clip of clips) {
        if (clip.mulaw.length > MAX_CLIP_CHARS) continue;
        const file = this.file(clip.text);
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ text: clip.text, mulaw: clip.mulaw }), { mode: 0o600 });
        fs.renameSync(tmp, file);
      }
      this.prune();
    } catch {
      // Nothing to keep it in: the clips still work for this run.
    }
  }

  load(): Clip[] {
    const out: Clip[] = [];
    try {
      for (const name of fs.readdirSync(this.dir)) {
        if (!name.endsWith(".json")) continue;
        try {
          const raw = JSON.parse(fs.readFileSync(path.join(this.dir, name), "utf8")) as Partial<Clip>;
          if (typeof raw.text === "string" && typeof raw.mulaw === "string" && raw.text && raw.mulaw) {
            out.push({ text: raw.text, mulaw: raw.mulaw });
          }
        } catch {
          // A torn or foreign file is skipped.
        }
      }
    } catch {
      // No folder yet: nothing kept.
    }
    return out;
  }

  private prune(): void {
    const entries = fs
      .readdirSync(this.dir)
      .filter((name) => name.endsWith(".json"))
      .map((name) => ({ name, at: fs.statSync(path.join(this.dir, name)).mtimeMs }))
      .sort((a, b) => b.at - a.at);
    for (const old of entries.slice(this.max)) fs.rmSync(path.join(this.dir, old.name), { force: true });
  }
}
