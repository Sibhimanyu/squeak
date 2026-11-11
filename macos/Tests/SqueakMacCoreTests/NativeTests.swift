import Foundation
import Testing
@testable import SqueakMacCore

// Rows are the shapes in .context/research/spike-claude-sdk.md and spike-codex.md.

private func row(_ seq: Int, _ role: String, _ kind: String, _ json: String) -> NativeMessage {
    NativeMessage(seq: seq, role: role, kind: kind, payload: NativeJSON.parse(json)!, createdAt: Date(timeIntervalSince1970: 1_800_000_000 + Double(seq)))
}

private func claudeTurn() -> [NativeMessage] {
    [
        row(1, "user", "user/text", #"{"text":"fix the build"}"#),
        row(2, "agent", "system/init", #"{"type":"system","subtype":"init","session_id":"abc"}"#),
        row(3, "agent", "assistant", #"{"type":"assistant","message":{"id":"m1","content":[{"type":"thinking","thinking":"The build fails on one import.","signature":"x"}]}}"#),
        row(4, "agent", "assistant", #"{"type":"assistant","message":{"id":"m1","content":[{"type":"text","text":"Let me look."}]}}"#),
        row(5, "agent", "assistant", #"{"type":"assistant","message":{"id":"m1","content":[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"npm run build\nnext","description":"Build"}}]}}"#),
        row(6, "agent", "user", #"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_1","is_error":true,"content":"line1\nerror: bad import\n"}]}}"#),
        row(7, "agent", "assistant", #"{"type":"assistant","message":{"id":"m2","content":[{"type":"tool_use","id":"toolu_2","name":"Edit","input":{"file_path":"/w/src/a.ts","old_string":"import x\nkeep","new_string":"import y\nkeep\nmore"}}]}}"#),
        row(8, "agent", "user", #"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"toolu_2","is_error":false,"content":"ok"}]}}"#),
        row(9, "agent", "assistant", #"{"type":"assistant","message":{"id":"m2","content":[{"type":"tool_use","id":"toolu_3","name":"Write","input":{"file_path":"/w/new.txt","content":"a\nb\n"}}]}}"#),
        row(10, "agent", "assistant", #"{"type":"assistant","parent_tool_use_id":"toolu_9","message":{"content":[{"type":"text","text":"subagent chatter"}]}}"#),
        row(11, "agent", "assistant", #"{"type":"assistant","message":{"id":"m3","content":[{"type":"text","text":"Fixed."}]}}"#),
        row(12, "agent", "result/success", #"{"type":"result","subtype":"success","result":"Fixed."}"#),
    ]
}

struct NativeTranscriptTests {
    @Test func claudeTurnMapsToMessagesStepsAndDetails() throws {
        let m = NativeTranscript.map(claudeTurn())
        #expect(m.messages.map(\.id) == ["native-1", "native-4", "native-11"])
        #expect(m.messages.map(\.role) == [.user, .assistant, .assistant])
        #expect(m.messages.map(\.cursor) == ["1", "4", "11"])
        #expect(Set(m.messages.compactMap(\.turnId)) == ["t1"])
        #expect(m.steps.map(\.kind) == ["you", "thinking", "note", "tool", "tool", "tool", "note"])
        #expect(m.steps.filter { $0.kind == "tool" }.map(\.text) == ["npm run build", "Edit a.ts", "Write new.txt"])
        // A Bash call keeps its command and the tail of its output; the error flag is the result's.
        #expect(m.details["toolu_1"] == .output(command: "npm run build\nnext", tail: ["line1", "error: bad import"], succeeded: false))
        // An edit shows what it changed, from its input.
        guard case .diff(let path, let lines)? = m.details["toolu_2"] else { Issue.record("no diff"); return }
        #expect(path == "/w/src/a.ts")
        #expect(lines.map(\.kind) == [.removed, .removed, .added, .added, .added])
        #expect(InlineDiff.stat(lines) == (3, 2))
        guard case .diff(_, let written)? = m.details["toolu_3"] else { Issue.record("no write diff"); return }
        #expect(written.map(\.text) == ["a", "b"] && written.map(\.number) == [1, 2])
        #expect(m.steps.first { $0.toolId == "toolu_3" }?.text == "Write new.txt")
    }

    @Test func aRefusedEditHasNoDiffAndUnknownToolsReadAsUse() {
        var rows = [row(1, "user", "user/text", #"{"text":"go"}"#)]
        rows.append(row(2, "agent", "assistant", #"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"e","name":"Edit","input":{"file_path":"/a/b.ts","old_string":"x","new_string":"y"}}]}}"#))
        rows.append(row(3, "agent", "user", #"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"e","is_error":true,"content":[{"type":"text","text":"no match"}]}]}}"#))
        rows.append(row(4, "agent", "assistant", #"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"g","name":"mcp__zoho__listThings","input":{}},{"type":"tool_use","id":"s","name":"Grep","input":{"pattern":"queue"}}]}}"#))
        let m = NativeTranscript.map(rows)
        #expect(m.details["e"] == nil)
        #expect(m.steps.map(\.text).suffix(2) == ["Use zoho: listThings", "Search for \"queue\""])
        #expect(ToolCallLabel.preview("Search for \"queue\"").kind == .search)
    }

    @Test func subagentsSqueakNotesAndProgressMapUnderTheirRows() {
        let rows = [
            row(1, "user", "user/text", #"{"text":"go"}"#),
            row(2, "agent", "assistant", #"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t","name":"Agent","input":{"description":"Extract the bundle","subagent_type":"general-purpose"}}]}}"#),
            row(3, "agent", "assistant", #"{"type":"assistant","parent_tool_use_id":"t","message":{"content":[{"type":"tool_use","id":"c1","name":"Read","input":{"file_path":"/x/INDEX.md"}}]}}"#),
            row(4, "agent", "assistant", #"{"type":"assistant","parent_tool_use_id":"t","message":{"content":[{"type":"text","text":"Found it.\nmore"}]}}"#),
            row(5, "agent", "user", #"{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"t","content":[{"type":"text","text":"Extracted 3 files."}]}]}}"#),
            row(6, "agent", "assistant", #"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"k","name":"ToolSearch","input":{"query":"select:TodoWrite,TaskCreate"}},{"type":"tool_use","id":"m","name":"mcp__squeak__list_chats","input":{}},{"type":"tool_use","id":"sk","name":"Skill","input":{"skill":"review"}}]}}"#),
            row(7, "system", "squeak/agent-message", #"{"text":"Sent to \"Builder\"","to":"b","message":"Build the parser"}"#),
            row(8, "system", "squeak/progress", #"{"steps":["Plan","Build"],"current":1,"percent":40,"status":"building"}"#),
            row(9, "system", "squeak/notify", #"{"title":null,"text":"PR ready"}"#),
        ]
        let m = NativeTranscript.map(rows)
        #expect(m.details["t"] == .subagent(steps: ["Read INDEX.md", "Found it."], result: "Extracted 3 files."))
        let tools = m.steps.filter { $0.kind == "tool" }.map(\.text)
        #expect(tools == [
            "Start Extract the bundle", "Load tools TodoWrite, TaskCreate", "Find other chats", "Use the review skill",
            "Message \"Builder\"", "Notify you: PR ready",
        ])
        #expect(m.steps.first { $0.text.hasPrefix("Message") }?.detail == .text("Build the parser"))
        #expect(m.steps.last { $0.kind == "progress" }?.detail == .progress(steps: ["Plan", "Build"], current: 1, percent: 40, status: "building"))
        #expect(ToolCallLabel.preview("Message \"Builder\"").kind == .agent)
        #expect(ToolCallLabel.preview("Notify you: PR ready").verb == "Notify")
        #expect(ChatTimeline.workingLabel([ActivityStep(kind: "progress", text: "building")]) == "Starting…")
        // A step's own detail reaches its row when the feed's map has none.
        let block = TurnFolding.block(steps: m.steps, working: false)
        #expect(block.folded.contains { if case .tool(_, _, _, .text("Build the parser")?) = $0 { true } else { false } })
    }

    /// Shapes captured from a real claude-haiku-5-5 chat that launched one background subagent (2026-11-09).
    private func backgroundRows(finished: Bool) -> [NativeMessage] {
        var rows = [
            row(1, "user", "user/text", #"{"text":"launch one background agent"}"#),
            row(2, "agent", "assistant", #"{"type":"assistant","parent_tool_use_id":null,"message":{"content":[{"type":"tool_use","id":"toolu_bg","name":"Agent","input":{"description":"Reply PONG","prompt":"Reply with the word PONG only.","run_in_background":true}}]}}"#),
            row(3, "agent", "system/background_tasks_changed", #"{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"ad39","run_id":"r","task_type":"local_agent","description":"Reply PONG"}]}"#),
            row(4, "agent", "system/task_started", #"{"type":"system","subtype":"task_started","task_id":"ad39","run_id":"r","tool_use_id":"toolu_bg","description":"Reply PONG","is_backgrounded":true,"task_type":"local_agent"}"#),
            row(5, "agent", "user", #"{"type":"user","message":{"role":"user","content":[{"tool_use_id":"toolu_bg","type":"tool_result","content":[{"type":"text","text":"Async agent launched successfully.\nagentId: ad39"}]}]},"parent_tool_use_id":null,"tool_use_result":{"isAsync":true,"status":"async_launched","agentId":"ad39"}}"#),
            row(6, "agent", "assistant", #"{"type":"assistant","parent_tool_use_id":"toolu_bg","agent_id":"ad39","message":{"content":[{"type":"text","text":"PONG"}]}}"#),
        ]
        if finished {
            rows += [
                row(7, "agent", "system/task_notification", #"{"type":"system","subtype":"task_notification","task_id":"ad39","tool_use_id":"toolu_bg","status":"completed","summary":"PONG"}"#),
                row(8, "agent", "system/background_tasks_changed", #"{"type":"system","subtype":"background_tasks_changed","tasks":[]}"#),
            ]
        }
        return rows
    }

    @Test func aBackgroundSubagentRunsThenReportsItsAnswer() {
        let running = NativeTranscript.map(backgroundRows(finished: false))
        #expect(running.details["toolu_bg"] == .subagent(steps: ["PONG"], result: nil, state: .running))
        let block = TurnFolding.block(steps: running.steps, working: false, details: running.details)
        #expect(block.folded.contains { if case .tool(_, _, true, _) = $0 { true } else { false } })

        let done = NativeTranscript.map(backgroundRows(finished: true))
        #expect(done.details["toolu_bg"] == .subagent(steps: ["PONG"], result: "PONG", state: .done))
        let ended = TurnFolding.block(steps: done.steps, working: false, details: done.details)
        #expect(ended.folded.contains { if case .tool(_, _, false, _) = $0 { true } else { false } })
    }

    @Test func aBackgroundSubagentThatFailsOrLosesItsReportEnds() {
        var rows = backgroundRows(finished: false)
        rows.append(row(7, "agent", "system/task_notification", #"{"type":"system","subtype":"task_notification","task_id":"ad39","tool_use_id":"toolu_bg","status":"failed","summary":"It crashed"}"#))
        #expect(NativeTranscript.map(rows).details["toolu_bg"] == .subagent(steps: ["PONG"], result: "It crashed", state: .failed))
        // No report, but the live set no longer lists the task: it is over.
        var lost = backgroundRows(finished: false)
        lost.append(row(7, "agent", "system/background_tasks_changed", #"{"type":"system","subtype":"background_tasks_changed","tasks":[]}"#))
        if case .subagent(_, nil, let state)? = NativeTranscript.map(lost).details["toolu_bg"] { #expect(state == .done) } else { Issue.record("no subagent detail") }
    }

    @Test func aTaskNotificationIsNotAPersonsTurnOrMessage() {
        let text = "<task-notification>\n<task-id>ad39</task-id>\n<tool-use-id>toolu_bg</tool-use-id>\n<status>completed</status>\n<summary>PONG</summary>\n</task-notification>"
        var rows = backgroundRows(finished: false)
        rows.append(row(7, "user", "user/text", #"{"text":"\#(text.replacingOccurrences(of: "\n", with: "\\n"))"}"#))
        rows.append(row(8, "agent", "user", #"{"type":"user","message":{"role":"user","content":"\#(text.replacingOccurrences(of: "\n", with: "\\n"))"}}"#))
        let m = NativeTranscript.map(rows)
        #expect(m.messages.filter { $0.role == .user }.count == 1)
        #expect(m.steps.filter { $0.kind == "you" }.count == 1)
        #expect(m.details["toolu_bg"] == .subagent(steps: ["PONG"], result: "PONG", state: .done))
        #expect(NativeTranscript.currentTurn(rows)?.first?.seq == 1)
        #expect(NativeTranscript.notifications(in: "please explain <task-notification>") == nil)
    }

    @Test func codexItemsMapToMessagesCommandsAndDiffs() {
        let rows = [
            row(1, "user", "user/text", #"{"text":"add a file"}"#),
            row(2, "agent", "item/reasoning", #"{"type":"reasoning","id":"r","summary":["Planning the change"]}"#),
            row(3, "agent", "item/commandExecution", #"{"type":"commandExecution","id":"exec-1","command":"/bin/bash -lc 'npm test'","status":"completed","aggregatedOutput":"ok\n3 passed\n","exitCode":0}"#),
            row(4, "agent", "item/commandExecution", #"{"type":"commandExecution","id":"exec-2","command":"/bin/bash -lc \"false\"","status":"failed","aggregatedOutput":null,"exitCode":1}"#),
            row(5, "agent", "item/fileChange", #"{"type":"fileChange","id":"fc-1","status":"completed","changes":[{"path":"/w/a.txt","kind":{"type":"add"},"diff":"hi\nthere\n"},{"path":"/w/b.ts","kind":{"type":"update"},"diff":"@@ -1,2 +1,2 @@\n keep\n-old\n+new\n"}]}"#),
            row(6, "agent", "item/agentMessage", #"{"type":"agentMessage","id":"a","text":"Done.","phase":"final_answer"}"#),
            row(7, "agent", "turn/completed", #"{"id":"turn-1","status":"completed"}"#),
        ]
        let m = NativeTranscript.map(rows)
        #expect(m.messages.map(\.text) == ["add a file", "Done."])
        #expect(m.steps.map(\.kind) == ["you", "thinking", "tool", "tool", "tool", "tool", "note"])
        #expect(m.steps.filter { $0.kind == "tool" }.map(\.text) == ["npm test", "false", "Write a.txt", "Edit b.ts"])
        #expect(m.details["exec-1"] == .output(command: "npm test", tail: ["ok", "3 passed"], succeeded: true))
        #expect(m.details["exec-2"] == .output(command: "false", tail: [], succeeded: false))
        guard case .diff(_, let added)? = m.details["fc-1"] else { Issue.record("no add diff"); return }
        #expect(added.map(\.kind) == [.added, .added])
        guard case .diff(let p, let upd)? = m.details["fc-1#1"] else { Issue.record("no update diff"); return }
        #expect(p == "/w/b.ts" && upd.map(\.kind) == [.hunk, .context, .removed, .added])
    }

    @Test func currentTurnStartsAtTheNewestPersonMessage() {
        var rows = claudeTurn()
        rows.append(row(13, "user", "user/text", #"{"text":"now the tests"}"#))
        rows.append(row(14, "agent", "assistant", #"{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t9","name":"Read","input":{"file_path":"/w/x.ts"}}]}}"#))
        let turn = NativeTranscript.currentTurn(rows)
        #expect(turn?.map(\.seq) == [13, 14])
        #expect(NativeTranscript.map(turn!).steps.map(\.text) == ["now the tests", "Read x.ts"])
        #expect(NativeTranscript.currentTurn([row(1, "agent", "assistant", "{}")]) == nil)
    }

    @Test func turnFoldingAttachesDetailsByToolId() {
        let m = NativeTranscript.map(claudeTurn())
        let block = TurnFolding.block(steps: m.steps, working: false, details: m.details)
        let tools = block.folded.compactMap { item -> ToolDetail? in
            if case .tool(_, _, _, let d) = item { return d }
            return nil
        }
        #expect(tools.count == 3)
        // Without details nothing expands, as before.
        let bare = TurnFolding.block(steps: m.steps, working: false)
        #expect(bare.folded.allSatisfy { if case .tool(_, _, _, let d) = $0 { return d == nil } else { return true } })
    }
}

// MARK: Client

private final class Stub: HTTPTransport, @unchecked Sendable {
    private let lock = NSLock()
    private var log: [HTTPRequest] = []
    let handler: @Sendable (HTTPRequest) throws -> HTTPResponse
    init(_ handler: @escaping @Sendable (HTTPRequest) throws -> HTTPResponse) { self.handler = handler }
    var requests: [HTTPRequest] { lock.withLock { log } }
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        lock.withLock { log.append(request) }
        return try handler(request)
    }
}

private func ok(_ json: String, _ status: Int = 200) -> HTTPResponse { HTTPResponse(status: status, body: Data(json.utf8)) }

private func host(_ stub: Stub, token: String? = "tok") -> NativeHostClient {
    NativeHostClient(baseURL: URL(string: "http://127.0.0.1:8479")!, transport: stub, tokenProvider: { token })
}

struct NativeHostClientTests {
    @Test func everyCallCarriesTheTokenAndTheRightRoute() async throws {
        let stub = Stub { r in
            switch (r.method, r.url.path) {
            case ("GET", "/native/sessions"):
                return ok(#"{"sessions":[{"id":"s1","cwd":"/w","agent":"codex","model":"gpt","permissionMode":"plan","status":"working","updatedAt":"2026-11-08T10:00:00.123Z","prunedThrough":0}]}"#)
            case ("POST", "/native/sessions/s1/model"), ("POST", "/native/sessions/s1/mode"), ("POST", "/native/sessions/s1/interrupt"),
                 ("PATCH", "/native/sessions/s1/queue/q1"), ("DELETE", "/native/sessions/s1/queue/q1"),
                 ("POST", "/native/sessions/s1/queue/q1/steer"), ("POST", "/native/requests/r1"):
                return ok(#"{"ok":true}"#)
            case ("GET", "/native/sessions/s1/queue"): return ok(#"{"queue":[{"id":"q1","sessionId":"s1","text":"later","createdAt":"2026-11-08T10:00:00.000Z"}]}"#)
            case ("GET", "/native/sessions/s1/requests"):
                return ok(#"{"requests":[{"id":"r1","sessionId":"s1","kind":"plan","payload":{"toolName":"ExitPlanMode","input":{"plan":"1. do it"}}}]}"#)
            case ("POST", "/native/sessions/s1/messages"): return ok(#"{"queued":true}"#)
            default: return ok(#"{"error":"not found"}"#, 404)
            }
        }
        let h = host(stub)
        let sessions = try await h.sessions()
        #expect(sessions.first?.status == "working" && sessions.first?.updatedAt != nil)
        try await h.setModel(id: "s1", model: "gpt-next", effort: "high")
        try await h.setMode(id: "s1", permissionMode: "acceptEdits")
        try await h.interrupt(id: "s1")
        try await h.editQueued(id: "s1", queueId: "q1", text: "edited")
        try await h.removeQueued(id: "s1", queueId: "q1")
        try await h.steerQueued(id: "s1", queueId: "q1")
        try await h.respond(requestId: "r1", allow: false, message: "no", answers: nil)
        #expect(try await h.queue(id: "s1").map(\.text) == ["later"])
        let reqs = try await h.openRequests(id: "s1")
        #expect(reqs.first?.kind == "plan" && reqs.first?.payload["input"]?["plan"]?.string == "1. do it")
        #expect(try await h.send(id: "s1", text: "hi", mode: .steer) == true)
        #expect(stub.requests.allSatisfy { $0.headers["x-squeak-token"] == "tok" })
        let model = try #require(stub.requests.first { $0.url.path.hasSuffix("/model") })
        #expect(NativeJSON.parse(String(decoding: model.body ?? Data(), as: UTF8.self))?["effort"]?.string == "high")
        let respond = try #require(stub.requests.first { $0.url.path == "/native/requests/r1" })
        #expect(NativeJSON.parse(String(decoding: respond.body ?? Data(), as: UTF8.self))?["decision"]?.string == "deny")
    }

    @Test func failuresSayWhatHappened() async throws {
        let down = Stub { _ in throw TransportError.connectionRefused }
        await #expect(throws: NativeHostError.hostDown) { _ = try await host(down).sessions() }
        await #expect(throws: NativeHostError.tokenMissing) { _ = try await host(down, token: nil).sessions() }
        let refused = Stub { _ in ok(#"{"error":"can't steer"}"#, 409) }
        await #expect(throws: NativeHostError.http(409, "can't steer")) { try await host(refused).steerQueued(id: "s", queueId: "q") }
        let denied = Stub { _ in HTTPResponse(status: 401) }
        await #expect(throws: NativeHostError.tokenRejected) { _ = try await host(denied).sessions() }
        // A send that timed out may have gone: it is uncertain, never down.
        let slow = Stub { _ in throw TransportError.timedOut }
        await #expect(throws: NativeHostError.self) { _ = try await host(slow).send(id: "s", text: "x", mode: .queue) }
        #expect(await host(Stub { _ in ok(#"{"sessions":[]}"#) }).hasToken)
    }

    @Test func idsCannotAddPathSegments() async throws {
        let stub = Stub { _ in ok(#"{"queue":[]}"#) }
        _ = try await host(stub).queue(id: "../x/y")
        #expect(stub.requests.first?.url.absoluteString == "http://127.0.0.1:8479/native/sessions/..%2Fx%2Fy/queue")
    }

    @Test func liveReadsThePortFromTheEnvironmentAndTheDaemonsTokenFile() throws {
        let dir = FileManager.default.temporaryDirectory.appending(path: "native-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appending(path: "hook-token")
        try "secret\n".write(to: file, atomically: true, encoding: .utf8)
        let h = NativeHostClient.live(environment: ["SQUEAK_HOST_PORT": "9001"], tokenFile: file)
        #expect(h.baseURL.absoluteString == "http://127.0.0.1:9001" && h.hasToken)
        #expect(NativeHostClient.live(environment: [:], tokenFile: dir.appending(path: "none")).baseURL.port == 8479)
    }
}

// MARK: SSE

struct NativeStreamTests {
    private let messageFrame = [
        "id: 3", "event: message",
        #"data: {"seq":3,"sessionId":"s","role":"agent","kind":"assistant","payload":{"type":"assistant"},"createdAt":"2026-11-08T10:00:00.000Z"}"#, "",
    ]

    @Test func parsesFramesAndSkipsComments() {
        var p = SSEParser()
        var frames: [SSEFrame] = []
        for line in [": ping", ""] + messageFrame + ["event: status", #"data: {"status":"idle"}"#, ""] {
            if let f = p.feed(line) { frames.append(f) }
        }
        #expect(frames.map(\.event) == ["message", "status"] && frames[0].id == "3")
        #expect(NativeEvent.from(frames[1]) == .status("idle"))
        guard case .message(let m)? = NativeEvent.from(frames[0]) else { Issue.record("not a message"); return }
        #expect(m.seq == 3 && m.kind == "assistant")
        #expect(NativeEvent.from(SSEFrame(event: "delta", data: #"{"type":"stream_event"}"#, id: nil)) == .delta(.object(["type": .string("stream_event")])))
        #expect(NativeEvent.from(SSEFrame(event: "request-resolved", data: #"{"requestId":"r"}"#, id: nil)) == .requestResolved("r"))
        #expect(NativeEvent.from(SSEFrame(event: "queue", data: "{}", id: nil)) == .queueChanged)
        #expect(NativeEvent.from(SSEFrame(event: "reset", data: #"{"lastSeq":9,"prunedThrough":4}"#, id: nil)) == .reset(lastSeq: 9, prunedThrough: 4))
    }

    @Test func reconnectsFromTheLastSeqAndHandlesReset() async throws {
        let opened = Box<[String]>([])
        let attempt = Box(0)
        let lines: @Sendable (HTTPRequest) -> AsyncThrowingStream<String, Error> = { req in
            opened.current.append(req.url.absoluteString)
            attempt.current += 1
            let n = attempt.current
            return AsyncThrowingStream { c in
                switch n {
                case 1:
                    for l in self.messageFrame { c.yield(l) }
                    c.finish(throwing: URLError(.networkConnectionLost))
                case 2:
                    for l in ["event: reset", #"data: {"lastSeq":1,"prunedThrough":2}"#, ""] { c.yield(l) }
                    for l in ["event: message", #"data: {"seq":1,"role":"user","kind":"user/text","payload":{"text":"hi"}}"#, ""] { c.yield(l) }
                    c.finish()
                default:
                    c.yield("event: queue"); c.yield("data: {}"); c.yield("")
                }
            }
        }
        let h = NativeHostClient(
            baseURL: URL(string: "http://127.0.0.1:8479")!, transport: Stub { _ in ok("{}") }, tokenProvider: { "tok" }, lineSource: lines)
        var seen: [NativeEvent] = []
        for await e in h.stream(id: "s", after: 2, sleep: { _ in await Task.yield() }) {
            seen.append(e)
            if e == .queueChanged { break }
        }
        // Each reconnect (not the first connection) announces itself before its first event.
        #expect(seen.count == 6)
        guard case .message(let first) = seen[0], first.seq == 3 else { Issue.record("first"); return }
        #expect(seen[1] == .connected)
        #expect(seen[2] == .reset(lastSeq: 1, prunedThrough: 2))
        #expect(seen[4] == .connected)
        #expect(opened.current.count >= 3)
        // First open asks from the caller's seq, the second from the last one seen, the third after a reset from the top.
        #expect(opened.current[0].hasSuffix("/stream?after=2"))
        #expect(opened.current[1].hasSuffix("/stream?after=3"))
        #expect(opened.current[2].hasSuffix("/stream?after=1"))
    }
}

// MARK: Adapter

private let nativeSessionsJSON = #"""
{"sessions":[
 {"id":"n1","cwd":"/Users/me/code/squeak","agent":"claude","title":"Fix build","model":"opus","permissionMode":"default","status":"needs_user_permission","updatedAt":"2026-11-08T10:00:00.000Z","lastTurnEndedAt":null,"prunedThrough":0},
 {"id":"n2","cwd":"/Users/me/code/other","agent":"codex","title":null,"model":"gpt","permissionMode":"plan","status":"idle","updatedAt":"2026-11-08T09:00:00.000Z","lastTurnEndedAt":"2026-11-08T09:00:00.000Z","prunedThrough":0}
]}
"""#

private func nativeAdapter(_ stub: Stub, daemon: DaemonClient? = nil) -> NativeAdapter {
    NativeAdapter(host: host(stub), daemon: daemon)
}

private func session(_ id: String = "n1", provider: String = "claude-squeak") -> HostSession {
    HostSession(key: SessionKey(provider: provider, hostSessionId: "squeak-native:\(id)"), replyTarget: "squeak-native:\(id)")
}

struct NativeAdapterTests {
    @Test func discoversFromTheHostAndOverlaysTheDaemonsDisplayFields() async throws {
        let t = FakeTransport()
        await t.json("GET", "/state", #"{"active":[{"key":"squeak-native:n1","agent":"claude","origin":"squeak","title":"Fix build","distinctTitle":"Fix build (2)","repoName":"squeak","branch":"fix-build","contextPercent":41}]}"#)
        let daemon = DaemonClient(baseURL: URL(string: "http://127.0.0.1:8477")!, transport: t, tokenProvider: { "tok" })
        let a = nativeAdapter(Stub { _ in ok(nativeSessionsJSON) }, daemon: daemon)
        let found = try await a.discover()
        #expect(found.count == 2)
        let n1 = try #require(found.first { $0.key.hostSessionId == "squeak-native:n1" })
        #expect(n1.key.provider == "claude-squeak" && n1.source == .squeak && n1.origin == .squeakManaged)
        #expect(n1.state == .blocked && n1.awaitingApproval == true)
        #expect(n1.distinctTitle == "Fix build (2)" && n1.branch == "fix-build" && n1.contextPercent == 41)
        #expect(n1.replyTarget == "squeak-native:n1" && n1.capabilities.approve == .supported)
        // No daemon row: the host's own facts carry it.
        let n2 = try #require(found.first { $0.key.hostSessionId == "squeak-native:n2" })
        #expect(n2.key.provider == "codex-squeak" && n2.state == .finished && n2.repoName == "other" && n2.agent == "codex")
    }

    @Test func discoversWithTheDaemonDown() async throws {
        let t = FakeTransport()
        await t.route("GET", "/state", .failure(.connectionRefused))
        let daemon = DaemonClient(baseURL: URL(string: "http://127.0.0.1:8477")!, transport: t, tokenProvider: { "tok" })
        let found = try await nativeAdapter(Stub { _ in ok(nativeSessionsJSON) }, daemon: daemon).discover()
        #expect(found.count == 2)
    }

    @Test func aHostThatIsNotRunningFindsNothingQuietly() async throws {
        let a = nativeAdapter(Stub { _ in throw TransportError.connectionRefused })
        #expect(try await a.discover().isEmpty)
        #expect(await a.health().status == .degraded("Squeak's session host isn't running"))
        let bad = nativeAdapter(Stub { _ in HTTPResponse(status: 401) })
        await #expect(throws: AdapterError.tokenRejected) { _ = try await bad.discover() }
    }

    @Test func sendsThroughTheHostAndSaysWhatBecameOfIt() async throws {
        let queued = Box(false)
        let stub = Stub { r in
            if r.url.path.hasSuffix("/messages") { return ok(queued.current ? #"{"queued":true}"# : #"{"queued":false}"#) }
            return ok(#"{"error":"no such session"}"#, 404)
        }
        let a = nativeAdapter(stub)
        #expect(await a.send("hello", to: session(), clientId: UUID()) == .accepted(via: "native", delivery: .sent))
        let body = try #require(stub.requests.last?.body)
        #expect(NativeJSON.parse(String(decoding: body, as: UTF8.self))?["mode"]?.string == "queue")
        queued.current = true
        #expect(await a.send("later", to: session(), clientId: UUID(), mode: .queue) == .accepted(via: "native", delivery: .queued))
        let steered = await a.send("now", to: session(), clientId: UUID(), mode: .steer)
        #expect(steered == .accepted(via: "native", delivery: .queued, note: "Queued: this chat can't take a message mid-turn."))
        #expect(await a.send("  ", to: session(), clientId: UUID()) == .notSent(reason: "Nothing to send"))
        #expect(await a.send("x", to: session("n1", provider: "claude-terminal").withHostId("abc"), clientId: UUID()).messageState != .confirmed)
        let gone = nativeAdapter(Stub { _ in throw TransportError.connectionRefused })
        #expect(await gone.send("x", to: session(), clientId: UUID()) == .notSent(reason: "Squeak's session host isn't running"))
        let slow = nativeAdapter(Stub { _ in throw TransportError.timedOut })
        guard case .uncertain = await slow.send("x", to: session(), clientId: UUID()) else { Issue.record("not uncertain"); return }
        let refused = nativeAdapter(Stub { _ in ok(#"{"error":"no such session"}"#, 404) })
        #expect(await refused.send("x", to: session(), clientId: UUID()) == .refused(reason: "no such session"))
    }

    @Test func controlsReportTheHostsOwnSentence() async throws {
        let stub = Stub { r in
            if r.url.path.hasSuffix("/steer") { return ok(#"{"error":"can't steer"}"#, 409) }
            return ok(#"{"ok":true}"#)
        }
        let a = nativeAdapter(stub)
        #expect(await a.steerQueued(session(), queueId: "q1") == .refused(reason: "can't steer"))
        #expect(await a.setModel(session(), model: "m", effort: nil) == .done)
        #expect(await a.interrupt(session()) == .done)
        #expect(await a.setMode(session(), to: "plan") == .done)
        #expect(await a.respond(requestId: "r1", allow: true, message: nil, answers: .object(["q": .string("A")])) == .done)
        let down = nativeAdapter(Stub { _ in throw TransportError.connectionRefused })
        #expect(await down.interrupt(session()) == .failed(reason: "Squeak's session host isn't running"))
        #expect(await a.interrupt(session("x", provider: "claude-terminal").withHostId("not-native")) == .failed(reason: "This isn't a Squeak chat"))
    }

    @Test func pagesByRowSeqNewestFirstAndStepsBack() async throws {
        // 30 exchanges, two rows each: user at odd seq, assistant at even.
        let all: [NativeMessage] = (1...60).map { seq in
            seq % 2 == 1
                ? row(seq, "user", "user/text", #"{"text":"q\#(seq)"}"#)
                : row(seq, "agent", "assistant", #"{"type":"assistant","message":{"content":[{"type":"text","text":"a\#(seq)"}]}}"#)
        }
        let stub = Stub { r in
            let q = URLComponents(url: r.url, resolvingAgainstBaseURL: false)!.queryItems ?? []
            let before = q.first { $0.name == "before" }?.value
            let limit = Int(q.first { $0.name == "limit" }?.value ?? "") ?? 500
            let upper = before.flatMap { $0 == "latest" ? nil : Int($0) } ?? Int.max
            let rows = Array(all.filter { $0.seq < upper }.suffix(limit))
            let json = rows.map { m in
                let payload = String(decoding: try! JSONEncoder().encode(m.payload), as: UTF8.self)
                return #"{"seq":\#(m.seq),"sessionId":"n1","role":"\#(m.role)","kind":"\#(m.kind)","payload":\#(payload)}"#
            }.joined(separator: ",")
            return ok(#"{"messages":[\#(json)]}"#)
        }
        let a = nativeAdapter(stub)
        let newest = try await a.transcriptPage(for: session(), limit: 10, before: nil)
        #expect(newest.messages.map(\.id) == (51...60).map { "native-\($0)" })
        #expect(newest.nextBefore == "51")
        let older = try await a.transcriptPage(for: session(), limit: 10, before: newest.nextBefore)
        #expect(older.messages.map(\.id) == (41...50).map { "native-\($0)" })
        let last = try await a.transcriptPage(for: session(), limit: 100, before: "11")
        #expect(last.messages.count == 10 && last.nextBefore == nil)
        // The current turn's steps come from the person's newest message on.
        let feed = try await a.activityFeed(for: session())
        #expect(feed.steps.map(\.text) == ["q59", "a60"])
    }

    @Test func registersInConductorSourcesAndWinsItsKeysOverTheDaemonAdapter() async throws {
        let t = FakeTransport()
        await t.json("GET", "/state", #"{"active":[{"key":"squeak-native:n1","agent":"claude","origin":"squeak","state":"working","title":"Fix build","replyTarget":"squeak-native:n1"}]}"#)
        let daemon = DaemonClient(baseURL: URL(string: "http://127.0.0.1:8477")!, transport: t, tokenProvider: { "tok" })
        let adapters = ConductorSources.adapters(
            client: daemon, database: ConductorDatabase(path: "/nonexistent/c.db"),
            native: host(Stub { _ in ok(nativeSessionsJSON) }))
        #expect(adapters.map(\.id) == ["squeak-native", "conductor-daemon"])
        let broker = Broker(adapters: adapters, clock: FakeClock())
        await broker.refresh()
        let all = await broker.sessions()
        #expect(all.filter { $0.key.hostSessionId == "squeak-native:n1" }.count == 1)
        // The host's status (a permission wait), not the daemon's "working".
        #expect(all.first { $0.key.hostSessionId == "squeak-native:n1" }?.state == .blocked)
        // Without a host client nothing changes.
        #expect(ConductorSources.adapters(client: daemon, database: ConductorDatabase(path: "/nonexistent/c.db")).map(\.id) == ["conductor-daemon"])
    }
}

private extension HostSession {
    func withHostId(_ id: String) -> HostSession {
        var s = self
        s.key = SessionKey(provider: key.provider, hostSessionId: id)
        return s
    }
}
