import zlib from "node:zlib";

/**
 * macOS app-icon PNGs carry a transparent margin (the icon grid's ~10% inset), which made a pond icon look small
 * inside its tile. `trimTransparentMargins` crops a PNG to its opaque bounding box and pads it square with
 * transparency. Only 8-bit RGBA, non-interlaced PNGs are handled (what app icons are); anything else, or a
 * PNG with nothing to trim, returns null and the caller keeps the original.
 */
const SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");
export const ALPHA_THRESHOLD = 8;

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

export interface Rgba {
  width: number;
  height: number;
  data: Buffer;
}

export function decodeRgbaPng(png: Buffer): Rgba | null {
  if (png.length < 33 || !png.subarray(0, 8).equals(SIGNATURE)) return null;
  let pos = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (pos + 8 <= png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.toString("ascii", pos + 4, pos + 8);
    const body = png.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || body[9] !== 6 || body[12] !== 0) return null;
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    pos += 12 + len;
  }
  if (!width || !height || width > 8192 || height > 8192 || idat.length === 0) return null;
  let raw: Buffer;
  try {
    raw = zlib.inflateSync(Buffer.concat(idat));
  } catch {
    return null;
  }
  const stride = width * 4;
  if (raw.length !== (stride + 1) * height) return null;
  const out = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const src = y * (stride + 1) + 1;
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? out[y * stride + x - 4]! : 0;
      const b = y > 0 ? out[(y - 1) * stride + x]! : 0;
      const c = x >= 4 && y > 0 ? out[(y - 1) * stride + x - 4]! : 0;
      let v = raw[src + x]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (filter !== 0) return null;
      out[y * stride + x] = v & 0xff;
    }
  }
  return { width, height, data: out };
}

export function encodeRgbaPng(img: Rgba): Buffer {
  const stride = img.width * 4;
  const raw = Buffer.alloc((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++) img.data.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The cropped, squared PNG, or null when the image cannot be read, is fully transparent, or has no margin. */
export function trimTransparentMargins(png: Buffer): Buffer | null {
  const img = decodeRgbaPng(png);
  if (!img) return null;
  const { width, height, data } = img;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3]! > ALPHA_THRESHOLD) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  const w = maxX - minX + 1;
  const h = maxY - minY + 1;
  if (Math.max(w, h) === width && width === height) return null; // already trimmed and square
  const side = Math.max(w, h);
  const out = Buffer.alloc(side * side * 4);
  const offX = Math.floor((side - w) / 2);
  const offY = Math.floor((side - h) / 2);
  for (let y = 0; y < h; y++) {
    data.copy(
      out,
      ((y + offY) * side + offX) * 4,
      ((minY + y) * width + minX) * 4,
      ((minY + y) * width + minX + w) * 4,
    );
  }
  return encodeRgbaPng({ width: side, height: side, data: out });
}
