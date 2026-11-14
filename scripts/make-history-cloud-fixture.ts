// Writes the cloud copy of history exactly as the Mac makes it (src/remote/history-cloud.ts), for the phone's Swift test
// (ios/SqueakCore/Tests/SqueakCoreTests/Fixtures/history-cloud.json) and the web's. Run from the repo root:
//   npx tsx scripts/make-history-cloud-fixture.ts
import fs from "node:fs";
import { HistoryCloudSync, histPageDoc, HIST_INDEX_DOC, type HistStore } from "../src/remote/history-cloud.js";
import { open, seal } from "../src/remote/remote-crypto.js";

const key = Buffer.from("squeak-history-cloud-fixture-key").toString("base64");
const docs: Record<string, string> = {};
const store: HistStore = {
  get: async (doc) => docs[doc] ?? null,
  put: async (doc, box) => void (docs[doc] = box),
  delete: async (doc) => void delete docs[doc],
};
const rows = Array.from({ length: 120 }, (_, i) => ({
  id: `m${i}`,
  cursor: String(1000 + i * 3),
  role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
  text: `message ${i}`,
  at: new Date(Date.UTC(2026, 10, 14, 10, 0, i)).toISOString(),
  turnId: null,
}));
const read = (limit: number, before: number | null) => {
  const eligible = rows.filter((m) => before === null || Number(m.cursor) < before);
  const page = eligible.slice(-limit);
  return { messages: page, nextBefore: eligible.length > limit ? page[0]!.cursor : null };
};
const chatKey = "conductor:fixture-chat";
const now = Date.UTC(2026, 10, 15, 12, 0, 0);
let seq = 0;
await new HistoryCloudSync({
  store,
  seal: (v) => seal(key, v),
  open: <T>(box: string) => open<T>(key, box),
  candidates: () => [{ key: chatKey, activityAt: now - 60_000, read }],
  now: () => now,
  nextSeq: () => ++seq,
}).run();
const index = open<{ chats: Array<{ pages: Array<{ f: string }> }> }>(key, docs[HIST_INDEX_DOC]!);
const pages = Object.fromEntries(index.chats[0]!.pages.map((p) => [p.f, docs[histPageDoc(chatKey, p.f)]!]));
const out = new URL("../ios/SqueakCore/Tests/SqueakCoreTests/Fixtures/history-cloud.json", import.meta.url);
fs.writeFileSync(out, JSON.stringify({ key, chatKey, indexBox: docs[HIST_INDEX_DOC], pages }, null, 2) + "\n");
const web = new URL("../web/test/fixtures/history-cloud.json", import.meta.url);
fs.mkdirSync(new URL(".", web), { recursive: true });
fs.copyFileSync(out, web);
console.log("wrote", out.pathname, Object.keys(pages).length, "pages");
