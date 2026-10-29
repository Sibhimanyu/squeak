import { describe, expect, it } from "vitest";

import jsQR from "../js/vendor/jsQR.js";
import {
  DENIED,
  HINT,
  MAX_CODE_LENGTH,
  NOT_A_CODE,
  NO_CAMERA,
  POINT_AT_CODE,
  QrScan,
  rejectionFor,
  scanSupported,
} from "../js/qr-scanner.js";
import { beginPairing } from "../js/pairing.js";
import { PairingError } from "../js/pairing-link.js";

const key = Buffer.alloc(32, 5).toString("base64");
const link = (payload) => `squeak://pair?d=${Buffer.from(JSON.stringify(payload)).toString("base64url")}`;
const good = {
  v: 1,
  p: "squeak-5c9gvo",
  c: "p1pYhre8xC41Wr3hbYtgCg",
  k: key,
  n: "Mac",
  r: "https://x-rtdb.firebasedatabase.app",
};

function rig({ frames = [], getUserMedia } = {}) {
  const tracks = [
    {
      stopped: 0,
      stop() {
        this.stopped++;
      },
    },
    {
      stopped: 0,
      stop() {
        this.stopped++;
      },
    },
  ];
  const stream = { getTracks: () => tracks };
  let clock = 0;
  let pending = null;
  const statuses = [];
  const texts = [];
  const video = { srcObject: null, play: async () => undefined };
  const queue = [...frames];
  const scan = new QrScan({
    mediaDevices: { getUserMedia: getUserMedia ?? (async () => stream) },
    video,
    readFrame: async () => (queue.length ? queue.shift() : null),
    onText: (text) => texts.push(text),
    onStatus: (s) => statuses.push(s),
    now: () => clock,
    schedule: (fn) => (pending = fn),
    cancel: () => (pending = null),
  });
  const step = async (ms = 130) => {
    clock += ms;
    const fn = pending;
    pending = null;
    await fn?.();
  };
  return { scan, tracks, video, statuses, texts, step, hasPending: () => pending !== null };
}

describe("QrScan", () => {
  it("asks for the rear camera, then stops every track on a good code", async () => {
    const asked = [];
    const r = rig({
      frames: [null, link(good)],
      getUserMedia: async (c) => (asked.push(c), { getTracks: () => r.tracks }),
    });
    await r.scan.start();
    expect(asked[0].video.facingMode).toBe("environment");
    expect(r.statuses.map((s) => s.kind)).toEqual(["asking", "scanning"]);
    expect(r.statuses[1].message).toBe(POINT_AT_CODE);
    await r.step();
    expect(r.texts).toEqual([]);
    await r.step();
    expect(r.texts).toEqual([link(good)]);
    expect(r.tracks.map((t) => t.stopped)).toEqual([1, 1]);
    expect(r.video.srcObject).toBe(null);
    expect(r.hasPending()).toBe(false);
  });

  it("says a permission refusal in a plain sentence and starts no loop", async () => {
    const r = rig({
      getUserMedia: async () => Promise.reject(Object.assign(new Error("x"), { name: "NotAllowedError" })),
    });
    await r.scan.start();
    expect(r.statuses.at(-1)).toEqual({ kind: "error", message: DENIED });
    expect(r.hasPending()).toBe(false);
  });

  it("says so when there is no camera", async () => {
    const r = rig({
      getUserMedia: async () => Promise.reject(Object.assign(new Error("x"), { name: "NotFoundError" })),
    });
    await r.scan.start();
    expect(r.statuses.at(-1).message).toBe(NO_CAMERA);
    expect(scanSupported({}, true)).toBe(false);
    expect(scanSupported({ mediaDevices: { getUserMedia() {} } }, false)).toBe(false);
    expect(scanSupported({ mediaDevices: { getUserMedia() {} } }, true)).toBe(true);
  });

  it("keeps scanning after a wrong code, shows the hint after 3 s, and still accepts a real one", async () => {
    const r = rig({ frames: ["https://example.com", null, null, link(good)] });
    await r.scan.start();
    await r.step();
    expect(r.statuses.at(-1)).toEqual({ kind: "wrong", message: NOT_A_CODE });
    expect(r.tracks[0].stopped).toBe(0);
    await r.step(1500);
    expect(r.statuses.at(-1).kind).toBe("wrong");
    await r.step(1600);
    expect(r.statuses.at(-1)).toEqual({ kind: "hint", message: HINT });
    await r.step();
    expect(r.texts).toEqual([link(good)]);
    expect(r.tracks[0].stopped).toBe(1);
  });

  it("is throttled to about 8 frames a second", async () => {
    let reads = 0;
    const r = rig();
    r.scan.readFrame = async () => (reads++, null);
    await r.scan.start();
    await r.step(10);
    await r.step(10);
    await r.step(10);
    expect(reads).toBe(1);
    await r.step(130);
    expect(reads).toBe(2);
  });

  it("stops the camera when closed, even while the permission prompt is open", async () => {
    let release;
    const r = rig({});
    r.scan.mediaDevices = { getUserMedia: () => new Promise((resolve) => (release = resolve)) };
    const starting = r.scan.start();
    r.scan.stop();
    release({ getTracks: () => r.tracks });
    await starting;
    expect(r.tracks.map((t) => t.stopped)).toEqual([1, 1]);
    expect(r.hasPending()).toBe(false);
  });
});

describe("what a scanned code may be", () => {
  it("goes through parsePairingLink: wrong origin, other formats and huge payloads are refused", () => {
    expect(rejectionFor(link(good))).toBe(null);
    expect(rejectionFor(link({ ...good, r: "https://evil.example" }))).toBe(
      "That pairing code points at a server Squeak will not talk to.",
    );
    expect(rejectionFor(link({ ...good, v: 2 }))).toMatch(/version/);
    expect(rejectionFor("hello")).toBe(NOT_A_CODE);
    expect(rejectionFor("squeak://pair?d=" + "A".repeat(MAX_CODE_LENGTH))).toBe(NOT_A_CODE);
  });

  it("reaches beginPairing as the same text, which refuses a bad origin with PairingError", async () => {
    await expect(
      beginPairing(link({ ...good, r: "https://evil.example" }), { store: {}, name: "w" }),
    ).rejects.toBeInstanceOf(PairingError);
  });
});

describe("vendored jsQR", () => {
  // A real QR (Apple's CIQRCodeGenerator, level L) for "squeak://pair?d=eyJ2IjoxfQ", one module of quiet zone.
  const rows = `
...........................
.#######.####......#######.
.#.....#....####.#.#.....#.
.#.###.#..#.#.###..#.###.#.
.#.###.#...##....#.#.###.#.
.#.###.#...#####.#.#.###.#.
.#.....#..#.#.#....#.....#.
.#######.#.#.#.#.#.#######.
.........##..###.#.........
.##.##.#..#..#.....#.....#.
.#.##.#.##.#....###.#####..
..#.#.##.##..####.###....#.
.###.#...#........######.#.
.#####.##.##.##.##.##.#.##.
.##.#.#.####.#.###..###.#..
.##.##.#.##...#.#..#.#.###.
.#.##.#..#...#..#.###.###..
.#...#.##...#.#..#########.
.........####.#.##...#.#...
.#######....##.#.#.#.#.#.#.
.#.....#...##.##.#...##....
.#.###.#.#.#.#.########....
.#.###.#.#..#.##..##....##.
.#.###.#...####.#.#..#.###.
.#.....#.#.###.##.#..#.###.
.#######.##......#.##....#.
...........................`
    .trim()
    .split("\n");

  it("decodes a rendered QR matrix", () => {
    const scale = 8;
    const pad = 4 * scale;
    const size = rows.length * scale + pad * 2;
    const data = new Uint8ClampedArray(size * size * 4).fill(255);
    rows.forEach((row, my) =>
      [...row].forEach((cell, mx) => {
        if (cell !== "#") return;
        for (let y = 0; y < scale; y++)
          for (let x = 0; x < scale; x++) {
            const i = ((pad + my * scale + y) * size + pad + mx * scale + x) * 4;
            data[i] = data[i + 1] = data[i + 2] = 0;
          }
      }),
    );
    expect(jsQR(data, size, size)?.data).toBe("squeak://pair?d=eyJ2IjoxfQ");
  });
});
