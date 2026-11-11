// The account's profile photo: everything between "the person picked a file" and "a small JPEG the relay will keep".
// The file is never uploaded as it is. It is decoded, cropped to a square about its centre and drawn on a 256x256 canvas,
// and the canvas is exported as a new JPEG: drawing drops EXIF (location, camera, time) by construction, so only pixels
// leave. The quality steps down from 0.85 until the file fits the relay's 64 KB. The decode and canvas are passed in so
// the crop and the quality loop test as plain logic.

export const AVATAR_PX = 256;
export const AVATAR_MAX_BYTES = 64 * 1024;
export const START_QUALITY = 0.85;
export const QUALITY_STEP = 0.05;
export const MIN_QUALITY = 0.3;
/** A file this large is refused before it is decoded: a photo this big is not a profile picture. */
export const MAX_SOURCE_BYTES = 40 * 1024 * 1024;

export const AVATAR_SENTENCES = {
  type: "Choose a picture (a JPEG, PNG, HEIC or similar image file).",
  read: "Squeak could not read that picture. Try another one.",
  big: "That file is too large to use as a photo. Try a smaller one.",
  size: "That photo is still too large after shrinking it. Try a simpler picture.",
  image: "Squeak could not use that picture. Try another one.",
  busy: "You changed your photo a lot just now. Try again in an hour.",
  network: "Could not reach Squeak's server. Check your connection and try again.",
  signin: "Your sign-in ran out. Sign in again.",
  zohoDenied: "Zoho didn't share your photo.",
  zohoFailed: "Squeak couldn't get your Zoho photo. You can upload one instead.",
  zohoUnconfigured: "Using your Zoho photo isn't set up on this Squeak yet. You can upload one instead.",
};

/** The results the relay's Zoho callback leaves in the address (`#zoho-photo=<result>`). */
export const ZOHO_RESULTS = ["ready", "denied", "failed", "blocked"];

/**
 * Reads and removes a `#zoho-photo=<result>` fragment: the result word, or null when the page carries none (an unknown
 * word reads as "failed"). The address is cleaned before anything else runs.
 */
export function takeZohoPhotoFragment(location, history) {
  const hash = String(location?.hash ?? "");
  if (!hash.startsWith("#zoho-photo=")) return null;
  try {
    history.replaceState(history.state, "", location.pathname + location.search);
  } catch {
    // no history: the fragment stays, harmlessly
  }
  const word = hash.slice("#zoho-photo=".length);
  return ZOHO_RESULTS.includes(word) ? word : "failed";
}

/** What a result other than "ready" says, for the screen. */
export const zohoResultSentence = (result) =>
  result === "denied" ? AVATAR_SENTENCES.zohoDenied : AVATAR_SENTENCES.zohoFailed;

export class AvatarError extends Error {
  constructor(code) {
    super(AVATAR_SENTENCES[code] ?? AVATAR_SENTENCES.read);
    this.code = code;
  }
}

/** The largest centred square inside a width x height picture. */
export function squareCrop(width, height) {
  const size = Math.min(width, height);
  return { sx: Math.floor((width - size) / 2), sy: Math.floor((height - size) / 2), size };
}

/** The qualities tried, in order: 0.85, 0.80, ... down to the floor. */
export function qualities(start = START_QUALITY, step = QUALITY_STEP, min = MIN_QUALITY) {
  const out = [];
  for (let q = start; q >= min - 1e-9; q -= step) out.push(Math.round(q * 100) / 100);
  return out;
}

/** The first encoding no larger than `max` bytes, or null when even the lowest quality is too big. */
export async function encodeUnderLimit(encode, { max = AVATAR_MAX_BYTES, ...steps } = {}) {
  for (const quality of qualities(steps.start, steps.step, steps.min)) {
    const blob = await encode(quality);
    if (!blob) return null;
    if (blob.size <= max) return blob;
  }
  return null;
}

/** What a failed relay call says, for the screen. */
export function avatarSentence(error) {
  if (error instanceof AvatarError) return error.message;
  const status = error?.status;
  if (status === 401) return AVATAR_SENTENCES.signin;
  if (status === 429) return AVATAR_SENTENCES.busy;
  if (status === 413) return AVATAR_SENTENCES.size;
  if (status === 400) return AVATAR_SENTENCES.image;
  if (status === 503) return AVATAR_SENTENCES.zohoUnconfigured;
  return AVATAR_SENTENCES.network;
}

/** The browser's decode and canvas. Tests pass their own. */
export const browserEnv = {
  async decode(file) {
    const bitmap = await globalThis.createImageBitmap(file, { imageOrientation: "from-image" });
    return { width: bitmap.width, height: bitmap.height, source: bitmap, close: () => bitmap.close?.() };
  },
  canvas(px) {
    const canvas = document.createElement("canvas");
    canvas.width = px;
    canvas.height = px;
    const ctx = canvas.getContext("2d");
    return {
      ctx,
      toBlob: (quality) => new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", quality)),
    };
  },
};

/**
 * The picked file as a square JPEG Blob of at most 64 KB; throws AvatarError (`type`, `read`, `big`, `size`).
 * A transparent picture is put on white first, since JPEG has no transparency.
 */
export async function prepareAvatar(file, env = browserEnv) {
  if (!file || typeof file.type !== "string" || !file.type.startsWith("image/")) throw new AvatarError("type");
  if (file.size > MAX_SOURCE_BYTES) throw new AvatarError("big");
  let decoded;
  try {
    decoded = await env.decode(file);
  } catch {
    throw new AvatarError("read");
  }
  try {
    if (!(decoded.width > 0 && decoded.height > 0)) throw new AvatarError("read");
    const { sx, sy, size } = squareCrop(decoded.width, decoded.height);
    const target = env.canvas(AVATAR_PX);
    target.ctx.fillStyle = "#ffffff";
    target.ctx.fillRect(0, 0, AVATAR_PX, AVATAR_PX);
    target.ctx.drawImage(decoded.source, sx, sy, size, size, 0, 0, AVATAR_PX, AVATAR_PX);
    const blob = await encodeUnderLimit((quality) => target.toBlob(quality));
    if (!blob || blob.type !== "image/jpeg") throw new AvatarError(blob ? "read" : "size");
    return blob;
  } finally {
    decoded.close?.();
  }
}

/**
 * The photo's state for one screen: `{ url, at, busy, error }`, and the three things a person does. `api` is an
 * AccountApi (avatarBlob / avatarPut / avatarDelete); `onChange` redraws. Blob URLs are revoked when replaced.
 */
export function createAvatarController({
  api,
  onChange = () => undefined,
  prepare = prepareAvatar,
  makeUrl = (blob) => URL.createObjectURL(blob),
  revokeUrl = (url) => URL.revokeObjectURL(url),
} = {}) {
  const state = { url: null, at: null, busy: null, error: null, changed: false };
  const show = (blob, at) => {
    if (state.url) revokeUrl(state.url);
    state.url = blob ? makeUrl(blob) : null;
    state.at = blob ? at : null;
  };
  const run = async (busy, work) => {
    if (state.busy) return false;
    state.busy = busy;
    state.error = null;
    onChange();
    try {
      await work();
      return true;
    } catch (error) {
      state.error = avatarSentence(error);
      return false;
    } finally {
      state.busy = null;
      onChange();
    }
  };
  return {
    state,
    /** Loads the stored photo when `avatarAt` says there is one (and it is not the one already shown). */
    async load(avatarAt) {
      if (!avatarAt) {
        if (state.url) {
          show(null, null);
          onChange();
        }
        return;
      }
      if (state.url && state.at === avatarAt) return;
      try {
        const blob = await api.avatarBlob();
        show(blob, blob ? avatarAt : null);
      } catch {
        // The initial stays; nothing to say about a picture that did not load.
      }
      onChange();
    },
    change: (file) =>
      run("save", async () => {
        const blob = await prepare(file);
        const { at } = await api.avatarPut(blob);
        show(blob, at);
        state.changed = true;
      }),
    /**
     * Back from Zoho with `result` (takeZohoPhotoFragment): "ready" fetches the parked photo and saves it through the same
     * crop, shrink and put as a picked file; anything else says why in a fixed sentence.
     */
    async importZoho(result) {
      if (result !== "ready") {
        state.error = zohoResultSentence(result);
        onChange();
        return false;
      }
      return run("save", async () => {
        let blob;
        try {
          blob = await api.zohoPhotoBlob();
        } catch (error) {
          if (error?.status === 401) throw error;
          throw new AvatarError("zohoFailed");
        }
        if (!blob) throw new AvatarError("zohoFailed");
        const small = await prepare(blob).catch(() => {
          throw new AvatarError("zohoFailed");
        });
        const { at } = await api.avatarPut(small);
        show(small, at);
        state.changed = true;
      });
    },
    /** "Use my Zoho photo": asks the relay first (so an unset-up server answers in a sentence), then goes to Zoho. */
    async useZoho(go) {
      const ok = await run("zoho", async () => {
        await api.zohoPhotoStart();
      });
      if (ok) go(api.zohoPhotoStartUrl());
      return ok;
    },
    remove: () =>
      run("remove", async () => {
        await api.avatarDelete();
        show(null, null);
        state.changed = true;
      }),
    dispose() {
      show(null, null);
    },
  };
}
