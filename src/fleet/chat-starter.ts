// What starts a chat in some host: the agents a chat can run, and the port a source implements.

export type NewChatAgent = "claude" | "codex";

export type StartChatOutcome = { ok: true; sessionId: string } | { ok: false; reason: string };

export interface ChatStarter {
  startChat(args: {
    workspaceId: string;
    agent: NewChatAgent;
    text: string;
    /** A model alias from `listChatModels`, and a thinking level it takes; both absent: the workspace's usual. */
    model?: string;
    thinking?: string;
    /** What the agent receives instead of `text` (the work split in front of it); the chat shows `text`. */
    agentText?: string;
  }): Promise<StartChatOutcome>;
}
