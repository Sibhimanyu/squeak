// The daily smoke: the People and remote journey (src/flotilla/people-journey.test-fixture.ts), the same steps CI runs on the relay
// double, against a REAL DEVELOPMENT relay. Never run it against the live production relay: it invites people, makes and deletes a
// Pond, and sends real invitation mail to the three accounts' addresses.
//
//   SQUEAK_SMOKE_RELAY_URL=https://<dev relay>/server/squeak_relay \
//   SQUEAK_SMOKE_OWNER_TOKEN=... SQUEAK_SMOKE_INVITEE_TOKEN=... SQUEAK_SMOKE_MEMBER_TOKEN=... \
//   npx tsx scripts/smoke-people.ts
//
// The tokens are account tokens (`x-squeak-account`, 30 days) of three development accounts. With the URL unset it skips cleanly
// (exit 0), so a workflow without the secret is not red. A failed step exits 1 and names the step. Steps a real relay cannot do
// (move its clock to expire an invite, read its mail, open its live hub) are skipped and listed.
import fs from "node:fs";

import { liveRelayWorld } from "../src/flotilla/live-relay-world.test-fixture.js";
import { peopleJourney } from "../src/flotilla/people-journey.test-fixture.js";

process.env.SQUEAK_POND_OWN_THREADS = "on";

const url = process.env.SQUEAK_SMOKE_RELAY_URL;
if (!url) {
  console.log("smoke-people: SQUEAK_SMOKE_RELAY_URL is not set; skipped.");
  process.exit(0);
}
const tokens = {
  owner: process.env.SQUEAK_SMOKE_OWNER_TOKEN,
  invitee: process.env.SQUEAK_SMOKE_INVITEE_TOKEN,
  member: process.env.SQUEAK_SMOKE_MEMBER_TOKEN,
};
if (!tokens.owner || !tokens.invitee || !tokens.member) {
  console.error("smoke-people: SQUEAK_SMOKE_RELAY_URL is set but one of the three account tokens is not.");
  process.exit(1);
}

const steps: Array<{ name: string; run: () => Promise<void> }> = [];
const world = await liveRelayWorld({
  relayUrl: url,
  tokens: { owner: tokens.owner, invitee: tokens.invitee, member: tokens.member },
});
peopleJourney(world, (name, run) => void steps.push({ name, run }));

console.log(`smoke-people: ${steps.length} steps against ${new URL(url).host}`);
let failed: string | null = null;
for (const { name, run } of steps) {
  const began = Date.now();
  try {
    await run();
    console.log(`  ok   ${name} (${Date.now() - began} ms)`);
  } catch (error) {
    failed = name;
    console.error(`  FAIL ${name}`);
    console.error(error instanceof Error ? (error.stack ?? error.message) : String(error));
    break;
  }
}
console.log(
  "smoke-people: not covered on a real relay: invite expiry by the clock, the mail sink, the live hub and its notice counts.",
);
for (const d of world.dirs) fs.rmSync(d, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
