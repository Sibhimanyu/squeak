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
        #expect(extras.backgroundSummary == "1 subagent, 1 shell · 1 running")
    }
}
