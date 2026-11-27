/* eslint-disable @typescript-eslint/no-explicit-any -- the relay is untyped CommonJS; the SDK here is a set of fakes */
// The Catalyst SDK wiring in functions/squeak_relay/index.js. Found live 2026-11-27: with the people tables on, every call 500ed with
// INVALID_PROJECT_CREDENTIALS, because @zcatalyst/zcql@0.0.2 nests its own @zcatalyst/auth and rejects any app made by ours; and
// the wiring built its SDK objects eagerly, so one bad construction failed the whole request. The SDK is not installed in the repo,
// so its modules are faked while index.js loads.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const Module = require("node:module");
const fn = new URL("../functions/squeak_relay/", import.meta.url).pathname;

const built: string[] = [];
class FakeApp {
  constructor(public scope: string) {}
}
const rejectsForeignApp = (name: string) => (app: any) => {
  if (!(app instanceof FakeApp)) throw new Error(`INVALID_PROJECT_CREDENTIALS (${name})`);
};
class Datastore {
  constructor(public app: any) {
    rejectsForeignApp("datastore")(app);
    built.push(`datastore:${app.scope}`);
  }
  table(name: string) {
    return { insertRow: async (row: any) => ({ name, row, scope: this.app.scope }) };
  }
  async executeZCQLQuery(q: string) {
    return [{ q, scope: this.app.scope }];
  }
}
class NoSQL {
  constructor(app: any) {
    rejectsForeignApp("nosql")(app);
    built.push(`nosql:${app.scope}`);
  }
  table() {
    return { fetchItem: async () => ({ get: [] }) };
  }
}
class Stratus {
  constructor(app: any) {
    rejectsForeignApp("stratus")(app);
    built.push(`stratus:${app.scope}`);
  }
  bucket(name: string) {
    return { putObject: async (key: string) => `${name}/${key}` };
  }
}
const fakes: Record<string, any> = {
  "@zcatalyst/auth": { zcAuth: {}, UserManagement: class {} },
  "@zcatalyst/datastreams": { DataStreams: class {} },
  "@zcatalyst/nosql": {
    NoSQL,
    NoSQLItem: class {
      addString() {
        return this;
      }
      addNumber() {
        return this;
      }
    },
    NoSQLEnum: {},
    NoSQLMarshall: {},
  },
  "@zcatalyst/mail": { Mail: class {} },
  "@zcatalyst/datastore": { Datastore },
  "@zcatalyst/stratus": { Stratus },
  "@zcatalyst/utils": { CONSTANTS: { CREDENTIAL_USER: { user: "user", admin: "admin" } } },
};

let wiring: any;
const realLoad = Module._load;
beforeAll(() => {
  Module._load = function (request: string, ...rest: unknown[]) {
    if (request === "@zcatalyst/zcql") throw new Error("@zcatalyst/zcql must not be used (nested auth, 0.0.2)");
    if (fakes[request]) return fakes[request];
    return realLoad.call(this, request, ...rest);
  };
  wiring = require(`${fn}index.js`);
});
afterAll(() => {
  Module._load = realLoad;
});

describe("people tables", () => {
  it("run ZCQL through Datastore, never @zcatalyst/zcql", async () => {
    process.env.SQUEAK_PEOPLE_TABLES = "on";
    const people = wiring.peopleFor(() => new FakeApp("admin"), { removalNotice: false });
    await expect(people.membersOf("P".repeat(32))).resolves.toBeDefined();
    expect(built).toContain("datastore:admin");
  });

  it("build nothing when wired, so a bad credential fails the call and not the request", async () => {
    process.env.SQUEAK_PEOPLE_TABLES = "on";
    built.length = 0;
    const bad = { not: "an app" };
    const people = wiring.peopleFor(bad, { removalNotice: false });
    expect(built).toEqual([]);
    await expect(people.membersOf("P".repeat(32))).rejects.toThrow(/INVALID_PROJECT_CREDENTIALS/);
  });

  it("read the app at the moment of use (a long-lived service refreshes it per request)", async () => {
    process.env.SQUEAK_PEOPLE_TABLES = "on";
    let current: any = null;
    const people = wiring.peopleFor(
      () => {
        if (!current) throw new Error("no Catalyst credentials yet");
        return current;
      },
      { removalNotice: false },
    );
    await expect(people.membersOf("P".repeat(32))).rejects.toThrow(/no Catalyst credentials yet/);
    current = new FakeApp("admin");
    await expect(people.membersOf("P".repeat(32))).resolves.toBeDefined();
  });

  it("stay off unless asked", () => {
    process.env.SQUEAK_PEOPLE_TABLES = "off";
    expect(wiring.peopleFor(new FakeApp("admin"))).toBeUndefined();
  });
});

describe("the blob bucket", () => {
  it("is built at the first call, from an app that is still good", async () => {
    process.env.SQUEAK_BLOB_BUCKET = "squeak-blobs-1";
    built.length = 0;
    const bucket = wiring.blobBucketFor(new FakeApp("admin"));
    expect(built).toEqual([]);
    await bucket.put("k", Buffer.from("x"));
    expect(built).toEqual(["stratus:admin"]);
  });

  it("does not exist without a bucket name", () => {
    delete process.env.SQUEAK_BLOB_BUCKET;
    expect(wiring.blobBucketFor(new FakeApp("admin"))).toBeUndefined();
  });
});

describe("the NoSQL store", () => {
  it("is not built until used", async () => {
    built.length = 0;
    const store = wiring.storeFor(() => new FakeApp("user"));
    expect(built).toEqual([]);
    await store.get("pk", "doc");
    expect(built).toEqual(["nosql:user"]);
  });
});

describe("the SDK versions", () => {
  const dirs = ["functions/squeak_relay"];
  for (const d of dirs) {
    it(`${d} lists no @zcatalyst/zcql and its lockfile nests no second @zcatalyst/auth`, () => {
      const pkg = JSON.parse(readFileSync(new URL(`../${d}/package.json`, import.meta.url), "utf8"));
      expect(Object.keys(pkg.dependencies)).not.toContain("@zcatalyst/zcql");
      const lock = JSON.parse(readFileSync(new URL(`../${d}/package-lock.json`, import.meta.url), "utf8"));
      const nested = Object.keys(lock.packages).filter(
        (k) =>
          /node_modules\/@zcatalyst\/(auth|auth-client)$/.test(k) &&
          k !== "node_modules/@zcatalyst/auth" &&
          k !== "node_modules/@zcatalyst/auth-client",
      );
      expect(nested).toEqual([]);
    });
  }
});

describe("the project-scoped app", () => {
  it("is initialised with admin scope from the request's own headers", async () => {
    const { adminAppOf } = require(`${fn}app-access.js`);
    const calls: any[] = [];
    const zcAuth = { init: async (...a: any[]) => (calls.push(a), new FakeApp("admin")) };
    const req = { headers: { "x-zc-projectid": "1" } };
    await adminAppOf(zcAuth, req);
    expect(calls[0][0]).toBe(req);
    expect(calls[0][1]).toMatchObject({ scope: "admin" });
  });
});
