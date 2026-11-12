import Foundation
import Testing
@testable import SqueakMacCore

@Suite("Chat extras from the daemon")
struct ChatExtrasTests {
    private func session(_ json: String) throws -> DaemonSession {
        try JSONDecoder().decode(DaemonSession.self, from: Data(json.utf8))
    }

    @Test func readsWhatTheChatRunsAndWhetherItSeemsStuck() throws {
        let d = try session(#"""
        {"key":"claude-transcript:s1","agent":"claude","state":"working","conductorSessionId":"s1",
         "conductorWorkspaceId":"w1","model":"Opus 5.5 · 1M","effort":"Extra high","fast":true,
         "modelId":"opus-5-5-1m","effortId":"xhigh","stalled":{"on":"model","since":"2026-10-24T10:00:00.000Z"}}
        """#)
        let extras = ChatExtras(d)
        #expect(extras.setupLine == "Opus 5.5 · 1M · Extra high · Fast")
        #expect(extras.modelId == "opus-5-5-1m" && extras.effortId == "xhigh" && extras.workspaceId == "w1")
        let since = try #require(extras.stalled?.since)
        #expect(extras.stalled?.line(now: since.addingTimeInterval(14 * 60)) == "No response from the model for 14 min")
    }

    @Test func aRestingChatIsNeverStuckAndHasNoBackgroundWork() throws {
        let d = try session(#"{"key":"k","agent":"claude","state":"finished","stalled":{"on":"api","since":"2026-10-24T10:00:00Z"}}"#)
        let extras = ChatExtras(d, background: [DaemonBackgroundTask(id: "t", kind: "agent", label: "x", status: "running")])
        #expect(extras.stalled == nil)
        #expect(extras.background.isEmpty)
        #expect(extras.setupLine == nil)
    }

    @Test func offersOnlyTheChatsOwnProvidersModels() {
        let models = [
            DaemonChatModel(id: "opus", agent: "claude", label: "Opus", levels: ["high"]),
            DaemonChatModel(id: "gpt", agent: "codex", label: "GPT", levels: ["high"]),
        ]
        #expect(ChatExtras(agent: "claude", modelId: "opus").choices(from: models).map(\.id) == ["opus"])
        #expect(ChatExtras(agent: "claude").choices(from: models).isEmpty)
        #expect(DaemonChatModel.levelName("xhigh") == "Extra high")
    }

    @Test func readsBackgroundWorkFromTheActivityRoute() throws {
        let activity = try JSONDecoder().decode(DaemonActivity.self, from: Data(#"""
        {"steps":[],"total":0,"background":[
          {"id":"t1","kind":"agent","label":"Audit","status":"running","startedAt":"2026-10-24T10:00:00.000Z"},
          {"id":"t2","kind":"shell","label":"Run tests","status":"done","startedAt":"2026-10-24T10:00:00.000Z","endedAt":"2026-10-24T10:04:30.000Z"},
          {"kind":7}
        ]}
        """#.utf8))
        #expect(activity.background.map(\.id).prefix(2) == ["t1", "t2"])
        #expect(activity.background[1].duration() == "4 min")
        let extras = ChatExtras(agent: "claude", background: Array(activity.background.prefix(2)))
        #expect(extras.backgroundSummary == "1 duckling, 1 shell · 1 running")
    }

    @Test func oneLineSummaryAndChipRule() {
        let task = { (kind: String, status: String) in
            DaemonBackgroundTask(id: UUID().uuidString, kind: kind, label: "x", status: status)
        }
        #expect(ChatExtras(agent: "claude", background: [task("agent", "done")]).backgroundLine == "1 duckling · ended")
        #expect(ChatExtras(agent: "claude", background: [task("agent", "running"), task("shell", "done")]).backgroundLine == "1 duckling, 1 shell · 1 running")
        #expect(ChatExtras(agent: "claude", background: []).backgroundLine == nil)
        #expect(BackgroundSummary.showsChips(count: 2) && !BackgroundSummary.showsChips(count: 3) && !BackgroundSummary.showsChips(count: 0))
    }
}

@Suite struct LoopingDecodeTests {
    @Test func decodesTheDaemonsLoopingStep() throws {
        let json = #"{"key":"claude-transcript:a","state":"working","looping":{"label":"Run npm test","count":4,"since":"2026-11-12T10:00:00Z"}}"#
        let s = try JSONDecoder().decode(DaemonSession.self, from: Data(json.utf8))
        #expect(s.looping == DaemonLoop(label: "Run npm test", count: 4))
        #expect(s.looping?.line == "Run npm test failed 4 times in a row")
        #expect(ChatExtras(s).looping?.count == 4)
    }

    @Test func absentFromAnOlderDaemonAndOnlyWhileWorking() throws {
        let old = try JSONDecoder().decode(DaemonSession.self, from: Data(#"{"key":"k","state":"working"}"#.utf8))
        #expect(old.looping == nil)
        let done = try JSONDecoder().decode(DaemonSession.self, from: Data(#"{"key":"k","state":"finished","looping":{"label":"x","count":3}}"#.utf8))
        #expect(ChatExtras(done).looping == nil)
    }
}
