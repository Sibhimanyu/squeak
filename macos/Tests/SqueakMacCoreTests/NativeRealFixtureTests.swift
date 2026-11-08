import Foundation
import Testing
@testable import SqueakMacCore

// Bodies recorded from a real `squeak host` (src/native/server.ts) driving real Claude (haiku) and Codex sessions in a
// throwaway repo: Fixtures/native/. Paths under /Users/<name> were rewritten to /tmp/squeak-smoke/home; nothing else was
// touched. These pin that the Mac client decodes what the host really sends, not what a hand-written stub says it does.

private func fixture(_ name: String, _ ext: String = "json") throws -> Data {
    let url = try #require(Bundle.module.url(forResource: name, withExtension: ext, subdirectory: "native"))
    return try Data(contentsOf: url)
}

private func fixtureText(_ name: String) throws -> String { String(decoding: try fixture(name, "txt"), as: UTF8.self) }

/// Answers each path with a recorded body, remembering what was asked.
private final class Recorder: @unchecked Sendable {
    private let lock = NSLock()
    private var _asked: [String] = []
    var asked: [String] { lock.lock(); defer { lock.unlock() }; return _asked }
    func add(_ s: String) { lock.lock(); _asked.append(s); lock.unlock() }
}

private struct Recorded: HTTPTransport {
    var recorder = Recorder()
    var routes: [String: String]
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        let key = request.url.path + (request.url.query.map { "?\($0)" } ?? "")
        recorder.add(key)
        guard let name = routes[key] ?? routes[request.url.path] else { return HTTPResponse(status: 404, body: Data(#"{"error":"not found"}"#.utf8)) }
        return HTTPResponse(status: 200, body: try fixture(name))
    }
}

private func client(_ routes: [String: String], recorder: Recorder = Recorder()) -> NativeHostClient {
    NativeHostClient(
        baseURL: URL(string: "http://127.0.0.1:18479")!, transport: Recorded(recorder: recorder, routes: routes), tokenProvider: { "tok" })
}

private func events(_ name: String) throws -> (frames: Int, events: [NativeEvent]) {
    var parser = SSEParser()
    var frames = 0
    var out: [NativeEvent] = []
    // `split` would drop the blank lines a frame ends on.
    for line in try fixtureText(name).components(separatedBy: "\n") {
        guard let frame = parser.feed(line) else { continue }
        frames += 1
        if let e = NativeEvent.from(frame) { out.append(e) }
    }
    return (frames, out)
}

struct NativeRealFixtureTests {
    @Test func sessionsProjectsAndWorkspacesDecode() async throws {
        let h = client([
            "/native/sessions": "sessions-done", "/native/projects": "projects", "/native/projects/p/workspaces": "workspaces-4",
            "/native/sessions/x": "session-claude-tool-queued",
        ])
        let sessions = try await h.sessions()
        #expect(sessions.count == 4)
        #expect(Set(sessions.map(\.agent)) == ["claude", "codex"])
        #expect(sessions.allSatisfy { $0.status == "idle" && $0.createdAt != nil && $0.updatedAt != nil && $0.lastTurnEndedAt != nil })
        let codex = try #require(sessions.first { $0.agent == "codex" })
        #expect(codex.model == "gpt-6.1-terra" && codex.effort == "low" && codex.agentSessionId != nil)
        #expect(Set(sessions.map(\.permissionMode)) == ["default", "plan"])
        #expect(sessions.allSatisfy { $0.cwd.hasPrefix("/tmp/squeak-smoke/") && $0.workspaceId != nil })

        // The one-session route carries extra `requests` and `queue` keys the client ignores.
        let one = try #require(try await h.session(id: "x"))
        #expect(one.status == "needs_user_permission")

        let projects = try await h.projects()
        #expect(projects.map(\.name) == ["sandbox5"] && projects[0].defaultBranch == "main")
        let ws = try await h.workspaces(projectId: "p")
        #expect(ws.count == 4 && ws.allSatisfy { $0.state == "ready" && $0.projectId == projects[0].id && $0.branch.hasPrefix("sibhimanyu/") })
    }

    @Test func queueAndSendAnswerDecode() async throws {
        let h = client(["/native/sessions/s/queue": "queue-claude-tool-queued", "/native/sessions/s/messages": "send-queue-response"])
        let q = try await h.queue(id: "s")
        #expect(q.map(\.text) == ["then also create bye.txt"] && q[0].createdAt != nil)
        #expect(try await h.send(id: "s", text: "t", mode: .queue) == true)
        let drained = client(["/native/sessions/s/queue": "queue-claude-tool-done"])
        #expect(try await drained.queue(id: "s").isEmpty)
    }

    @Test func messagesDecodeByAfterAndByLatest() async throws {
        let rec = Recorder()
        let h = client(
            ["/native/sessions/s/messages": "messages-claude-tool-done", "/native/sessions/s/messages?before=latest&limit=20": "messages-latest20-claude-tool-done"],
            recorder: rec)
        let all = try await h.messages(id: "s")
        #expect(all.count == 17 && all.map(\.seq) == all.map(\.seq).sorted())
        #expect(all.allSatisfy { $0.createdAt != nil && !$0.kind.isEmpty })
        let tail = try await h.messages(id: "s", before: nil, limit: 20)
        #expect(rec.asked.last == "/native/sessions/s/messages?before=latest&limit=20")
        #expect(tail.count == 17 && tail.last?.seq == all.last?.seq)
        let codexTail = try await client(["/native/sessions/c/messages": "messages-latest20-codex-done"]).messages(id: "c", before: 99, limit: 20)
        #expect(codexTail.map(\.kind) == ["user/text", "item/agentMessage", "item/commandExecution", "item/agentMessage", "turn/completed"])
    }

    @Test func claudeWriteChatMapsToWordsAndADiff() async throws {
        let rows = try await client(["/native/sessions/s/messages": "messages-claude-tool-done"]).messages(id: "s")
        let m = NativeTranscript.map(rows)
        #expect(m.messages.first?.role == .user)
        #expect(m.messages.first?.text.contains("hello.txt") == true)
        #expect(m.messages.contains { $0.role == .assistant && $0.text == "done" })
        // Both turns (the queued one ran as the second) are the person's words, in order.
        #expect(m.messages.filter { $0.role == .user }.map(\.text) == ["Create a file named hello.txt containing the word hi. Then reply done.", "then also create bye.txt"])
        let writes = m.steps.filter { $0.kind == "tool" }
        #expect(writes.map(\.text) == ["Write hello.txt", "Write bye.txt"])
        guard case .diff(let path, let lines)? = m.details[try #require(writes[0].toolId)] else { Issue.record("no diff"); return }
        #expect(path.hasSuffix("/mallard/hello.txt"))
        #expect(lines.map(\.text) == ["hi"] && lines.allSatisfy { $0.kind == .added })
        // Claude's rows carry empty thinking (signature only): no empty thinking step.
        #expect(!m.steps.contains { $0.kind == "thinking" && $0.text.isEmpty })
    }

    @Test func claudePlanChatShowsCommandOutputAndEditDiff() async throws {
        let rows = try await client(["/native/sessions/s/messages": "messages-claude-plan-done"]).messages(id: "s")
        let m = NativeTranscript.map(rows)
        let tools = m.steps.filter { $0.kind == "tool" }
        #expect(tools.contains { $0.text.hasPrefix("Read ") })
        #expect(tools.contains { $0.text == "Edit README.md" })
        // ExitPlanMode is a tool_use row too: it reads as "Use ExitPlanMode", not as a lost step.
        #expect(tools.contains { $0.text == "Use ExitPlanMode" })
        let outputs = m.details.values.compactMap { d -> (String, [String], Bool?)? in if case .output(let c, let t, let ok) = d { (c, t, ok) } else { nil } }
        let first = try #require(outputs.first)
        #expect(!first.0.isEmpty && !first.1.isEmpty && first.2 == true)
        let edit = try #require(tools.first { $0.text == "Edit README.md" })
        guard case .diff(let path, let lines)? = m.details[edit.toolId!] else { Issue.record("no edit diff"); return }
        #expect(path.hasSuffix("/teal/README.md"))
        #expect(lines.contains { $0.kind == .added && $0.text.contains("second") })
        #expect(m.messages.last?.role == .assistant && m.messages.last?.text.contains("second") == true)
    }

    @Test func codexChatMapsCommandAndAnswers() async throws {
        let rows = try await client(["/native/sessions/s/messages": "messages-codex-done"]).messages(id: "s")
        let m = NativeTranscript.map(rows)
        #expect(m.messages.map(\.role) == [.user, .assistant, .assistant])
        #expect(m.messages.last?.text == "done")
        let tool = try #require(m.steps.first { $0.kind == "tool" })
        #expect(tool.text == "touch x.txt")
        // The command ran and exited 0 with no output: a row that opens to its command, no tail, succeeded.
        #expect(m.details[tool.toolId!] == .output(command: "touch x.txt", tail: [], succeeded: true))
        #expect(m.steps.map(\.kind) == ["you", "note", "tool", "note"])
    }

    @Test func requestsBecomeCards() async throws {
        let tool = try #require(try await client(["/native/sessions/s/requests": "requests-claude-tool"]).openRequests(id: "s").first)
        #expect(tool.kind == "tool" && tool.createdAt != nil)
        let toolCard = NativeCards.card(tool, agent: "Claude")
        #expect(toolCard.kind == .approval)
        #expect(toolCard.approval?.tool == "Write")
        #expect(toolCard.approval?.heading == "Claude wants to use Write")
        #expect(toolCard.approval?.target?.hasSuffix("/mallard/hello.txt") == true)
        #expect(toolCard.approval?.command == nil)

        let plan = try #require(try await client(["/native/sessions/s/requests": "requests-claude-plan"]).openRequests(id: "s").first)
        let planCard = NativeCards.card(plan, agent: "Claude")
        #expect(planCard.kind == .plan)
        #expect(planCard.plan?.markdown?.hasPrefix("# Plan: add \"second\" line to README.md") == true)
        #expect(planCard.plan?.markdown?.contains("git diff -- README.md") == true)

        let cmd = try #require(try await client(["/native/sessions/s/requests": "requests-codex"]).openRequests(id: "s").first)
        #expect(cmd.kind == "command")
        let cmdCard = NativeCards.card(cmd, agent: "Codex")
        #expect(cmdCard.kind == .approval)
        #expect(cmdCard.approval?.heading == "Run a command")
        #expect(cmdCard.approval?.command == "touch x.txt")

        let q = try #require(try await client(["/native/sessions/s/requests": "requests-claude-question"]).openRequests(id: "s").first)
        let qCard = NativeCards.card(q, agent: "Claude")
        #expect(qCard.kind == .question)
        #expect(qCard.question?.question == "Which color do you prefer: red or blue?")
        #expect(qCard.question?.options.map(\.title) == ["Red", "Blue"])
        #expect(qCard.question?.options.map(\.detail) == ["Choose red", "Choose blue"])
        #expect(qCard.questionTexts == ["Which color do you prefer: red or blue?"] && qCard.multiSelect == false)
    }

    @Test func aResolvedRequestListIsEmpty() async throws {
        let list = try await client(["/native/sessions/s/requests": "requests-claude-tool-done"]).openRequests(id: "s")
        #expect(list.isEmpty)
    }

    @Test func codexStreamReplaysResetsAndGoesLive() throws {
        let (frames, evs) = try events("stream-codex-live")
        // Every frame the host wrote is one the client understands (heartbeat comments are not frames).
        #expect(frames == evs.count && frames > 6)
        guard case .reset(let last, let pruned) = evs[0] else { Issue.record("first is not a reset"); return }
        #expect(last == 16 && pruned == 0)
        #expect(evs.contains { if case .request(let r) = $0 { r.kind == "command" } else { false } })
        #expect(evs.contains(.status("needs_user_permission")) && evs.contains(.status("working")))
        #expect(evs.contains { if case .requestResolved = $0 { true } else { false } })
        #expect(evs.contains { if case .delta(let d) = $0 { NativeLiveState.deltaText(d) == "done" } else { false } })

        var live = NativeLiveState()
        var effects: [NativeLiveState.Effect] = []
        for e in evs { effects.append(live.apply(e)) }
        #expect(effects.first == .refetch)
        #expect(live.requests.isEmpty)
        #expect(live.lastSeq == 41)
    }

    @Test func claudeStreamsCarryMessagesRequestsAndStatus() throws {
        let (frames, blocked) = try events("stream-claude-tool-blocked")
        #expect(frames == blocked.count)
        var live = NativeLiveState()
        for e in blocked { _ = live.apply(e) }
        #expect(live.status == "needs_user_permission")
        #expect(live.requests.count == 1 && live.requests[0].kind == "tool")
        #expect(NativeCards.card(for: live.requests, agent: "Claude")?.approval?.tool == "Write")
        let seqs = blocked.compactMap { e -> Int? in if case .message(let m) = e { m.seq } else { nil } }
        #expect(!seqs.isEmpty && seqs == seqs.sorted())
        #expect(live.lastSeq == seqs.last)

        let (liveFrames, liveEvents) = try events("stream-claude-tool-live")
        #expect(liveFrames == liveEvents.count)
        // Claude's streaming text arrives as stream_event deltas and is read as text, never dropped.
        let deltas = liveEvents.compactMap { e -> NativeJSON? in if case .delta(let d) = e { d } else { nil } }
        #expect(deltas.contains { NativeLiveState.deltaText($0) != nil })
        #expect(liveEvents.contains(.queueChanged))
        var state = NativeLiveState()
        for e in liveEvents { _ = state.apply(e) }
        #expect(state.requests.isEmpty)

        let (_, question) = try events("stream-claude-question-done")
        #expect(question.contains(.status("needs_user_input")) || question.contains(.status("idle")))
    }
}
