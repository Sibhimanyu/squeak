import Foundation
import Testing
@testable import SqueakMacCore

private let levels = ["low", "medium", "high", "xhigh", "max"]
private let models: [DaemonChatModel] = [
    DaemonChatModel(id: "opus-5-5-1m", agent: "claude", label: "Opus 5.5 · 1M", levels: levels, defaultLevel: "medium"),
    DaemonChatModel(id: "sonnet-5-5-1m", agent: "claude", label: "Sonnet 5.5 · 1M", levels: levels, defaultLevel: "medium"),
    DaemonChatModel(id: "haiku-5-5", agent: "claude", label: "Haiku 5.5", levels: []),
    DaemonChatModel(id: "gpt-5.5", agent: "codex", label: "GPT 5.5", levels: ["low", "high"], defaultLevel: "high"),
]
private func client(_ t: FakeTransport) -> DaemonClient {
    DaemonClient(baseURL: URL(string: "http://127.0.0.1:8477")!, transport: t, tokenProvider: { "tok" })
}
private func freshStore() -> ChatChoiceStore { ChatChoiceStore(defaults: UserDefaults(suiteName: "squeak.test.\(UUID().uuidString)")!) }

@Suite("Chat presets")
struct ChatPresetsTests {
    @Test func presetsFromModels() {
        let best = ChatPresets.setup(for: .best, agent: .claude, models: models)
        #expect(best == ChatSetup(modelId: "opus-5-5-1m", level: "high"))
        #expect(ChatPresets.setup(for: .balanced, agent: .claude, models: models)?.code == "sonnet")
        let save = ChatPresets.setup(for: .save, agent: .claude, models: models)
        #expect(save == ChatSetup(modelId: "sonnet-5-5-1m", level: "medium", code: "sonnet", run: "haiku", planFirst: true))
        #expect(ChatPresets.available(agent: .claude, models: models) == [.best, .balanced, .save])
        #expect(ChatPresets.available(agent: .codex, models: models).isEmpty) // one offer is no choice
        #expect(ChatPresets.available(agent: .claude, models: []).isEmpty)
    }

    @Test func customWhenEditedAway() {
        var s = ChatPresets.setup(for: .save, agent: .claude, models: models)!
        #expect(ChatPresets.preset(of: s, agent: .claude, models: models) == .save)
        s.run = nil
        #expect(ChatPresets.preset(of: s, agent: .claude, models: models) == .custom)
    }

    @Test func summaryInWords() {
        let s = ChatPresets.setup(for: .save, agent: .claude, models: models)!
        #expect(ChatPresets.summary(of: s, agent: .claude, models: models) == "Sonnet 5.5 plans · Sonnet codes · Haiku runs tests · asks before changes")
        let b = ChatPresets.setup(for: .best, agent: .claude, models: models)!
        #expect(ChatPresets.summary(of: b, agent: .claude, models: models) == "Opus 5.5 · high thinking")
    }

    @Test func formSendsOnlyWhatIsSet() {
        var f = NewChatForm(workspaces: [NewChatWorkspace(id: "a", repoName: "r", branch: "b")], store: freshStore())
        #expect(f.request.model == nil && f.request.split == nil) // no models loaded: nothing extra
        f.setModels(models)
        #expect(f.request.model == "opus-5-5-1m" && f.request.thinking == "high" && f.request.split == nil)
        f.apply(preset: .save)
        #expect(f.request.split == WorkSplit(code: "sonnet", run: "haiku", planFirst: true) && f.preset == .save)
        f.choose(agent: .codex)
        #expect(f.request.split == nil && f.request.model == "gpt-5.5")
        f.set(planFirst: true)
        #expect(!f.setup.planFirst) // plan first needs a split
    }

    @Test func choicesAreRemembered() {
        let store = freshStore()
        var f = NewChatForm(workspaces: [NewChatWorkspace(id: "a", repoName: "r", branch: "b")], store: store)
        f.setModels(models)
        f.apply(preset: .balanced)
        f.pick(run: "haiku")
        var g = NewChatForm(workspaces: [NewChatWorkspace(id: "a", repoName: "r", branch: "b")], store: store)
        g.setModels(models)
        #expect(g.setup.code == "sonnet" && g.setup.run == "haiku" && g.preset == .custom)
    }

    @Test func startChatSendsModelThinkingSplit() async throws {
        let t = FakeTransport()
        await t.json("POST", "/control/chats", #"{"ok":true,"sessionId":"s"}"#)
        _ = await client(t).startChat(workspaceId: "w", agent: .claude, text: "x", model: "opus-5-5-1m", thinking: "high",
                                      split: WorkSplit(code: "sonnet", planFirst: true))
        let req = try #require(await t.requests.first)
        let obj = try #require(try JSONSerialization.jsonObject(with: req.body ?? Data()) as? [String: Any])
        #expect(obj["model"] as? String == "opus-5-5-1m" && obj["thinking"] as? String == "high")
        #expect((obj["split"] as? [String: Any])?["code"] as? String == "sonnet")
        #expect((obj["split"] as? [String: Any])?["run"] == nil && (obj["split"] as? [String: Any])?["planFirst"] as? Bool == true)
    }

    @Test func codexNeverGetsASplit() async throws {
        let t = FakeTransport()
        await t.json("POST", "/control/chats", #"{"ok":true,"sessionId":"s"}"#)
        _ = await client(t).startChat(workspaceId: "w", agent: .codex, text: "x", split: WorkSplit(code: "sonnet"))
        let obj = try #require(try JSONSerialization.jsonObject(with: await t.requests.first?.body ?? Data()) as? [String: Any])
        #expect(obj["split"] == nil)
    }

    @Test func olderDaemonSaysUpdateAndNeverRetries() async {
        let t = FakeTransport()
        await t.json("POST", "/control/chats", status: 400, "")
        let r = await client(t).startChat(workspaceId: "w", agent: .claude, text: "x", model: "m")
        if case .failed(let why) = r { #expect(why.contains("Update the service")) } else { Issue.record("expected failed") }
        #expect(await t.requests.count == 1)
    }
}
