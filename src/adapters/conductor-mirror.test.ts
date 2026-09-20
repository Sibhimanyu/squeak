import { describe, expect, it, vi } from "vitest";

import { ConductorMirrorWriter } from "./conductor-mirror.js";

describe("ConductorMirrorWriter", () => {
  it("stores Claude assistant messages using Claude-style structured content", () => {
    const registry = {
      appendSessionMessage: vi.fn(),
      updateSessionLastUserMessageAt: vi.fn(),
      updateSessionStatus: vi.fn(),
    };
    const stateStore = {
      addFingerprint: vi.fn(),
      buildFingerprint: vi.fn((_sessionId, _turnId, _role, content) => content),
      hasFingerprint: vi.fn().mockReturnValue(false),
    };

    const mirror = new ConductorMirrorWriter(registry as never, stateStore as never);

    mirror.appendAssistantMessage({
      agentType: "claude",
      sessionId: "session-1",
      threadId: "thread-1",
      turnId: "turn-1",
      text: "Hello from Claude",
      sentAt: "2026-04-04T07:40:00.000Z",
      model: "opus-1m",
    });

    expect(registry.appendSessionMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('"type":"assistant"'),
        model: "opus-1m",
        role: "assistant",
      }),
    );
    const content = registry.appendSessionMessage.mock.calls[0]?.[0]?.content as string;
    expect(content).toContain('"session_id":"thread-1"');
    expect(content).toContain("Hello from Claude");

    // The envelope must match what Conductor writes itself. Its own rows carry only
    // role/model/content/usage under `message`; the extra null fields this used to
    // emit made its UI render the row as "This message could not be displayed."
    const payload = JSON.parse(content);
    expect(Object.keys(payload).sort()).toEqual(
      ["message", "parent_tool_use_id", "session_id", "timestamp", "type", "uuid"].sort(),
    );
    expect(Object.keys(payload.message).sort()).toEqual(["content", "model", "role", "usage"].sort());
    expect(payload.message.usage).not.toBeNull();
    expect(payload.timestamp).toBe("2026-04-04T07:40:00.000Z");
    // Conductor resolves its picker alias to a catalog id before writing.
    expect(payload.message.model).toBe("claude-opus");
  });
});
