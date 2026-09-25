/**
 * The smallest Firestore client the channel needs: get, set, list, delete of
 * documents shaped `{ box, sig?, device?, at? }` (see firebase/firestore.rules).
 *
 * REST rather than the Firebase SDK: four verbs do not justify a dependency
 * in a package published to npm, and the iPhone app talks to the same REST
 * API, so both sides encode documents identically. Unauthenticated on
 * purpose — the rules allow only the channel shape, and everything in it is
 * encrypted and (for commands) signed. See docs/remote-channel.md.
 */

export interface ChannelDoc {
  box: string;
  sig?: string;
  device?: string;
  at?: number;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

interface FirestoreValue {
  stringValue?: string;
  integerValue?: string;
}

export class FirestoreRest {
  private readonly base: string;
  private readonly fetchImpl: FetchLike;

  constructor(projectId: string, fetchImpl: FetchLike = fetch) {
    this.base = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(projectId)}/databases/(default)/documents`;
    this.fetchImpl = fetchImpl;
  }

  async get(path: string): Promise<ChannelDoc | null> {
    const response = await this.fetchImpl(`${this.base}/${path}`, { signal: AbortSignal.timeout(10_000) });
    if (response.status === 404) {
      return null;
    }
    await ensureOk(response, "get");
    return decode((await response.json()) as { fields?: Record<string, FirestoreValue> });
  }

  async set(path: string, doc: ChannelDoc): Promise<void> {
    const response = await this.fetchImpl(`${this.base}/${path}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ fields: encode(doc) }),
      signal: AbortSignal.timeout(10_000),
    });
    await ensureOk(response, "set");
  }

  async list(collection: string): Promise<Array<{ id: string; doc: ChannelDoc }>> {
    const response = await this.fetchImpl(`${this.base}/${collection}?pageSize=100`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 404) {
      return [];
    }
    await ensureOk(response, "list");
    const body = (await response.json()) as {
      documents?: Array<{ name: string; fields?: Record<string, FirestoreValue> }>;
    };
    return (body.documents ?? []).flatMap((document) => {
      const doc = decode(document);
      return doc ? [{ id: document.name.split("/").pop() ?? "", doc }] : [];
    });
  }

  async delete(path: string): Promise<void> {
    const response = await this.fetchImpl(`${this.base}/${path}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 404) {
      await ensureOk(response, "delete");
    }
  }
}

export function encode(doc: ChannelDoc): Record<string, FirestoreValue> {
  const fields: Record<string, FirestoreValue> = { box: { stringValue: doc.box } };
  if (doc.sig !== undefined) fields.sig = { stringValue: doc.sig };
  if (doc.device !== undefined) fields.device = { stringValue: doc.device };
  if (doc.at !== undefined) fields.at = { integerValue: String(Math.trunc(doc.at)) };
  return fields;
}

export function decode(document: { fields?: Record<string, FirestoreValue> }): ChannelDoc | null {
  const fields = document.fields ?? {};
  const box = fields.box?.stringValue;
  if (typeof box !== "string") {
    return null;
  }
  const doc: ChannelDoc = { box };
  if (typeof fields.sig?.stringValue === "string") doc.sig = fields.sig.stringValue;
  if (typeof fields.device?.stringValue === "string") doc.device = fields.device.stringValue;
  if (typeof fields.at?.integerValue === "string") doc.at = Number(fields.at.integerValue);
  return doc;
}

async function ensureOk(response: Response, verb: string): Promise<void> {
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`firestore ${verb} failed: ${response.status} ${detail.slice(0, 200)}`);
  }
}
