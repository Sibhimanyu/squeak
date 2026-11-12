import Foundation
import Testing
@testable import Conductor
@testable import SqueakMacCore

@MainActor
private func sourceAdapters(
    client: DaemonClient, database: ConductorDatabase = ConductorDatabase(),
    activityReader: ClaudeActivityReader = ClaudeActivityReader(), picks: ConductorPicksCache = ConductorPicksCache()
) -> [any HostAdapter] {
    let s = ConductorAddon.sources(client: client, database: database, activityReader: activityReader, picks: picks)
    return s.adapters + [DaemonAdapter(client: client, excluding: s.takesOver, opener: s.opener)]
}

@Suite("Daemon sender and composite")
@MainActor
struct DaemonSenderTests {
    private func client(_ t: FakeTransport, token: String? = "tok") -> DaemonClient {
        DaemonClient(baseURL: URL(string: "http://127.0.0.1:9")!, transport: t, tokenProvider: { token })
    }

    @Test func readinessTracksDaemonAndToken() async {
        let t = FakeTransport()
        let sender = DaemonSender(client: client(t), minRecheck: 0)
        #expect(!sender.isReady) // unknown until the first poll
        await t.json("GET", "/state", syntheticState)
        await sender.refresh()
        #expect(sender.isReady)
        await t.route("GET", "/state", .failure(.connectionRefused))
        await sender.refresh()
        #expect(!sender.isReady && sender.unavailableReason.contains("isn't running"))
        let noToken = DaemonSender(client: client(t, token: nil), minRecheck: 0)
        await t.json("GET", "/state", syntheticState)
        await noToken.refresh()
        #expect(!noToken.isReady && noToken.unavailableReason.contains("token"))
    }

    @Test func sendUsesTheReplyRouteAndItsOutcomeMapping() async {
        let t = FakeTransport()
        let sender = DaemonSender(client: client(t))
        await t.json("POST", "/control/session/chat-1/reply", #"{"status":"started","via":"conductor"}"#)
        #expect(await sender.send(workspaceId: "w", sessionId: "chat-1", text: "hi") == .accepted(via: "conductor"))
        await t.json("POST", "/control/session/chat-1/reply", #"{"status":"refused","reason":"busy"}"#)
        #expect(await sender.send(workspaceId: "w", sessionId: "chat-1", text: "hi") == .refused(reason: "busy"))
        await t.route("POST", "/control/session/chat-1/reply", .failure(.timedOut))
        if case .uncertain = await sender.send(workspaceId: "w", sessionId: "chat-1", text: "hi") {} else { Issue.record("timeout must be uncertain") }
        await t.route("POST", "/control/session/chat-1/reply", .failure(.connectionRefused))
        if case .notSent = await sender.send(workspaceId: "w", sessionId: "chat-1", text: "hi") {} else { Issue.record("refused connection must be notSent") }
    }

    private func picked(_ ids: [String]) -> ConductorPicksCache {
        let d = UserDefaults(suiteName: "support-picks-\(UUID().uuidString)")!
        let c = ConductorPicksCache(defaults: d)
        c.value = Set(ids)
        return c
    }

    @Test func aChatNeverAppearsTwiceAndSendsGoThroughTheDaemon() async throws {
        let f = try ConductorFixture()
        // Same chat the daemon lists as a Conductor row ("aaaa-1111"), plus an unrelated one.
        try f.addSession("aaaa-1111", title: "Paint the bikeshed")
        try f.addSession("other", title: "Other")
        let t = FakeTransport()
        await t.json("GET", "/state", syntheticState.replacingOccurrences(of: "{", with: #"{"conductorWorkspaces":["w1"],"#, options: [], range: syntheticState.range(of: "{")))
        await t.json("POST", "/control/session/aaaa-1111/reply", #"{"status":"started","via":"conductor"}"#)
        let c = client(t)
        let adapters = sourceAdapters(
            client: c, database: f.database, activityReader: ClaudeActivityReader(projectsDir: f.dir.path, codexSessionsDir: f.dir.path),
            picks: picked(["w1"]))
        #expect(adapters.map(\.id) == ["conductor-local", "daemon"])
        let broker = Broker(adapters: adapters, clock: FakeClock())
        await broker.refresh()
        let all = await broker.sessions()

        let conductor = all.filter { $0.key.provider == "conductor" }
        #expect(conductor.map(\.key.hostSessionId).sorted() == ["aaaa-1111", "other"])
        #expect(Set(all.map(\.key)).count == all.count)
        // Non-Conductor sessions still come from the daemon.
        #expect(Set(all.map(\.key.provider)).isSuperset(of: ["codex-terminal", "claude-desktop", "claude-sdk"]))
        // The Conductor chat has the local key (database workspace), and can send.
        let chat = try #require(conductor.first { $0.key.hostSessionId == "aaaa-1111" })
        #expect(chat.key.workspaceId == "w1" && chat.capabilities.send == .supported)

        let result = await broker.send("hello", to: chat.key)
        #expect(result == .accepted(via: "conductor"))
        let posts = await t.requests.filter { $0.method == "POST" }
        #expect(posts.count == 1 && posts[0].url.path == "/control/session/aaaa-1111/reply")
        #expect(String(data: posts[0].body ?? Data(), encoding: .utf8)?.contains("hello") == true)
    }

    @Test func daemonDownLeavesChatsReadableButNotSendable() async throws {
        let f = try ConductorFixture()
        try f.addSession("c1")
        let t = FakeTransport()
        await t.route("GET", "/state", .failure(.connectionRefused))
        let broker = Broker(adapters: sourceAdapters(
            client: client(t), database: f.database,
            activityReader: ClaudeActivityReader(projectsDir: f.dir.path, codexSessionsDir: f.dir.path), picks: picked(["w1"])), clock: FakeClock())
        await broker.refresh()
        let chat = try #require(await broker.sessions().first)
        // Not "this chat can't be answered": the service is down, which is app-wide and may pass.
        #expect(chat.capabilities.send.isServiceUnavailable && chat.capabilities.send.reason?.contains("isn't running") == true)
    }

    @Test func serviceDownIsNotAChatThatCannotBeAnswered() async throws {
        let f = try ConductorFixture()
        try f.addSession("c1")
        let t = FakeTransport()
        await t.route("GET", "/state", .failure(.connectionRefused))
        let adapter = sourceAdapters(
            client: client(t), database: f.database,
            activityReader: ClaudeActivityReader(projectsDir: f.dir.path, codexSessionsDir: f.dir.path), picks: picked(["w1"]))
        let broker = Broker(adapters: adapter, clock: FakeClock())
        await broker.refresh()
        let chat = try #require(await broker.sessions().first)
        // Offered (so Send stays on) but with the real reason; a retired chat is the other kind.
        #expect(chat.capabilities.send.isOffered && chat.capabilities.send.isServiceUnavailable)
        #expect(Capability.unsupported("closed").isOffered == false && !Capability.unsupported("closed").isServiceUnavailable)
        #expect(Capability.supported.isOffered && !Capability.supported.isServiceUnavailable)
    }

    @Test func sendRechecksTheServiceAtOnceAndGoesThroughWhenItIsBack() async throws {
        let f = try ConductorFixture()
        try f.addSession("c1")
        let t = FakeTransport()
        await t.route("GET", "/state", .failure(.connectionRefused))
        // A long minRecheck: only a forced recheck can see the daemon come back.
        let sender = DaemonSender(client: client(t), minRecheck: 3600)
        let adapter = ConductorLocalAdapter(
            database: f.database, activityReader: ClaudeActivityReader(projectsDir: f.dir.path, codexSessionsDir: f.dir.path),
            sender: sender, now: { Date() })
        let broker = Broker(adapters: [adapter], clock: FakeClock())
        await broker.refresh()
        let chat = try #require(await broker.sessions().first)
        #expect(chat.capabilities.send.isServiceUnavailable)

        await t.json("GET", "/state", syntheticState)
        await t.json("POST", "/control/session/c1/reply", #"{"status":"started","via":"conductor"}"#)
        let r = await broker.send("C", to: chat.key)
        #expect(r == .accepted(via: "conductor"))
        let posts = await t.requests.filter { $0.method == "POST" }
        #expect(posts.count == 1)
        // The broker learned it too: the chat reads as sendable again.
        let after = try #require(await broker.sessions().first)
        #expect(after.capabilities.send == .supported)
    }

    @Test func stillDownAfterTheRecheckSaysSoAndKeepsTheDraft() async throws {
        let f = try ConductorFixture()
        try f.addSession("c1")
        let t = FakeTransport()
        await t.route("GET", "/state", .failure(.connectionRefused))
        let sender = DaemonSender(client: client(t), minRecheck: 3600)
        let adapter = ConductorLocalAdapter(
            database: f.database, activityReader: ClaudeActivityReader(projectsDir: f.dir.path, codexSessionsDir: f.dir.path),
            sender: sender, now: { Date() })
        let broker = Broker(adapters: [adapter], clock: FakeClock())
        await broker.refresh()
        let chat = try #require(await broker.sessions().first)
        await broker.setDraft("C", for: chat.key)
        let r = await broker.send("C", to: chat.key)
        #expect(r == .notSent(reason: serviceNotAnsweringReason))
        #expect(await t.requests.filter { $0.method == "POST" }.isEmpty)  // nothing left the Mac
        #expect(await broker.draft(for: chat.key) == "C")
    }

    @Test func missingDatabaseFallsBackToTheDaemonForConductorToo() async throws {
        let t = FakeTransport()
        await t.json("GET", "/state", syntheticState)
        let adapters = sourceAdapters(client: client(t), database: ConductorDatabase(path: "/nonexistent/c.db"))
        #expect(adapters.map(\.id) == ["daemon"])
        let broker = Broker(adapters: adapters, clock: FakeClock())
        await broker.refresh()
        #expect(await broker.sessions().contains { $0.key.provider == "conductor" })
    }

    @Test func conductorOpenURLComesFromTheAddonsOpener() async throws {
        let transport = FakeTransport()
        let client = DaemonClient(baseURL: URL(string: "http://127.0.0.1:1")!, transport: transport, tokenProvider: { "t" })
        let adapter = DaemonAdapter(client: client, opener: ConductorAddon.opener)
        let state = try JSONDecoder().decode(DaemonState.self, from: Data(syntheticState.utf8))
        let s = DaemonAdapter.map(state.sessions[0], opensInHost: true)
        #expect(adapter.openInHostURL(for: s)?.absoluteString == "conductor://workspace?id=ws-orchard&session=aaaa-1111")
        #expect(adapter.openInHostURL(for: DaemonAdapter.map(state.sessions[1], opensInHost: true)) == nil)
        // Without the add-on there is no host to open a chat in.
        #expect(DaemonAdapter(client: client).openInHostURL(for: s) == nil)
    }
}
