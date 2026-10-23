/**
 * Regenerate the fixture both sides check the direct path's request signing
 * against (ios/SqueakCore/Tests/SqueakCoreTests/Fixtures/local-auth.json): a
 * fixed channel key, request and response, with every derived value as the
 * Mac computes it. The Swift test must reproduce each one byte for byte.
 *
 *   npx tsx scripts/make-local-fixture.ts
 */
import fs from "node:fs";
import path from "node:path";

import {
  bodyHash,
  deriveLocalKey,
  localTag,
  requestCanonical,
  responseCanonical,
  signRequest,
  signResponse,
} from "../src/remote/local-auth.js";

const out = path.resolve("ios/SqueakCore/Tests/SqueakCoreTests/Fixtures/local-auth.json");
const channelKey = Buffer.from(Array.from({ length: 32 }, (_, index) => index)).toString("base64");
const localKey = deriveLocalKey(channelKey);
const request = {
  method: "PUT",
  target: "/commands/0f4c8a52-3c1e-4b9e-9a57-6f0e2d1c7b31.json?print=silent",
  ts: "1790000000000",
  nonce: "00112233445566778899aabbccddeeff",
  body: '{"box":"AAAA","sig":"BBBB","device":"iphone-1"}',
};
const response = { nonce: request.nonce, status: 204, body: "" };
const readRequest = {
  method: "GET",
  target: "/state/snapshot.json",
  ts: "1790000000001",
  nonce: "ffeeddccbbaa99887766554433221100",
  body: "",
};
const readResponse = { nonce: readRequest.nonce, status: 200, body: '{"box":"CCCC","at":1790000000000}' };

fs.writeFileSync(
  out,
  `${JSON.stringify(
    {
      channelKey,
      localKey: localKey.toString("base64"),
      tag: localTag(channelKey),
      request: {
        ...request,
        bodyHash: bodyHash(request.body),
        canonical: requestCanonical(request),
        mac: signRequest(localKey, request),
      },
      response: { ...response, canonical: responseCanonical(response), mac: signResponse(localKey, response) },
      readRequest: { ...readRequest, mac: signRequest(localKey, readRequest) },
      readResponse: { ...readResponse, mac: signResponse(localKey, readResponse) },
    },
    null,
    2,
  )}\n`,
);
console.log(`wrote ${out}`);
