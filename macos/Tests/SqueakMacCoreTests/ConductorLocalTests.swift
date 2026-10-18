import Foundation
import SQLite3
import Testing
@testable import SqueakMacCore

private let NOW = ConductorTime.date("2026-10-18T10:00:00.000Z")!

private func iso(minutesAgo: Double) -> String {
    ISO8601DateFormatter().string(from: NOW.addingTimeInterval(-minutesAgo * 60))
}

private let resultRow = #"{"type":"result","subtype":"success","is_error":false}"#

struct ConductorTimeTests {
    @Test func naiveTimestampsAreUtc() {
        #expect(ConductorTime.toIso("2026-09-22 04:11:37") == "2026-09-22T04:11:37Z")
        #expect(ConductorTime.toIso("2026-09-22T03:01:12.257Z") == "2026-09-22T03:01:12.257Z")
        #expect(ConductorTime.toIso(nil) == nil)
        #expect(ConductorTime.date("2026-09-22 04:11:37") == ConductorTime.date("2026-09-22T04:11:37Z"))
        #expect(ConductorTime.date("2026-09-22T03:01:12.257Z") != nil)
        #expect(ConductorTime.date("2026-09-22T09:00:00+05:30") == ConductorTime.date("2026-09-22T03:30:00Z"))
    }
}

struct ConductorDatabaseTests {
    @Test func readOnlyHandleRefusesWrites() throws {
        let f = try ConductorFixture()
        try f.addSession("s1")
        #expect(throws: ConductorDatabaseError.self) {
            try f.database.query("INSERT INTO sessions (id, workspace_id) VALUES ('x', 'w1')")
        }
        #expect(throws: ConductorDatabaseError.self) { try f.database.query("DELETE FROM sessions") }
        #expect(throws: ConductorDatabaseError.self) { try f.database.query("DROP TABLE sessions") }
        #expect(try f.database.query("SELECT id FROM sessions").count == 1)
    }

    @Test func missingDatabaseThrowsMissing() {
        let db = ConductorDatabase(path: "/nonexistent/conductor.db")
        #expect(throws: ConductorDatabaseError.missing("/nonexistent/conductor.db")) { try db.query("SELECT 1") }
    }

    @Test func notADatabaseIsUnreadable() throws {
        let path = FileManager.default.temporaryDirectory.appendingPathComponent("junk-\(UUID().uuidString).db").path
        try Data("not sqlite at all, just text padding padding padding".utf8).write(to: URL(fileURLWithPath: path))
        defer { try? FileManager.default.removeItem(atPath: path) }
        #expect(throws: ConductorDatabaseError.self) { try ConductorDatabase(path: path).query("SELECT * FROM sessions") }
    }

    @Test func pathWithSpacesOpens() throws {
        let f = try ConductorFixture()
        let spaced = f.dir.appendingPathComponent("Application Support")
        try FileManager.default.createDirectory(at: spaced, withIntermediateDirectories: true)
        let copy = spaced.appendingPathComponent("conductor.db")
        try FileManager.default.copyItem(at: URL(fileURLWithPath: f.dbPath), to: copy)
        #expect(try ConductorDatabase(path: copy.path).query("SELECT count(*) as n FROM repos").first?["n"]?.int == 1)
    }
}

struct ConductorRegistryTests {
    @Test func ordersByRealRecencyAcrossBothSpellings() throws {
        let f = try ConductorFixture()
        // Naive 04:11:37 UTC is newer than ISO 03:01:12 even though ' ' sorts before 'T' as a string.
        try f.addSession("iso", updatedAt: "2026-09-22T03:01:12.257Z")
        try f.addSession("naive", updatedAt: "2026-09-22 04:11:37")
        try f.addSession("oldest", updatedAt: "2026-09-21T23:00:00.000Z")
        let rows = try ConductorRegistry(database: f.database).listFleetSessions(limit: 10)
        #expect(rows.map(\.id) == ["naive", "iso", "oldest"])
        #expect(rows[0].updatedAt == "2026-09-22T04:11:37Z")
    }

    @Test func carriesRepoWorkspaceAndHiddenFlags() throws {
        let f = try ConductorFixture()
        try f.exec("INSERT INTO repos (id, name, default_branch, hidden) VALUES ('r2', 'secret', 'main', 1)")
        try f.exec("INSERT INTO workspaces (id, repository_id, directory_name, branch, state) VALUES ('w2', 'r2', 'd', 'b', 'archived')")
        try f.addSession("open")
        try f.addSession("closed", hidden: true)
        try f.addSession("hiddenRepo", workspace: "w2")
        let rows = Dictionary(uniqueKeysWithValues: try ConductorRegistry(database: f.database).listFleetSessions(limit: 10).map { ($0.id, $0) })
        #expect(rows["open"]?.isHidden == false)
        #expect(rows["open"]?.repositoryName == "squeak")
        #expect(rows["open"]?.branch == "feature")
        #expect(rows["open"]?.defaultBranch == "main")
        #expect(rows["open"]?.workspacePath == "/w/ushuaia")
        #expect(rows["closed"]?.isHidden == true)
        #expect(rows["hiddenRepo"]?.isHidden == true)
        #expect(rows["hiddenRepo"]?.workspaceState == "archived")
    }

    @Test func turnEndRowsOutcomeAndTime() throws {
        let f = try ConductorFixture()
        try f.addSession("ok", lastUser: "2026-10-18T09:00:00.000Z")
        try f.addMessage("ok", role: "assistant", content: resultRow, sentAt: "2026-10-18 09:01:00")
        try f.addMessage("ok", role: "assistant", content: ConductorFixture.envelope([ConductorFixture.text("later prose")]), sentAt: "2026-10-18T09:02:00.000Z")
        try f.addSession("abort", lastUser: "2026-10-18T09:00:00.000Z")
        try f.addMessage("abort", role: "assistant", content: #"{"type":"error","content":"aborted by user"}"#, sentAt: "2026-10-18T09:01:00.000Z")
        try f.addSession("fail", lastUser: "2026-10-18T09:00:00.000Z")
        try f.addMessage("fail", role: "assistant", content: #"{"type":"error","content":"OpenCode 2 required"}"#, sentAt: "2026-10-18T09:01:00.000Z")
        try f.addSession("iserr", lastUser: "2026-10-18T09:00:00.000Z")
        try f.addMessage("iserr", role: "assistant", content: #"{"type":"result","is_error":1}"#, sentAt: "2026-10-18T09:01:00.000Z")
        try f.addSession("none", lastUser: "2026-10-18T09:00:00.000Z")
        let rows = Dictionary(uniqueKeysWithValues: try ConductorRegistry(database: f.database).listFleetSessions(limit: 10).map { ($0.id, $0) })
        #expect(rows["ok"]?.lastTurnOutcome == .success)
        #expect(rows["ok"]?.lastTurnEndedAt == "2026-10-18T09:01:00Z")
        #expect(rows["abort"]?.lastTurnOutcome == .aborted)
        #expect(rows["fail"]?.lastTurnOutcome == .failed)
        #expect(rows["iserr"]?.lastTurnOutcome == .failed)
        #expect(rows["none"]?.lastTurnEndedAt == nil)
        #expect(rows["none"]?.lastTurnOutcome == nil)
    }

    @Test func messagesOrderedNewestFirstAcrossSpellingsAndSkipCancelled() throws {
        let f = try ConductorFixture()
        try f.addSession("s")
        try f.addMessage("s", role: "user", content: "first", sentAt: "2026-10-18T09:00:00.000Z", id: "m1")
        try f.addMessage("s", role: "user", content: "third", sentAt: "2026-10-18 09:30:00", id: "m3")
        try f.addMessage("s", role: "user", content: "second", sentAt: "2026-10-18T09:10:00.000Z", id: "m2")
        try f.addMessage("s", role: "user", content: "cancelled", sentAt: "2026-10-18T09:40:00.000Z", id: "m4")
        try f.exec("UPDATE session_messages SET cancelled_at = '2026-10-18T09:41:00Z' WHERE id = 'm4'")
        let rows = try ConductorRegistry(database: f.database).listSessionMessages(sessionId: "s", limit: 10)
        #expect(rows.map(\.id) == ["m3", "m2", "m1"])
    }
}

struct ConductorStatusTests {
    private func row(
        status: String = "idle", lastUser: String? = iso(minutesAgo: 5), ended: String? = iso(minutesAgo: 4),
        outcome: ConductorSessionRow.TurnOutcome? = .success, hidden: Bool = false
    ) -> ConductorSessionRow {
        ConductorSessionRow(
            id: "s", workspaceId: "w", status: status, updatedAt: iso(minutesAgo: 1), lastUserMessageAt: lastUser,
            lastTurnEndedAt: ended, lastTurnOutcome: outcome, isHidden: hidden)
    }
    private func state(_ r: ConductorSessionRow) -> SessionState { ConductorStatus.state(of: r, now: NOW) }

    @Test func finishedOnlyWithTurnEndRow() {
        #expect(state(row()) == .finished)
        #expect(state(row(ended: nil, outcome: nil)) == .idle)
    }

    @Test func neverSpokenChatIsIdle() { #expect(state(row(lastUser: nil)) == .idle) }

    @Test func workingAndBlockedStatuses() {
        #expect(state(row(status: "working")) == .working)
        #expect(state(row(status: "cancelling")) == .working)
        #expect(state(row(status: "waiting")) == .working)
        #expect(state(row(status: "needs_user_input")) == .blocked)
        #expect(state(row(status: "needs_plan_response")) == .blocked)
        #expect(state(row(status: "error")) == .error)
    }

    @Test func abortedIsIdleAndFailedIsError() {
        #expect(state(row(outcome: .aborted)) == .idle)
        #expect(state(row(lastUser: iso(minutesAgo: 0.1), ended: iso(minutesAgo: 0.08), outcome: .failed)) == .error)
    }

    @Test func messageAfterLastTurnEndIsIdle() {
        #expect(state(row(lastUser: iso(minutesAgo: 1), ended: iso(minutesAgo: 30))) == .idle)
    }

    @Test func oldFinishBecomesIdleAndActivityIsContentTimed() {
        let r = ConductorSessionRow(
            id: "s", workspaceId: "w", status: "idle", updatedAt: iso(minutesAgo: 0.1),
            lastUserMessageAt: "2026-09-17T06:16:00.000Z", lastTurnEndedAt: "2026-09-17T06:16:32.494Z", lastTurnOutcome: .success)
        let s = state(r)
        #expect(s == .idle)
        #expect(ConductorStatus.activityTime(of: r, state: s) == ConductorTime.date("2026-09-17T06:16:32.494Z"))
    }

    @Test func retiredWhenHiddenArchivedOrDone() {
        #expect(ConductorStatus.isRetired(row(hidden: true)))
        var r = row(); r.workspaceState = "Archived"
        #expect(ConductorStatus.isRetired(r))
        r = row(); r.manualStatus = "done"
        #expect(ConductorStatus.isRetired(r))
        r = row(); r.derivedStatus = "done"
        #expect(ConductorStatus.isRetired(r))
        #expect(!ConductorStatus.isRetired(row()))
    }

    @Test func activeRule() {
        let recent = NOW.addingTimeInterval(-60), stale = NOW.addingTimeInterval(-3600)
        #expect(ConductorStatus.isActive(state: .working, retired: false, lastActivityAt: stale, now: NOW))
        #expect(ConductorStatus.isActive(state: .blocked, retired: false, lastActivityAt: stale, now: NOW))
        #expect(!ConductorStatus.isActive(state: .working, retired: true, lastActivityAt: recent, now: NOW))
        #expect(ConductorStatus.isActive(state: .finished, retired: false, lastActivityAt: recent, now: NOW))
        #expect(!ConductorStatus.isActive(state: .finished, retired: false, lastActivityAt: stale, now: NOW))
        #expect(ConductorStatus.isActive(state: .error, retired: false, lastActivityAt: recent, now: NOW))
        #expect(!ConductorStatus.isActive(state: .idle, retired: false, lastActivityAt: recent, now: NOW))
    }
}

struct ConductorTextTests {
    @Test func transcriptKeepsUserTextAndProseOnly() throws {
        let f = try ConductorFixture()
        try f.addSession("s")
        let env = ConductorFixture.envelope
        let t = ConductorFixture.text
        try f.addMessage("s", role: "user", content: "fix the bug", sentAt: "2026-10-18T09:00:00.000Z", turn: "t1", id: "u1")
        try f.addMessage("s", role: "assistant", content: env([["type": "thinking", "thinking": "secret thoughts"], t("Looking.")]), sentAt: "2026-10-18T09:00:01.000Z", turn: "t1", id: "a1")
        try f.addMessage("s", role: "assistant", content: env([["type": "tool_use", "id": "x", "name": "Bash", "input": ["command": "rm -rf"]]]), sentAt: "2026-10-18T09:00:02.000Z", turn: "t1", id: "tool")
        try f.addMessage("s", role: "user", content: #"{"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"x","content":"SECRET OUTPUT"}]}}"#, sentAt: "2026-10-18T09:00:03.000Z", turn: "t1", id: "res")
        try f.addMessage("s", role: "assistant", content: resultRow, sentAt: "2026-10-18T09:00:04.000Z", turn: "t1", id: "result")
        try f.addMessage("s", role: "assistant", content: env([t("Fixed it.")]), sentAt: "2026-10-18T09:00:05.000Z", turn: "t1", id: "a2")
        let (messages, complete) = try ConductorRegistry(database: f.database).transcript(sessionId: "s", limit: 50)
        #expect(messages.map(\.id) == ["u1", "a1", "a2"])
        #expect(messages.map(\.text) == ["fix the bug", "Looking.", "Fixed it."])
        #expect(messages.map(\.role) == [.user, .assistant, .assistant])
        #expect(messages[0].turnId == "t1")
        #expect(messages[0].at == ConductorTime.date("2026-10-18T09:00:00.000Z"))
        #expect(complete)
        let all = messages.map(\.text).joined()
        #expect(!all.contains("secret thoughts") && !all.contains("SECRET OUTPUT") && !all.contains("rm -rf"))
    }

    @Test func limitKeepsNewestAndMarksIncomplete() {
        let rows = (0..<5).reversed().map { SessionMessageRecord(id: "m\($0)", role: "user", content: "text \($0)") }
        let r = ConductorText.buildTranscript(rows: rows, limit: 2)
        #expect(r.messages.map(\.id) == ["m3", "m4"])
        #expect(!r.complete)
    }

    @Test func userTextVariants() {
        #expect(ConductorText.userText("  plain words  ") == "plain words")
        #expect(ConductorText.userText("42") == "42")
        #expect(ConductorText.userText(#"{"not":"envelope"}"#) == nil)
        #expect(ConductorText.userText(#"{"message":{"content":"typed"}}"#) == "typed")
        #expect(ConductorText.userText(#"{"message":{"content":[{"type":"text","text":"a"},{"type":"text","text":"b"}]}}"#) == "a\n\nb")
    }

    @Test func lastTurnTextTakesNewestTextOfNewestTurn() {
        let env = ConductorFixture.envelope, t = ConductorFixture.text
        let rows = [
            SessionMessageRecord(role: "assistant", content: resultRow, turnId: "t2"),
            SessionMessageRecord(role: "assistant", content: env([t("Pick one:\nA) x\nB) y")]), turnId: "t2"),
            SessionMessageRecord(role: "assistant", content: env([["type": "tool_use", "name": "Bash"]]), turnId: "t2"),
            SessionMessageRecord(role: "assistant", content: env([t("Looking...")]), turnId: "t2"),
            SessionMessageRecord(role: "user", content: "go", turnId: "t2"),
            SessionMessageRecord(role: "assistant", content: env([t("Older turn")]), turnId: "t1"),
        ]
        #expect(ConductorText.lastTurnText(rows: rows) == "Pick one:\nA) x\nB) y")
    }

    @Test func lastTurnTextDoesNotResurfaceOlderTurn() {
        let env = ConductorFixture.envelope, t = ConductorFixture.text
        let toolOnly = [
            SessionMessageRecord(role: "assistant", content: env([["type": "tool_use", "name": "Bash"]]), turnId: "t2"),
            SessionMessageRecord(role: "user", content: "A", turnId: "t2"),
            SessionMessageRecord(role: "assistant", content: env([t("A) x\nB) y")]), turnId: "t1"),
        ]
        #expect(ConductorText.lastTurnText(rows: toolOnly) == nil)
        let userNewest = [SessionMessageRecord(role: "user", content: "hi", turnId: "t3")] + toolOnly
        #expect(ConductorText.lastTurnText(rows: userNewest) == nil)
    }
}

struct ClaudeActivityTests {
    private func transcript(_ entries: [[String: Any]]) throws -> (URL, ClaudeActivityReader) {
        let dir = FileManager.default.temporaryDirectory.appendingPathComponent("activity-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: dir.appendingPathComponent("-w-proj"), withIntermediateDirectories: true)
        let file = dir.appendingPathComponent("-w-proj/sess-1.jsonl")
        let body = try entries.map { String(data: try JSONSerialization.data(withJSONObject: $0), encoding: .utf8)! }.joined(separator: "\n") + "\n"
        try body.write(to: file, atomically: true, encoding: .utf8)
        return (file, ClaudeActivityReader(projectsDir: dir.path, codexSessionsDir: dir.appendingPathComponent("codex").path))
    }

    private static let at = "2026-09-26T03:00:00.000Z"
    private func block(_ id: String, _ content: [String: Any], sidechain: Bool = false) -> [String: Any] {
        var e: [String: Any] = ["type": "assistant", "timestamp": Self.at, "message": ["id": id, "role": "assistant", "content": [content]]]
        if sidechain { e["isSidechain"] = true }
        return e
    }
    private func user(_ content: Any) -> [String: Any] {
        ["type": "user", "timestamp": "2026-09-26T02:59:00.000Z", "message": ["content": content]]
    }

    @Test func listsCurrentTurnEachBlockOnce() throws {
        let edit: [String: Any] = ["type": "tool_use", "id": "t1", "name": "Edit", "input": ["file_path": "/w/src/timer.ts", "old_string": "SECRET RAW"]]
        let (file, reader) = try transcript([
            user("an earlier question"),
            block("m0", ["type": "text", "text": "An earlier answer."]),
            user("fix the flaky test"),
            block("m1", ["type": "thinking", "thinking": "The retry loop races the timer."]),
            block("m1", ["type": "text", "text": "Found it; patching the timer."]),
            block("m1", edit),
            block("m1", edit),  // re-written while streaming
            user([["type": "tool_result", "tool_use_id": "t1", "content": "ok"]]),
            block("m2", ["type": "tool_use", "id": "t2", "name": "Bash", "input": ["command": "npm test", "description": "Run tests"]]),
        ])
        let feed = reader.activity(agent: .claude, transcriptPath: file.path)
        #expect(feed.total == 4)
        #expect(feed.steps.map(\.kind) == ["thinking", "note", "tool", "tool"])
        #expect(feed.steps.map(\.text) == ["The retry loop races the timer.", "Found it; patching the timer.", "Edit timer.ts", "Run tests"])
        #expect(feed.steps[0].at == ConductorTime.date(Self.at))
        #expect(!feed.steps.map(\.text).joined().contains("SECRET RAW"))
    }

    @Test func workerReportingInDoesNotStartNewTurn() throws {
        let (file, reader) = try transcript([
            user("render all nine scenes"),
            block("m1", ["type": "tool_use", "id": "a1", "name": "Agent", "input": ["description": "scene 1", "run_in_background": true]]),
            user("<task-notification>\n<task-id>x</task-id>\n<status>completed</status>\n<summary>Agent \"scene 1\" finished</summary>"),
            block("m2", ["type": "text", "text": "Scene 1 is in."]),
        ])
        let steps = reader.activity(agent: .claude, transcriptPath: file.path).steps
        #expect(steps.map { "\($0.kind): \($0.text)" } == [
            "tool: Start scene 1 in the background", "background: Agent \"scene 1\" finished", "note: Scene 1 is in.",
        ])
    }

    @Test func skipsSidechainAndKeepsNewestWhenLong() throws {
        var entries: [[String: Any]] = [user("go")]
        for i in 0..<20 {
            entries.append(block("m\(i)", ["type": "tool_use", "id": "t\(i)", "name": "Read", "input": ["file_path": "/w/f\(i).ts"]]))
        }
        entries.append(block("side", ["type": "text", "text": "a subagent's note"], sidechain: true))
        let (file, reader) = try transcript(entries)
        let feed = reader.activity(agent: .claude, transcriptPath: file.path, limit: 5)
        #expect(feed.total == 20)
        #expect(feed.steps.map(\.text) == (15..<20).map { "Read f\($0).ts" })
    }

    @Test func readsOnlyTheTail() throws {
        // A multi-megabyte head with a user turn, then a short tail: the old turn must not matter
        // and a cut first line must not break parsing.
        let (file, reader) = try transcript([user("go")])
        var data = try Data(contentsOf: file)
        let filler = Data(("{\"type\":\"user\",\"message\":{\"content\":\"" + String(repeating: "x", count: 1000) + "\"}}\n").utf8)
        for _ in 0..<600 { data.append(filler) }  // ~600 KB
        let tail = try JSONSerialization.data(withJSONObject: block("m9", ["type": "tool_use", "id": "z", "name": "Read", "input": ["file_path": "/w/last.ts"]]))
        data.append(tail); data.append(Data("\n".utf8))
        try data.write(to: file)
        let feed = reader.activity(agent: .claude, transcriptPath: file.path)
        #expect(feed.steps.map(\.text) == ["Read last.ts"])
    }

    @Test func missingTranscriptIsEmpty() {
        let feed = ClaudeActivityReader().activity(agent: .claude, transcriptPath: "/nonexistent/t.jsonl")
        #expect(feed.total == 0 && feed.steps.isEmpty)
    }

    @Test func findsTranscriptBySessionId() throws {
        let (file, reader) = try transcript([user("hi")])
        #expect(reader.claudeTranscriptPath(sessionId: "sess-1") == file.path)
        #expect(reader.claudeTranscriptPath(sessionId: "nope") == nil)
        #expect(reader.claudeTranscriptPath(sessionId: "../x") == nil)
    }

    @Test func codexNotesReasoningAndCommands() throws {
        func item(_ p: [String: Any]) -> [String: Any] { ["timestamp": Self.at, "type": "response_item", "payload": p] }
        let cmd = String(data: try JSONSerialization.data(withJSONObject: ["cmd": ["bash", "-lc", "ls v3"]]), encoding: .utf8)!
        let (file, reader) = try transcript([
            item(["type": "message", "role": "user", "content": [["type": "input_text", "text": "<environment_context>"]]]),
            item(["type": "message", "role": "user", "content": [["type": "input_text", "text": "check the speaker images"]]]),
            item(["type": "reasoning", "summary": [], "encrypted_content": "gAAA"]),
            item(["type": "reasoning", "summary": [["type": "summary_text", "text": "Looking for the v3 folder."]]]),
            item(["type": "function_call", "name": "shell", "arguments": cmd]),
            item(["type": "message", "role": "assistant", "content": [["type": "output_text", "text": "All three are there."]]]),
        ])
        let steps = reader.activity(agent: .codex, transcriptPath: file.path).steps
        #expect(steps.map { "\($0.kind): \($0.text)" } == ["thinking: Looking for the v3 folder.", "tool: Run ls v3", "note: All three are there."])
    }

    @Test func describesToolsWithoutRawInput() {
        let d = ClaudeActivityReader.describeClaudeTool
        #expect(d("Bash", ["command": "npm run ci\necho done"]) == "Run npm run ci")
        #expect(d("Grep", ["pattern": "TODO"]) == "Search for “TODO”")
        #expect(d("WebFetch", ["url": "https://example.com/a/b"]) == "Fetch example.com")
        #expect(d("mcp__figma__get_screenshot", [:]) == "Use figma get_screenshot")
        #expect(d("Write", [:]) == "Write a file")
        let x = ClaudeActivityReader.describeCodexTool
        #expect(x(["name": "exec", "input": "const r = await tools.exec_command({\"cmd\":\"sed -n 1,40p README.md\"})"]) == "Run sed -n 1,40p README.md")
        #expect(x(["name": "apply_patch", "input": "*** Begin Patch\n*** Update File: src/app.ts\n@@"]) == "Edit app.ts")
    }
}

struct RecordingSender: ConductorSender {
    let isReady: Bool
    let result: SendResult
    let calls = CallLog()
    final class CallLog: @unchecked Sendable {
        private let lock = NSLock()
        private var items: [String] = []
        func add(_ s: String) { lock.withLock { items.append(s) } }
        var all: [String] { lock.withLock { items } }
    }
    func send(workspaceId: String, sessionId: String, text: String) async -> SendResult {
        calls.add("\(workspaceId)/\(sessionId)/\(text)")
        return result
    }
}

struct ConductorLocalAdapterTests {
    private func fixture() throws -> ConductorFixture {
        let f = try ConductorFixture()
        try f.exec("INSERT INTO workspaces (id, repository_id, directory_name, branch, state) VALUES ('w2', 'r1', 'old', 'old-branch', 'archived')")
        try f.addSession("run", status: "waiting", title: "Running", updatedAt: "2026-10-18T09:59:00.000Z")
        try f.addSession("blocked", status: "needs_user_input", title: "Blocked", updatedAt: "2026-10-18 09:58:00")
        try f.addSession("done", title: "Done", lastUser: iso(minutesAgo: 6), updatedAt: iso(minutesAgo: 3))
        try f.addMessage("done", role: "assistant", content: resultRow, sentAt: iso(minutesAgo: 5))
        try f.addSession("old", title: "Old", lastUser: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-18 08:00:00")
        try f.addMessage("old", role: "assistant", content: resultRow, sentAt: "2026-10-01T00:01:00.000Z")
        try f.addSession("closed", status: "working", title: "Closed", updatedAt: "2026-10-18T09:59:30.000Z", hidden: true)
        try f.addSession("archived", workspace: "w2", status: "working", title: "Archived ws", updatedAt: "2026-10-18T09:57:00.000Z")
        return f
    }

    private func adapter(_ f: ConductorFixture, sender: any ConductorSender = NullSender(), activeOnly: Bool = false) -> ConductorLocalAdapter {
        ConductorLocalAdapter(
            database: f.database, activityReader: ClaudeActivityReader(projectsDir: f.dir.path, codexSessionsDir: f.dir.path),
            sender: sender, activeOnly: activeOnly, now: { NOW })
    }

    @Test func discoverMapsStatesAndOmitsClosedChats() async throws {
        let f = try fixture()
        let sessions = try await adapter(f).discover()
        let byId = Dictionary(uniqueKeysWithValues: sessions.map { ($0.key.hostSessionId, $0) })
        #expect(byId["closed"] == nil)
        #expect(byId["run"]?.state == .working)
        #expect(byId["blocked"]?.state == .blocked)
        #expect(byId["done"]?.state == .finished)
        #expect(byId["old"]?.state == .idle)
        #expect(byId["run"]?.key.provider == "conductor")
        #expect(byId["run"]?.key.workspaceId == "w1")
        #expect(byId["run"]?.repoName == "squeak")
        #expect(byId["run"]?.branch == "feature")
        #expect(byId["run"]?.replyTarget == "run")
        #expect(byId["archived"]?.capabilities.send.isSupported == false)
        #expect(sessions.first?.key.hostSessionId == "run")  // newest by real recency
    }

    @Test func activeOnlyAppliesTheActiveRule() async throws {
        let f = try fixture()
        let ids = try await adapter(f, activeOnly: true).discover().map(\.key.hostSessionId)
        // archived workspace is retired; old is idle; closed is hidden.
        #expect(Set(ids) == ["run", "blocked", "done"])
    }

    @Test func collidingLabelsGetDistinctTitles() async throws {
        let f = try fixture()  // run, blocked, done, old all share "squeak · feature"
        let sessions = try await adapter(f).discover()
        let byId = Dictionary(uniqueKeysWithValues: sessions.map { ($0.key.hostSessionId, $0) })
        #expect(byId["run"]?.distinctTitle == "Running")
        #expect(byId["archived"]?.distinctTitle == nil)  // its label (squeak · old-branch) is unique
    }

    @Test func sendCapabilityFollowsSender() async throws {
        let f = try fixture()
        let off = try await adapter(f).discover().first { $0.key.hostSessionId == "run" }!
        #expect(off.capabilities.send.isSupported == false)
        let on = try await adapter(f, sender: RecordingSender(isReady: true, result: .accepted(via: "relay"))).discover()
            .first { $0.key.hostSessionId == "run" }!
        #expect(on.capabilities.send.isSupported)
    }

    @Test func nullSenderNeverSends() async throws {
        let f = try fixture()
        let s = try await adapter(f).discover().first!
        #expect(await adapter(f).send("hi", to: s, clientId: UUID()) == .notSent(reason: "Squeak's relay is not set up yet"))
        #expect(await NullSender().send(workspaceId: "w", sessionId: "s", text: "t") == .notSent(reason: "relay not set up"))
    }

    @Test func sendDelegatesToSender() async throws {
        let f = try fixture()
        let sender = RecordingSender(isReady: true, result: .accepted(via: "relay"))
        let a = adapter(f, sender: sender)
        let s = try await a.discover().first { $0.key.hostSessionId == "run" }!
        #expect(await a.send("hello", to: s, clientId: UUID()) == .accepted(via: "relay"))
        #expect(sender.calls.all == ["w1/run/hello"])
        #expect(await a.send("   ", to: s, clientId: UUID()) == .notSent(reason: "Nothing to send"))
        #expect(sender.calls.all.count == 1)
    }

    @Test func transcriptAndOpenURL() async throws {
        let f = try fixture()
        try f.addMessage("run", role: "user", content: "hello", sentAt: "2026-10-18T09:00:00.000Z", id: "u")
        try f.addMessage("run", role: "assistant", content: ConductorFixture.envelope([ConductorFixture.text("hi there")]), sentAt: "2026-10-18T09:00:01.000Z", id: "a")
        let a = adapter(f)
        let s = try await a.discover().first { $0.key.hostSessionId == "run" }!
        #expect(try await a.transcript(for: s, limit: 10).map(\.text) == ["hello", "hi there"])
        #expect(a.openInHostURL(for: s)?.absoluteString == "conductor://workspace?id=w1&session=run")
    }

    @Test func activityComesFromTheChatsTranscript() async throws {
        let f = try fixture()
        try f.exec("UPDATE sessions SET claude_session_id = 'agent-1' WHERE id = 'run'")
        let projects = f.dir.appendingPathComponent("proj")
        try FileManager.default.createDirectory(at: projects, withIntermediateDirectories: true)
        let line = #"{"type":"assistant","timestamp":"2026-10-18T09:59:00.000Z","message":{"id":"m","content":[{"type":"tool_use","id":"t","name":"Read","input":{"file_path":"/w/a.ts"}}]}}"#
        try (line + "\n").write(to: projects.appendingPathComponent("agent-1.jsonl"), atomically: true, encoding: .utf8)
        let a = ConductorLocalAdapter(
            database: f.database, activityReader: ClaudeActivityReader(projectsDir: f.dir.path, codexSessionsDir: f.dir.path), now: { NOW })
        let s = try await a.discover().first { $0.key.hostSessionId == "run" }!
        #expect(try await a.activity(for: s).map(\.text) == ["Read a.ts"])
        let other = try await a.discover().first { $0.key.hostSessionId == "done" }!
        #expect(try await a.activity(for: other).isEmpty)
    }

    @Test func healthReportsMissingUnreadableAndOk() async throws {
        let f = try fixture()
        #expect(await adapter(f).health().status == .connected)
        let missing = ConductorLocalAdapter(database: ConductorDatabase(path: "/nonexistent/c.db"))
        #expect(await missing.health().status == .degraded("Conductor's database was not found"))
        let bare = try ConductorFixture()
        try bare.exec("DROP TABLE sessions")
        #expect(await adapter(bare).health().status == .degraded("Conductor's database could not be read"))
    }
}
