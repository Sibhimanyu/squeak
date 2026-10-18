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

@Suite("Update check")
struct UpdateCheckTests {
    @Test func parsesAndComparesSemver() {
        #expect(SemanticVersion("v2.0.0") == SemanticVersion("2.0.0"))
        #expect(SemanticVersion("2.0.1")! > SemanticVersion("2.0.0")!)
        #expect(SemanticVersion("2.10.0")! > SemanticVersion("2.9.9")!)
        #expect(SemanticVersion("3.0.0")! > SemanticVersion("2.99.99")!)
        #expect(SemanticVersion("2.1.0-beta.1")! < SemanticVersion("2.1.0")!)
        #expect(SemanticVersion("2.1.0-beta.2")! > SemanticVersion("2.1.0-beta.1")!)
        #expect(SemanticVersion("2.1.0-beta.10")! > SemanticVersion("2.1.0-beta.2")!)
        #expect(SemanticVersion("2.1")! == SemanticVersion("2.1.0")!)
        #expect(SemanticVersion("banana") == nil && SemanticVersion("") == nil && SemanticVersion("1.x.0") == nil)
        #expect(SemanticVersion("1.2.3.4") == nil)
    }

    private func checker(_ status: Int, _ body: String) async -> UpdateChecker {
        let t = FakeTransport()
        await t.json("GET", "/repos/Sibhimanyu/squeak/releases/latest", status: status, body)
        return UpdateChecker(transport: t)
    }

    @Test func newerReleaseIsOffered() async {
        let c = await checker(200, #"{"tag_name":"v2.1.0","html_url":"https://github.com/Sibhimanyu/squeak/releases/tag/v2.1.0"}"#)
        let r = await c.check(currentVersion: "2.0.0")
        guard case .available(let u) = r else { Issue.record("expected available, got \(r)"); return }
        #expect(u.version.description == "2.1.0" && u.releaseURL.host == "github.com")
    }

    @Test func sameOlderPrereleaseAndDraftAreQuiet() async {
        let url = "https://github.com/x/y"
        #expect(await checker(200, #"{"tag_name":"v2.0.0","html_url":"\#(url)"}"#).check(currentVersion: "2.0.0") == .upToDate)
        #expect(await checker(200, #"{"tag_name":"v1.9.0","html_url":"\#(url)"}"#).check(currentVersion: "2.0.0") == .upToDate)
        #expect(await checker(200, #"{"tag_name":"v3.0.0","prerelease":true,"html_url":"\#(url)"}"#).check(currentVersion: "2.0.0") == .upToDate)
        #expect(await checker(200, #"{"tag_name":"v3.0.0","draft":true,"html_url":"\#(url)"}"#).check(currentVersion: "2.0.0") == .upToDate)
    }

    @Test func failuresAndHostileLinksNeverOffer() async {
        for (status, body) in [(404, "{}"), (200, "nope"), (200, #"{"tag_name":"junk"}"#),
                               (200, #"{"tag_name":"v9.0.0","html_url":"https://evil.example/x"}"#),
                               (200, #"{"tag_name":"v9.0.0","html_url":"file:///etc/passwd"}"#)] {
            let r = await checker(status, body).check(currentVersion: "2.0.0")
            if case .failed = r {} else { Issue.record("expected failed for \(body), got \(r)") }
        }
        let down = FakeTransport()
        await down.route("GET", "/repos/Sibhimanyu/squeak/releases/latest", .failure(.timedOut))
        if case .failed = await UpdateChecker(transport: down).check(currentVersion: "2.0.0") {} else { Issue.record("timeout should fail") }
    }

    @Test func requestIsUnauthenticatedWithUserAgentAndTimeout() async {
        let t = FakeTransport()
        await t.json("GET", "/repos/Sibhimanyu/squeak/releases/latest", #"{"tag_name":"v2.0.0"}"#)
        _ = await UpdateChecker(transport: t).check(currentVersion: "2.0.0")
        let req = await t.requests[0]
        #expect(req.headers["User-Agent"] == "Squeak" && req.headers["Authorization"] == nil && req.timeout == 10)
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
        if case .unsupported = chat.capabilities.send {} else { Issue.record("send must be unsupported with the daemon down") }
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

@Suite("Message markup")
struct MessageMarkupTests {
    typealias M = MessageMarkup

    @Test func paragraphWithBoldItalicCode() {
        let b = M.parse("Hello **bold** and *it* and `x`")
        #expect(b == [.paragraph([.text("Hello "), .bold([.text("bold")]), .text(" and "), .italic([.text("it")]), .text(" and "), .code("x")])])
    }

    @Test func nesting() {
        #expect(M.parseInlines("**a *b* c**") == [.bold([.text("a "), .italic([.text("b")]), .text(" c")])])
        #expect(M.parseInlines("*a **b** c*") == [.italic([.text("a "), .bold([.text("b")]), .text(" c")])])
        // Markers inside code stay literal.
        #expect(M.parseInlines("`**x**`") == [.code("**x**")])
    }

    @Test func unclosedMarkersStayLiteral() {
        #expect(M.parseInlines("a **b") == [.text("a **b")])
        #expect(M.parseInlines("a `b") == [.text("a `b")])
        #expect(M.parseInlines("a *b") == [.text("a *b")])
        #expect(M.parseInlines("2 * 3 * 4") == [.text("2 * 3 * 4")])
        #expect(M.parseInlines("snake_case_name") == [.text("snake_case_name")])
        #expect(M.parseInlines("[no](link") == [.text("[no](link")])
    }

    @Test func escapesAndHtmlAreLiteral() {
        #expect(M.parseInlines("\\*not\\*") == [.text("*not*")])
        #expect(M.parseInlines("<b>x</b> <a href=\"u\">y</a>") == [.text("<b>x</b> <a href=\"u\">y</a>")])
    }

    @Test func links() {
        #expect(M.parseInlines("see [the **doc**](https://e.com/a) now") ==
            [.text("see "), .link(label: [.text("the "), .bold([.text("doc")])], destination: "https://e.com/a"), .text(" now")])
        // A destination with a space is not a link.
        #expect(M.parseInlines("[a](b c)") == [.text("[a](b c)")])
        // Bare URLs are plain text.
        #expect(M.parseInlines("https://e.com") == [.text("https://e.com")])
    }

    @Test func headingsListsQuotes() {
        let b = M.parse("## Title ##\n- one\n  - nested\n2. two\n> quoted\n> more\n\npara")
        #expect(b == [
            .heading(level: 2, [.text("Title")]),
            .listItem(marker: .bullet, depth: 0, [.text("one")]),
            .listItem(marker: .bullet, depth: 1, [.text("nested")]),
            .listItem(marker: .number(2), depth: 0, [.text("two")]),
            .quote([.text("quoted\nmore")]),
            .paragraph([.text("para")]),
        ])
        #expect(M.parse("#nospace") == [.paragraph([.text("#nospace")])])
    }

    @Test func codeFenceWithLanguage() {
        let b = M.parse("before\n```swift\nlet a = **1**\n\n  indented\n```\nafter")
        #expect(b == [.paragraph([.text("before")]), .codeBlock(language: "swift", code: "let a = **1**\n\n  indented"), .paragraph([.text("after")])])
        #expect(M.parse("```\nx") == [.codeBlock(language: nil, code: "x")])
    }

    @Test func largeInputIsFast() {
        let chunk = "Some **bold** text with `code`, a [link](https://e.com), and *unclosed ** markers `\n- item\n"
        let big = String(repeating: chunk, count: 200_000 / chunk.utf8.count)
        let pathological = String(repeating: "** _ * ` [ ", count: 8_000)
        let clock = ContinuousClock()
        let t1 = clock.measure { _ = M.parse(big) }
        let t2 = clock.measure { _ = M.parse(pathological) }
        #expect(t1 < .milliseconds(100), "\(t1)")
        #expect(t2 < .milliseconds(100), "\(t2)")
    }
}
