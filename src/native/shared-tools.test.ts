import path from "node:path";
import os from "node:os";

import { describe, expect, it } from "vitest";

import { createSharedTools } from "./shared-tools.js";
import { NativeStore } from "./store.js";
import { WorkspaceManager } from "./workspaces.js";

describe("createSharedTools", () => {
  it("gives the agent tools the same Placement the server gets (streams, open_stream and leave_stream need one)", () => {
    const store = new NativeStore(":memory:");
    const workspaces = new WorkspaceManager({ store, workspacesRoot: path.join(os.tmpdir(), "shared-tools-ws") });
    const shared = createSharedTools({
      store,
      workspaces,
      send: async () => {},
      create: async () => {
        throw new Error("unused");
      },
      post: () => {},
    } as never);
    expect(shared.placement).toBeDefined();
    expect((shared.tools as unknown as { deps: { placement?: unknown } }).deps.placement).toBe(shared.placement);
  });
});
