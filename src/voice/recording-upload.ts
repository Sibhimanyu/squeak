import type { PhoneCall } from "./phone.js";
import { readPcmOfWav } from "./up-stream.js";
import type { UpAudio, Uplink } from "./uplink.js";

/**
 * Records the person and, when the Mac takes pieces, sends the audio up while they are still talking
 * (`Uplink.openStream`): when they stop, only the last piece is left to send. Without a stream (an older Mac, a test)
 * this is `call.record` and the one encode it always was.
 */

export interface RecordedUpload {
  recording: NonNullable<Awaited<ReturnType<PhoneCall["record"]>>>;
  /** The audio for the up message: the pieces' hashes, or (a piece failed, or none were made) the whole Opus file. */
  audio(): Promise<UpAudio>;
  /** The recording will not be sent: its pieces go. Safe to call more than once. */
  discard(): void;
}

export async function recordForUpload(
  call: PhoneCall,
  deps: { uplink: { openStream?: Uplink["openStream"] }; encode: (wavFile: string) => Promise<Buffer> },
  options: Omit<Parameters<PhoneCall["record"]>[0], "onAudio">,
  streamId: string,
): Promise<RecordedUpload | null> {
  const stream = deps.uplink.openStream?.(streamId) ?? null;
  const recording = await call.record({
    ...options,
    ...(stream ? { onAudio: (pcm: Buffer) => stream.feed(pcm) } : {}),
  });
  if (!recording) {
    void stream?.abort();
    return null;
  }
  return {
    recording,
    audio: async () => {
      if (stream) {
        const parts = await stream.finish(readPcmOfWav(recording.file)).catch(() => null);
        if (parts) return { parts };
      }
      return deps.encode(recording.file);
    },
    discard: () => void stream?.abort(),
  };
}
