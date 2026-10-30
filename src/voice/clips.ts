/**
 * Speech the Mac made, carried to the Home Assistant gateway inside the sealed call request (relay-protocol.ts):
 * the Mac has a far better voice than the add-on's, and a phone line is 8 kHz anyway, so what travels is the
 * line's own format, G.711 mu-law at 8 kHz (8 KB a second). The gateway seeds its speech cache with the clips, so
 * the dialog plays one when it says exactly the words it was made for, and anything else is spoken by the add-on. No fleet imports: the add-on bundles this file.
 */

export interface Clip {
  /** The exact words this clip says, as `CallDialog` will ask for them. */
  text: string;
  /** G.711 mu-law, 8 kHz mono, base64. */
  mulaw: string;
}

/** Most mu-law bytes one request carries (about 47 s): the database caps a document under 900 KB sealed. */
export const MAX_CLIP_BYTES = 380_000;
const MAX_CLIPS = 16;
const MAX_TEXT = 1200;
const SAMPLE_RATE = 8000;

const BIAS = 0x84;
const CLIP = 32635;

/** One 16-bit sample to a mu-law byte (ITU-T G.711). */
export function linearToMulaw(sample: number): number {
  let value = Math.max(-CLIP, Math.min(CLIP, sample));
  const sign = value < 0 ? 0x80 : 0;
  if (value < 0) value = -value;
  value += BIAS;
  let exponent = 7;
  for (let mask = 0x4000; (value & mask) === 0 && exponent > 0; mask >>= 1) exponent -= 1;
  const mantissa = (value >> (exponent + 3)) & 0x0f;
  return ~(sign | (exponent << 4) | mantissa) & 0xff;
}

/** One mu-law byte to a 16-bit sample. */
export function mulawToLinear(byte: number): number {
  const inverted = ~byte & 0xff;
  const sign = inverted & 0x80;
  const exponent = (inverted >> 4) & 0x07;
  const mantissa = inverted & 0x0f;
  const magnitude = (((mantissa << 3) + BIAS) << exponent) - BIAS;
  return sign ? -magnitude : magnitude;
}

export function encodeMulaw(pcm: Int16Array): Buffer {
  const out = Buffer.alloc(pcm.length);
  for (let i = 0; i < pcm.length; i += 1) out[i] = linearToMulaw(pcm[i]!);
  return out;
}

/** A plain 16-bit mono 8 kHz WAV, the file baresip's `aufile` plays without resampling. */
export function mulawToWav(mulaw: Buffer): Buffer {
  const data = Buffer.alloc(mulaw.length * 2);
  for (let i = 0; i < mulaw.length; i += 1) data.writeInt16LE(mulawToLinear(mulaw[i]!), i * 2);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVEfmt ", 8, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Clips from an untrusted (but sealed and signed) request: well-formed ones only, within the size cap; else none. */
export function readClips(value: unknown): Clip[] | undefined {
  if (!Array.isArray(value) || value.length > MAX_CLIPS) return undefined;
  const clips: Clip[] = [];
  let bytes = 0;
  for (const item of value) {
    if (!isRecord(item) || typeof item.text !== "string" || typeof item.mulaw !== "string") return undefined;
    if (item.text.length === 0 || item.text.length > MAX_TEXT) return undefined;
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(item.mulaw)) return undefined;
    bytes += Math.floor((item.mulaw.length * 3) / 4);
    if (bytes > MAX_CLIP_BYTES) return undefined;
    clips.push({ text: item.text, mulaw: item.mulaw });
  }
  return clips.length > 0 ? clips : undefined;
}
