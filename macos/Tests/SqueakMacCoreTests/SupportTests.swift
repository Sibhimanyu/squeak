import Foundation
import Testing
@testable import SqueakMacCore

@Suite("Diagnostics redaction")
struct DiagnosticsTests {
    @Test func redactsPathsIdsTokensUrlsAndEmails() {
        let line = "opened /Users/jane/work/secret-project/file.ts for 3f2a9c1e-1111-4222-8333-444455556666 via https://x.example/a?b=1 jane@example.com tok=abcdefghijklmnopqrstuvwxyz0123456789"
        let out = DiagnosticsRedactor.redact(line)
        for leak in ["jane", "secret-project", "3f2a9c1e", "x.example", "abcdefghijkl"] { #expect(!out.contains(leak), "\(leak) leaked: \(out)") }
        #expect(out.contains("<path>") && out.contains("<id>") && out.contains("<url>") && out.contains("<email>"))
    }

    @Test func keepsPlainWording() {
        #expect(DiagnosticsRedactor.redact("poll ok: 12 sessions") == "poll ok: 12 sessions")
    }

    @Test func hashIsEightHexAndStable() {
        let h = DiagnosticsRedactor.hash("session-1")
        #expect(h.count == 8 && h.allSatisfy(\.isHexDigit))
        #expect(h == DiagnosticsRedactor.hash("session-1") && h != DiagnosticsRedactor.hash("session-2"))
    }

    @Test func ringBufferKeepsTheNewest() {
        let b = LogBuffer(capacity: 3)
        for i in 1...5 { b.append("line \(i)") }
        let last = b.last(10)
        #expect(last.count == 3 && last[0].hasSuffix("line 3") && last[2].hasSuffix("line 5"))
    }

    @Test func reportHasCountsAndVersionsButNeverContent() {
        let s = makeSession("secret-id", title: "My Private Title", state: .working)
        let input = DiagnosticsInput(
            appVersion: "2.0.0", osVersion: "macOS 15.0",
            adapters: [.init(name: "Conductor database", status: "connected", lastSyncedAt: Date(timeIntervalSince1970: 1_800_000_000))],
            stateCounts: DiagnosticsInput.counts(of: [s, makeSession("b", state: .blocked)]),
            lastUpdateCheck: nil,
            logLines: (1...80).map { "line \($0) /Users/jane/x/y" },
            now: Date(timeIntervalSince1970: 1_800_000_100))
        let r = DiagnosticsReport.render(input)
        #expect(r.contains("App version: 2.0.0") && r.contains("working: 1") && r.contains("blocked: 1") && r.contains("Last update check: never"))
        #expect(!r.contains("My Private Title") && !r.contains("secret-id") && !r.contains("jane"))
        #expect(r.contains("line 80") && !r.contains("line 30 ") && r.contains("line 31 "))
        #expect(DiagnosticsInput.describe(.degraded("/Users/jane/db")) == "degraded")
    }
}

@Suite("Connections report")
struct ConnectionsReportTests {
    let ok = AdapterHealth(adapterId: "x", status: .connected)

    @Test func allGood() {
        let r = ConnectionsReport.make(databaseExists: true, localHealth: ok, daemonHealth: ok, tokenPresent: true)
        #expect(r.database.value == "Readable" && r.daemon.value == "Connected" && r.sending.value == "Available via Squeak service")
    }

    @Test func missingDatabaseDaemonDownTokenMissing() {
        let down = AdapterHealth(adapterId: "d", status: .daemonDown)
        let a = ConnectionsReport.make(databaseExists: false, localHealth: nil, daemonHealth: down, tokenPresent: true)
        #expect(a.database.value == "Missing" && a.daemon.value == "Down" && a.sending.value == "Unavailable")
        let b = ConnectionsReport.make(databaseExists: true, localHealth: ok, daemonHealth: ok, tokenPresent: false)
        #expect(b.daemon.value == "Token missing" && b.sending.value == "Unavailable" && b.sending.detail?.contains("token") == true)
    }
}

@Suite("Daemon sender and composite")
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

    @Test func aChatNeverAppearsTwiceAndSendsGoThroughTheDaemon() async throws {
        let f = try ConductorFixture()
        // Same chat the daemon lists as a Conductor row ("aaaa-1111"), plus an unrelated one.
        try f.addSession("aaaa-1111", title: "Paint the bikeshed")
        try f.addSession("other", title: "Other")
        let t = FakeTransport()
        await t.json("GET", "/state", syntheticState)
        await t.json("POST", "/control/session/aaaa-1111/reply", #"{"status":"started","via":"conductor"}"#)
        let c = client(t)
        let adapters = ConductorSources.adapters(
            client: c, database: f.database, activityReader: ClaudeActivityReader(projectsDir: f.dir.path, codexSessionsDir: f.dir.path))
        #expect(adapters.map(\.id) == ["conductor-local", "conductor-daemon"])
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
        let broker = Broker(adapters: ConductorSources.adapters(
            client: client(t), database: f.database,
            activityReader: ClaudeActivityReader(projectsDir: f.dir.path, codexSessionsDir: f.dir.path)), clock: FakeClock())
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
        let adapter = ConductorSources.adapters(
            client: client(t), database: f.database,
            activityReader: ClaudeActivityReader(projectsDir: f.dir.path, codexSessionsDir: f.dir.path))
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
        let adapters = ConductorSources.adapters(client: client(t), database: ConductorDatabase(path: "/nonexistent/c.db"))
        #expect(adapters.map(\.id) == ["conductor-daemon"])
        let broker = Broker(adapters: adapters, clock: FakeClock())
        await broker.refresh()
        #expect(await broker.sessions().contains { $0.key.provider == "conductor" })
    }
}
