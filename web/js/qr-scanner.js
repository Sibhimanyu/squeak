// Scan the pairing QR from the Mac's screen. This only finds text: whatever it
// finds goes through the same parsePairingLink the paste box uses (same checks,
// same errors), and the pairing still waits for the owner to approve on the Mac.
//
// QrScan is the controller (everything it touches is injected so tests can fake
// the camera, the detector and the clock); frameReader and scanControl are the
// browser parts. The decoder is the browser's own BarcodeDetector when it reads
// QR codes, else the vendored jsQR (a local file, loaded only when needed:
// the page's CSP is script-src 'self').

import { PairingError, parsePairingLink } from "./pairing-link.js";

export const NOT_A_CODE = "That isn't a Squeak pairing code";
export const POINT_AT_CODE = "Point the camera at the QR code on your Mac";
export const HINT = "Open Settings › iPhone on your Mac and hold its QR code steady in view, or paste the code below.";
export const DENIED = "Camera access was blocked. Paste the pairing code below instead.";
export const NO_CAMERA = "No camera was found. Paste the pairing code below instead.";
export const CAMERA_FAILED = "The camera could not start. Paste the pairing code below instead.";

/** A real pairing code is a few hundred characters; anything far past that is not one. */
export const MAX_CODE_LENGTH = 4096;
const FRAME_MS = 125; // about 8 frames a second
const HINT_AFTER_MS = 3_000;

/** The camera needs a secure context and mediaDevices; without them the button is hidden. */
export function scanSupported(nav = globalThis.navigator, secure = globalThis.isSecureContext) {
  return Boolean(secure && typeof nav?.mediaDevices?.getUserMedia === "function");
}

/**
 * Checks decoded text the way the paste box would. Returns null when it is a
 * usable pairing code, else the sentence to show.
 */
export function rejectionFor(text, parse = parsePairingLink) {
  if (typeof text !== "string" || text.length > MAX_CODE_LENGTH) return NOT_A_CODE;
  try {
    parse(text);
    return null;
  } catch (error) {
    if (!(error instanceof PairingError)) return NOT_A_CODE;
    return error.message === "That is not a Squeak pairing code." ? NOT_A_CODE : error.message;
  }
}

export class QrScan {
  /**
   * @param {object} o
   * @param {{getUserMedia: Function}} o.mediaDevices
   * @param {{srcObject: any, play: Function}} o.video
   * @param {() => Promise<string|null>} o.readFrame  decoded text of the current frame, or null
   * @param {(text: string) => void} o.onText  called once, with a code that parsed, after the camera is off
   * @param {(status: {kind: string, message: string}) => void} o.onStatus
   * @param {() => number} [o.now]
   * @param {(fn: () => void) => any} [o.schedule]
   * @param {(handle: any) => void} [o.cancel]
   */
  constructor({ mediaDevices, video, readFrame, onText, onStatus, now, schedule, cancel, parse }) {
    this.mediaDevices = mediaDevices;
    this.video = video;
    this.readFrame = readFrame;
    this.onText = onText;
    this.onStatus = onStatus;
    this.now = now ?? (() => Date.now());
    this.schedule = schedule ?? ((fn) => globalThis.requestAnimationFrame(fn));
    this.cancel = cancel ?? ((handle) => globalThis.cancelAnimationFrame(handle));
    this.parse = parse ?? parsePairingLink;
    this.stream = null;
    this.handle = null;
    this.running = false;
    this.busy = false;
    this.lastFrameAt = -Infinity;
    this.wrongSince = null;
    this.status = null;
  }

  setStatus(kind, message) {
    if (this.status?.kind === kind && this.status.message === message) return;
    this.status = { kind, message };
    this.onStatus?.(this.status);
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.wrongSince = null;
    this.setStatus("asking", "Asking for the camera…");
    let stream;
    try {
      stream = await this.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    } catch (error) {
      this.running = false;
      this.setStatus("error", cameraError(error));
      return;
    }
    if (!this.running) {
      // Closed while the permission prompt was open.
      stopTracks(stream);
      return;
    }
    this.stream = stream;
    try {
      this.video.srcObject = stream;
      await this.video.play?.();
    } catch {
      this.stop();
      this.setStatus("error", CAMERA_FAILED);
      return;
    }
    if (!this.running) return;
    this.setStatus("scanning", POINT_AT_CODE);
    this.queue();
  }

  queue() {
    if (this.running) this.handle = this.schedule(() => void this.tick());
  }

  async tick() {
    if (!this.running) return;
    const at = this.now();
    if (!this.busy && at - this.lastFrameAt >= FRAME_MS) {
      this.lastFrameAt = at;
      this.busy = true;
      try {
        const text = await this.readFrame();
        if (this.running && text) this.found(text, at);
      } catch {
        // One bad frame is not worth a message; the next one is tried.
      } finally {
        this.busy = false;
      }
    }
    if (this.running && this.wrongSince !== null && this.now() - this.wrongSince >= HINT_AFTER_MS) {
      this.setStatus("hint", HINT);
    }
    this.queue();
  }

  found(text, at) {
    const reason = rejectionFor(text, this.parse);
    if (reason) {
      this.wrongSince ??= at;
      this.setStatus("wrong", reason);
      return;
    }
    this.stop();
    this.setStatus("done", "Got it.");
    this.onText(text);
  }

  /** Camera off: every track stopped, the video emptied. Safe to call twice. */
  stop() {
    this.running = false;
    if (this.handle !== null) this.cancel(this.handle);
    this.handle = null;
    if (this.stream) stopTracks(this.stream);
    this.stream = null;
    try {
      this.video.srcObject = null;
    } catch {
      // A video element that is already gone.
    }
  }
}

function stopTracks(stream) {
  for (const track of stream.getTracks?.() ?? []) track.stop();
}

export function cameraError(error) {
  const name = error?.name ?? "";
  if (name === "NotAllowedError" || name === "SecurityError" || name === "PermissionDeniedError") return DENIED;
  if (name === "NotFoundError" || name === "DevicesNotFoundError" || name === "OverconstrainedError") return NO_CAMERA;
  return CAMERA_FAILED;
}

/** Reads QR text off a downscaled copy of the video frame. */
export async function frameReader(video, { detectorFactory, loadDecoder } = {}) {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const detector = await (detectorFactory ?? nativeDetector)();
  const decoder = detector ? null : await (loadDecoder ?? loadJsQr)();
  return async () => {
    const { videoWidth: vw, videoHeight: vh } = video;
    if (!vw || !vh) return null;
    const scale = Math.min(1, 640 / Math.max(vw, vh));
    canvas.width = Math.round(vw * scale);
    canvas.height = Math.round(vh * scale);
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    if (detector) {
      const codes = await detector.detect(canvas);
      return codes[0]?.rawValue ?? null;
    }
    const image = context.getImageData(0, 0, canvas.width, canvas.height);
    return decoder(image.data, image.width, image.height, { inversionAttempts: "dontInvert" })?.data ?? null;
  };
}

async function nativeDetector() {
  try {
    const Detector = globalThis.BarcodeDetector;
    if (!Detector) return null;
    const formats = (await Detector.getSupportedFormats?.()) ?? ["qr_code"];
    return formats.includes("qr_code") ? new Detector({ formats: ["qr_code"] }) : null;
  } catch {
    return null;
  }
}

export async function loadJsQr() {
  return (await import("./vendor/jsQR.js")).default;
}

/**
 * The pairing screen's scan control: a button, and under it the camera while it
 * is open. Returns null where there is no camera or no secure context, so the
 * screen shows only the paste box. `onText` gets text that already parses.
 */
export function scanControl({ onText, h }) {
  if (!scanSupported()) return null;
  const button = h(
    "button",
    { class: "btn", type: "button", "aria-expanded": "false" },
    "Scan the QR code from your Mac",
  );
  const video = h("video", { class: "scan-video", muted: true, playsinline: true, "aria-hidden": "true" });
  video.muted = true;
  video.setAttribute("playsinline", "");
  const status = h("p", { class: "note scan-status", role: "status", "aria-live": "polite" });
  const cancel = h("button", { class: "btn quiet", type: "button" }, "Cancel");
  const panel = h("div", { class: "scan-panel", hidden: true }, video, status, cancel);
  const root = h("div", { class: "scan" }, button, panel);
  let scan = null;

  const close = (refocus) => {
    scan?.stop();
    scan = null;
    panel.hidden = true;
    button.setAttribute("aria-expanded", "false");
    window.removeEventListener("pagehide", onHide);
    window.removeEventListener("keydown", onKey, true);
    document.removeEventListener("visibilitychange", onVisibility);
    if (refocus) button.focus();
  };
  const onHide = () => close(false);
  const onVisibility = () => {
    if (document.hidden) close(false);
  };
  const onKey = (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close(true);
    }
  };

  button.addEventListener("click", async () => {
    if (scan) return;
    panel.hidden = false;
    button.setAttribute("aria-expanded", "true");
    window.addEventListener("pagehide", onHide);
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("visibilitychange", onVisibility);
    cancel.focus();
    const mine = new QrScan({
      mediaDevices: navigator.mediaDevices,
      video,
      readFrame: async () => null,
      onText: (text) => {
        close(false);
        onText(text);
      },
      onStatus: ({ kind, message }) => {
        status.textContent = message;
        // The camera is no use after a failure; the paste box stays as the way in.
        if (kind === "error") {
          scan = null;
          video.hidden = true;
          cancel.textContent = "Close";
        }
      },
    });
    scan = mine;
    video.hidden = false;
    cancel.textContent = "Cancel";
    try {
      mine.readFrame = await frameReader(video);
    } catch {
      mine.setStatus("error", CAMERA_FAILED);
      return;
    }
    await mine.start();
  });
  cancel.addEventListener("click", () => close(true));
  return root;
}
