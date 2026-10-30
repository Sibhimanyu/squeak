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

    @Test func presetPreferencesPersistNamesAndAgentSpecificSetupsSafely() {
        let defaults = UserDefaults(suiteName: "squeak.presets.\(UUID().uuidString)")!
        let prefs = ChatPresetPreferences(defaults: defaults)
        prefs.setTitle("Budget", for: .save)
        var setup = ChatPresets.setup(for: .save, agent: .claude, models: models)!
        setup.run = "opus"
        prefs.setSetup(setup, for: .save, agent: .claude, models: models)
        let restored = ChatPresetPreferences(defaults: defaults)
        #expect(restored.title(for: .save) == "Budget")
        #expect(restored.setup(for: .save, agent: .claude, models: models)?.run == "opus")
        #expect(restored.setup(for: .save, agent: .codex, models: models) == nil)
        #expect(restored.setup(for: .save, agent: .claude, models: [models[0]]) == ChatPresets.setup(for: .save, agent: .claude, models: [models[0]]))
        let codexCustom = ChatSetup(modelId: "gpt-5.5", level: "low")
        restored.setSetup(codexCustom, for: .balanced, agent: .codex, models: models)
        #expect(restored.setup(for: .balanced, agent: .codex, models: models) == codexCustom)
        restored.restoreDefaults(for: .balanced, agent: .codex)
        #expect(restored.title(for: .balanced) == ChatPreset.balanced.title)
        #expect(restored.setup(for: .balanced, agent: .codex, models: models) == nil)
    }

    @Test func savedPresetNamesAreVisibleToNewFormsAfterRecreation() {
        let defaults = UserDefaults(suiteName: "squeak.preset-titles.\(UUID().uuidString)")!
        let store = ChatChoiceStore(defaults: defaults)
        store.preferences.setTitle("Budget", for: .save)
        var windowForm = NewChatForm(store: store)
        windowForm.setModels(models)
        #expect(windowForm.presetTitle(.save) == "Budget")
        let popupForm = NewChatForm(store: ChatChoiceStore(defaults: defaults))
        #expect(popupForm.presetTitle(.save) == "Budget")
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

private final class PresetsStub: HTTPTransport, @unchecked Sendable {
    var requests: [HTTPRequest] = []
    var doc: String
    var refuse = false
    var down = false
    init(_ doc: String = #"{"names":{},"setups":{}}"#) { self.doc = doc }
    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        requests.append(request)
        if down { throw TransportError.connectionRefused }
        if request.method == "POST", refuse { return HTTPResponse(status: 400, body: Data(#"{"error":"no"}"#.utf8)) }
        return HTTPResponse(status: 200, body: Data(doc.utf8))
    }
}

@Suite struct ChatPresetSyncTests {
    private func client(_ t: PresetsStub) -> DaemonClient {
        DaemonClient(baseURL: URL(string: "http://127.0.0.1:1")!, transport: t, tokenProvider: { "tok" })
    }
    private func defaults() -> UserDefaults { UserDefaults(suiteName: "squeak.presets.sync.\(UUID().uuidString)")! }

    private func bodies(_ t: PresetsStub) -> [[String: Any]] {
        t.requests.filter { $0.method == "POST" }.compactMap { try? JSONSerialization.jsonObject(with: $0.body ?? Data()) as? [String: Any] }
    }

    @Test func requestBodiesHaveExactlyTheDaemonsKeys() throws {
        let setup = ChatSetup(modelId: "opus-5-5-1m", level: "high", code: "sonnet", run: nil, planFirst: true)
        let raw = try #require(ChatPresetRequest.setup(.save, .claude, setup))
        let body = try #require(try JSONSerialization.jsonObject(with: raw) as? [String: Any])
        #expect(Set(body.keys) == ["agent", "preset", "change"])
        let change = try #require(body["change"] as? [String: Any])
        #expect(Set(change.keys) == ["setup"])
        let wire = try #require(change["setup"] as? [String: Any])
        #expect(Set(wire.keys) == ["modelId", "level", "code", "run", "planFirst"])
        #expect(wire["run"] is NSNull)
        #expect(ChatPresetRequest.setup(.save, .claude, ChatSetup()) == nil)
        let rawName = try #require(ChatPresetRequest.name(.best, nil))
        let name = try #require(try JSONSerialization.jsonObject(with: rawName) as? [String: Any])
        #expect(Set(name.keys) == ["preset", "change"])
    }

    @Test func daemonDocumentReplacesTheLocalCopy() async {
        let d = defaults()
        let stub = PresetsStub(#"{"names":{"save":"Cheap"},"setups":{"claude":{"save":{"modelId":"opus-5-5-1m","level":"low","code":"sonnet","run":null,"planFirst":false}}}}"#)
        #expect(await ChatPresetSync.sync(client: client(stub), defaults: d) == .synced)
        let prefs = ChatPresetPreferences(defaults: d)
        #expect(prefs.title(for: .save) == "Cheap")
        #expect(prefs.setup(for: .save, agent: .claude, models: models)?.level == "low")
    }

    @Test func localCustomPresetsMigrateOnceAndNeverOverwriteTheDaemons() async {
        let d = defaults()
        // Edited on this Mac before the daemon held presets (no hook set, so nothing is queued then).
        var saved = ChatPresetPreferences.Saved()
        saved.names = ["save": "Budget", "best": "Top"]
        saved.setups["claude.save"] = ChatSetup(modelId: "opus-5-5-1m", level: "low", code: "sonnet", run: "haiku", planFirst: true)
        saved.setups["claude.best"] = ChatSetup(modelId: "opus-5-5-1m", level: "high")
        ChatPresetPreferences(defaults: d).store(saved)
        // The daemon already has a name for "best" (a phone set it): that one wins.
        let stub = PresetsStub(#"{"names":{"best":"Phone"},"setups":{}}"#)
        _ = await ChatPresetSync.sync(client: client(stub), defaults: d)
        let sent = bodies(stub)
        #expect(sent.count == 3) // save's name, claude.best, claude.save
        #expect(!sent.contains { ($0["preset"] as? String) == "best" && ($0["change"] as? [String: Any])?["name"] != nil })
        #expect(d.bool(forKey: ChatPresetPreferences.migratedKey))
        // Marked migrated: a second sync sends nothing.
        stub.requests.removeAll()
        _ = await ChatPresetSync.sync(client: client(stub), defaults: d)
        #expect(bodies(stub).isEmpty)
    }

    @Test func daemonDownKeepsTheCopyAndTheQueueAndDoesNotMarkMigrated() async {
        let d = defaults()
        let prefs = ChatPresetPreferences(defaults: d)
        prefs.setTitle("Mine", for: .balanced)
        let stub = PresetsStub()
        stub.down = true
        #expect(await ChatPresetSync.sync(client: client(stub), defaults: d) == .unavailable)
        #expect(prefs.title(for: .balanced) == "Mine")
        #expect(prefs.pending().count == 1)
        #expect(!d.bool(forKey: ChatPresetPreferences.migratedKey))
        // Back up: the queued edit goes out, and the daemon's answer is the copy.
        stub.down = false
        stub.doc = #"{"names":{"balanced":"Mine"},"setups":{}}"#
        #expect(await ChatPresetSync.sync(client: client(stub), defaults: d) == .synced)
        #expect(prefs.pending().isEmpty)
        #expect(bodies(stub).contains { ($0["change"] as? [String: Any])?["name"] as? String == "Mine" })
    }

    @Test func aRefusedChangeIsDroppedAndTheDaemonsDocumentWins() async {
        let d = defaults()
        let prefs = ChatPresetPreferences(defaults: d)
        prefs.setTitle("Mine", for: .best)
        let stub = PresetsStub()
        stub.refuse = true
        #expect(await ChatPresetSync.sync(client: client(stub), defaults: d) == .synced)
        #expect(prefs.pending().isEmpty)
        #expect(prefs.title(for: .best) == ChatPreset.best.title)
    }

    @Test func anOlderDaemonLeavesEverythingAlone() async {
        let d = defaults()
        let prefs = ChatPresetPreferences(defaults: d)
        prefs.setTitle("Mine", for: .best)
        final class Old: HTTPTransport, @unchecked Sendable {
            func send(_ request: HTTPRequest) async throws -> HTTPResponse { HTTPResponse(status: 404, body: Data()) }
        }
        let old = DaemonClient(baseURL: URL(string: "http://127.0.0.1:1")!, transport: Old(), tokenProvider: { "tok" })
        #expect(await ChatPresetSync.sync(client: old, defaults: d) == .unavailable)
        #expect(prefs.title(for: .best) == "Mine")
        #expect(prefs.pending().count == 1)
    }
}
