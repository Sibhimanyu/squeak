import Foundation
import Testing
@testable import SqueakMacCore

@Suite("Subagent feed")
struct SubagentFeedTests {
    private func feed(_ json: String) throws -> DaemonSubagentFeed {
        try JSONDecoder().decode(DaemonSubagentFeed.self, from: Data(json.utf8))
    }

    @Test func decodesTheRouteAndToleratesMissingFields() throws {
        let f = try feed(#"""
        {"taskId":"toolu_01abcdef","agentId":"a1b2c3d4e5","label":"Survey","status":"running","available":true,
         "steps":[{"kind":"tool","text":"Read a.ts","at":"2026-10-25T10:00:00.000Z"},{"kind":7},{"text":"note"}],
         "total":9,"startedAt":"2026-10-25T09:59:00Z","endedAt":null}
        """#)
        #expect(f.steps.count == 3 && f.steps[0].text == "Read a.ts" && f.steps[2].kind == "note")
        #expect(f.total == 9 && f.endedAt == nil && f.startedAt != nil)
        let empty = try feed("{}")
        #expect(empty.steps.isEmpty && empty.status == nil && empty.available == nil)
    }

    @Test func backgroundItemsCarryAgentIdAndHasSteps() throws {
        let d = try JSONDecoder().decode(DaemonActivity.self, from: Data(#"""
        {"steps":[],"background":[
          {"id":"toolu_01abcdef","kind":"agent","label":"A","status":"running","agentId":"abc123456","hasSteps":true},
          {"id":"toolu_02abcdef","kind":"agent","label":"B","status":"running"},
          {"id":"toolu_03abcdef","kind":"shell","label":"C","status":"running","hasSteps":true},
          {"id":"bad id!","kind":"agent","label":"D","status":"done","hasSteps":true}]}
        """#.utf8))
        #expect(d.background.map(\.canShowSteps) == [true, false, false, false])
        #expect(d.background[0].agentId == "abc123456" && d.background[1].hasSteps == nil)
    }

    @Test func taskIdsFollowTheDaemonsRule() {
        #expect(SubagentFeedPresentation.isValidTaskId("toolu_01AbC-9"))
        #expect(!SubagentFeedPresentation.isValidTaskId("short"))
        #expect(!SubagentFeedPresentation.isValidTaskId("../../etc/passwd"))
        #expect(!SubagentFeedPresentation.isValidTaskId(String(repeating: "a", count: 81)))
    }

    @Test func presentsEveryState() throws {
        typealias P = SubagentFeedPresentation
        #expect(P.make(result: nil, fallbackStatus: "running").body == .loading)
        let old = P.make(result: .success(nil), fallbackStatus: "running")
        #expect(old.body == .olderDaemon && old.message == "Update Squeak's background service to see subagent steps." && old.chip == "Running")
        #expect(P.make(result: .success(try feed(#"{"status":"running","available":false}"#))).body == .notReadable)
        #expect(P.make(result: .success(try feed(#"{"status":"done","available":true,"steps":[]}"#))).body == .noSteps)
        let some = P.make(result: .success(try feed(#"{"status":"failed","available":true,"total":120,"steps":[{"kind":"tool","text":"Run npm test"}]}"#)))
        #expect(some.body == .steps([ActivityStep(kind: "tool", text: "Run npm test")]))
        #expect(some.chip == "Failed" && some.clippedNote == "Showing the newest 1 of 120 steps")
    }

    @Test func aFailedReadKeepsTheStepsAlreadyShown() throws {
        struct Boom: Error {}
        let shown = SubagentFeedPresentation.make(result: .success(try feed(#"{"status":"running","available":true,"steps":[{"kind":"note","text":"hi"}]}"#)))
        let after = SubagentFeedPresentation.make(result: .failure(Boom()), previous: shown)
        #expect(after.body == shown.body)
        #expect(SubagentFeedPresentation.make(result: .failure(Boom()), previous: nil, fallbackStatus: "done").body == .unreachable)
    }

    @Test func clientAsks404AsOlderDaemonAndNeverSendsABadId() async throws {
        let t = StubTransport(status: 404, body: "")
        let client = DaemonClient(baseURL: URL(string: "http://127.0.0.1:1")!, transport: t, tokenProvider: { "tok" })
        #expect(try await client.subagentActivity(sessionKey: "claude-transcript:s1", taskId: "toolu_01abcdef") == nil)
        #expect(t.paths.last?.contains("/control/session/claude-transcript:s1/subagent/toolu_01abcdef/activity") == true
                || t.paths.last?.contains("claude-transcript%3As1/subagent/toolu_01abcdef/activity") == true)
        let before = t.paths.count
        #expect(try await client.subagentActivity(sessionKey: "k", taskId: "../x") == nil)
        #expect(t.paths.count == before)
    }
}

private final class StubTransport: HTTPTransport, @unchecked Sendable {
    let status: Int, body: String
    private(set) var paths: [String] = []
    init(status: Int, body: String) { self.status = status; self.body = body }
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        paths.append(request.url.absoluteString)
        return HTTPResponse(status: status, body: Data(body.utf8))
    }
}
