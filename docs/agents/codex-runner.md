# Codex in the session host

How Codex's app-server behaves where it differs from Claude's SDK. `src/native/codex-runner.ts` maps Squeak onto it;
`src/adapters/codex-app-server.ts` is the JSON-RPC client.

## Reading the protocol

The installed Codex is the source of truth, not memory:

```bash
codex app-server generate-json-schema --out /tmp/codex-schema   # every request, response and notification
# then e.g. definitions.AskForApproval in codex_app_server_protocol.v2.schemas.json
```

Behaviour the schema doesn't state (error texts, `_meta` keys) is in the binary: `strings ~/.local/bin/codex | grep -i <word>`.
What a turn actually ran with is in its rollout, `~/.codex/sessions/YYYY/MM/DD/rollout-*-<threadId>.jsonl`: each
`turn_context` line carries `approval_policy` and `sandbox_policy`.

## Differences that have caused bugs

- **The approval policy is fixed when a turn starts.** `turn/start` carries it; switching a chat's mode mid-turn reaches
  Codex only on the next turn. The host answers for the person meanwhile (`SessionHost.autoAllow`, Codex chats only).
- **Plain `never` rejects every MCP tool call that needs approval** ("MCP tool call requires approval, but approval
  policy is never"), so connector writes (GitHub) fail. Skip approvals sends `SKIP_APPROVALS`, a `granular` policy that
  asks only for MCP elicitations. The runner accepts the ones Codex tags as its own tool-call approval
  (`codex_approval_kind` is `mcp_tool_call` in the request's `_meta`); real MCP forms are not auto-accepted.
- **Items can land after `turn/completed`.** A background command finishing late sends `item/completed` with no turn
  open. Codex never starts a turn without `turn/started`, so the runner records it as a `system/note`; fed as an agent row
  it would open a self-started turn nothing ends (the chat shows Working for good).
- **`on-request` + `workspace-write` is Codex's Auto preset** (edits without asking), so ask-first is `untrusted`.
- **No skills list from the host.** `/native/commands` is Claude-only; Codex composers use the local scan.
