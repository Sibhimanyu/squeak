import Foundation
import Testing
@testable import SqueakMacCore

@Suite("Daemon decoding and mapping")
struct DaemonDecodingTests {
    @Test func decodesSyntheticStateIgnoringUnknownAndBadFields() throws {
        let state = try JSONDecoder().decode(DaemonState.self, from: Data(syntheticState.utf8))
        // The duplicate listing and the key-less row are dropped.
        #expect(state.sessions.map(\.key) == [
            "claude-transcript:aaaa-1111", "codex-rollout:bbbb-2222",
            "claude-transcript:cccc-3333", "claude-transcript:dddd-4444",
        ])
        #expect(state.sessions[0].title == "Paint the bikeshed")
        #expect(state.sessions[0].lastActivityAt == Date(timeIntervalSince1970: 1_893_553_440))
        #expect(state.sessions[1].lastActivityAt != nil) // fractional seconds
        #expect(state.sessions[2].lastActivityAt == Date(timeIntervalSince1970: 1_893_553_000)) // epoch seconds
        // Wrong types become nil rather than failing the whole state.
        let bad = state.sessions[3]
        #expect(bad.title == nil && bad.alive == nil && bad.contextPercent == nil)
    }

    @Test func mapsAllOriginsWithProviderFromOriginAndAgent() throws {
        let state = try JSONDecoder().decode(DaemonState.self, from: Data(syntheticState.utf8))
        let mapped = state.sessions.map(ConductorDaemonAdapter.map)
        #expect(mapped.map(\.key.provider) == ["conductor", "codex-terminal", "claude-desktop", "claude-sdk"])
        #expect(mapped[0].state == .working)
        #expect(mapped[1].state == .blocked)
        #expect(mapped[2].state == .finished)
        #expect(mapped[3].state == .unknown)
        #expect(mapped[1].label == "Tune the kettle (second)")
        #expect(mapped[0].key.workspaceId == "ws-orchard")
        #expect(mapped[1].key.workspaceId == nil) // empty string is not a workspace
        #expect(mapped.allSatisfy { $0.origin == .hostOwned })
    }

    @Test func capabilitiesFollowReplyTarget() throws {
        let state = try JSONDecoder().decode(DaemonState.self, from: Data(syntheticState.utf8))
        let mapped = state.sessions.map(ConductorDaemonAdapter.map)
        #expect(mapped[0].capabilities.send == .supported)
        #expect(mapped[2].capabilities.send.reason != nil) // no replyTarget
        #expect(mapped[0].capabilities.openInHost == .supported)
        #expect(mapped[1].capabilities.openInHost.isSupported == false)
        #expect(mapped[0].capabilities.attachments.isSupported == false)
        #expect(mapped[0].capabilities.approve.isSupported == false)
        // A busy Conductor chat is still sendable client-side: the daemon decides.
        #expect(mapped[0].state == .working && mapped[0].capabilities.send == .supported)
    }

    @Test func sessionKeyRoundTrips() {
        let k = SessionKey(provider: "conductor", workspaceId: "ws", hostSessionId: "claude-transcript:abc")
        #expect(SessionKey(stringValue: k.stringValue) == k)
        let k2 = SessionKey(provider: "codex-terminal", hostSessionId: "x:y:z")
        #expect(SessionKey(stringValue: k2.stringValue) == k2)
        #expect(SessionKey(stringValue: "nonsense") == nil)
    }

    @Test func conductorOpenURL() async throws {
        let transport = FakeTransport()
        let adapter = ConductorDaemonAdapter(client: DaemonClient(baseURL: URL(string: "http://127.0.0.1:1")!, transport: transport, tokenProvider: { "t" }))
        let state = try JSONDecoder().decode(DaemonState.self, from: Data(syntheticState.utf8))
        let s = ConductorDaemonAdapter.map(state.sessions[0])
        #expect(adapter.openInHostURL(for: s)?.absoluteString == "conductor://workspace?id=ws-orchard&session=aaaa-1111")
        #expect(adapter.openInHostURL(for: ConductorDaemonAdapter.map(state.sessions[1])) == nil)
    }
}

@Suite("Daemon client")
struct DaemonClientTests {
    let base = URL(string: "http://127.0.0.1:8477")!

    func adapter(_ transport: FakeTransport, token: String? = "tok") -> ConductorDaemonAdapter {
        ConductorDaemonAdapter(client: DaemonClient(baseURL: base, transport: transport, tokenProvider: { token }))
    }

    let session = makeSession("t1")

    @Test func discoverReadsState() async throws {
        let t = FakeTransport()
        await t.json("GET", "/state", syntheticState)
        let found = try await adapter(t).discover()
        #expect(found.count == 4)
        let reqs = await t.requests
        #expect(reqs[0].headers["x-squeak-token"] == nil) // /state needs no token
    }

    @Test func discoverMapsConnectionRefusedToDaemonDown() async {
        let t = FakeTransport()
        await t.route("GET", "/state", .failure(.connectionRefused))
        await #expect(throws: AdapterError.daemonDown) { try await adapter(t).discover() }
        let h = await adapter(t).health()
        #expect(h.status == .daemonDown)
    }

    @Test func healthReportsMissingToken() async {
        let t = FakeTransport()
        await t.json("GET", "/state", syntheticState)
        let h = await adapter(t, token: nil).health()
        #expect(h.status == .tokenMissing)
    }

    @Test func transcriptUsesRouteAndSendsToken() async throws {
        let t = FakeTransport()
        await t.json("GET", "/control/session/t1/transcript", """
        {"messages":[{"id":"m1","role":"user","text":"hi","at":"2030-01-02T03:04:05Z","turnId":"T1","extra":1},
                     {"id":"m2","role":"assistant","text":"hello","turnId":"T1"},
                     {"id":"m3","role":"system","text":"skipped"}],"complete":true}
        """)
        let msgs = try await adapter(t).transcript(for: session, limit: 50)
        #expect(msgs.map(\.id) == ["m1", "m2"])
        #expect(msgs[0].role == .user && msgs[1].role == .assistant)
        let req = await t.requests[0]
        #expect(req.headers["x-squeak-token"] == "tok")
        #expect(req.url.query == "limit=50")
    }

    @Test func transcriptFallsBackToMessageOn404() async throws {
        let t = FakeTransport()
        await t.json("GET", "/control/session/t1/message", #"{"text":"last answer","choices":[]}"#)
        let first = try await adapter(t).transcript(for: session, limit: 50)
        let second = try await adapter(t).transcript(for: session, limit: 50)
        #expect(first.count == 1 && first[0].role == .assistant && first[0].text == "last answer")
        #expect(first[0].id == second[0].id) // stable id so polling dedupes
    }

    @Test func transcriptWithoutTokenThrows() async {
        let t = FakeTransport()
        await #expect(throws: AdapterError.tokenMissing) { try await adapter(t, token: nil).transcript(for: session, limit: 5) }
    }

    @Test func activityMapsSteps() async throws {
        let t = FakeTransport()
        await t.json("GET", "/control/session/t1/activity", #"{"steps":[{"kind":"tool","text":"Ran tests","at":"2030-01-02T03:04:05Z"}],"total":1}"#)
        let steps = try await adapter(t).activity(for: session)
        #expect(steps == [ActivityStep(kind: "tool", text: "Ran tests", at: Date(timeIntervalSince1970: 1_893_553_445))])
    }

    // MARK: send mapping

    func sendOutcome(_ route: Result<HTTPResponse, TransportError>, token: String? = "tok") async -> (SendResult, [HTTPRequest]) {
        let t = FakeTransport()
        await t.route("POST", "/control/session/t1/reply", route)
        let r = await adapter(t, token: token).send("do it", to: session, clientId: UUID())
        return (r, await t.requests)
    }

    @Test func startedIsAccepted() async throws {
        let (r, reqs) = await sendOutcome(.success(HTTPResponse(status: 200, body: Data(#"{"status":"started","via":"conductor"}"#.utf8))))
        #expect(r == .accepted(via: "conductor"))
        #expect(reqs.count == 1)
        #expect(reqs[0].headers["x-squeak-token"] == "tok")
        #expect(String(decoding: reqs[0].body ?? Data(), as: UTF8.self).contains("do it"))
    }

    @Test func queuedAndSteeredDeliveriesComeBackFromTheDaemon() async {
        let (queued, _) = await sendOutcome(.success(HTTPResponse(status: 200, body: Data(#"{"status":"started","via":"conductor","delivery":"queued"}"#.utf8))))
        #expect(queued == .accepted(via: "conductor", delivery: .queued))
        let (steered, _) = await sendOutcome(.success(HTTPResponse(status: 200, body: Data(#"{"status":"started","via":"conductor","delivery":"steered"}"#.utf8))))
        #expect(steered == .accepted(via: "conductor", delivery: .steered))
        let (fallback, _) = await sendOutcome(.success(HTTPResponse(status: 200, body: Data(#"{"status":"started","via":"conductor","delivery":"queued","note":"Steer needs Conductor's relay, so this was queued instead."}"#.utf8))))
        #expect(fallback == .accepted(via: "conductor", delivery: .queued, note: "Steer needs Conductor's relay, so this was queued instead."))
    }

    @Test func aQueuedSendCarriesNoModeAndASteerCarriesIt() async {
        let t = FakeTransport()
        await t.json("POST", "/control/session/t1/reply", #"{"status":"started","via":"conductor"}"#)
        let a = adapter(t)
        _ = await a.send("one", to: session, clientId: UUID())
        _ = await a.send("two", to: session, clientId: UUID(), mode: .steer)
        let bodies = await t.requests.map { String(decoding: $0.body ?? Data(), as: UTF8.self) }
        #expect(!bodies[0].contains("mode"))
        #expect(bodies[1].contains(#""mode":"steer""#))
    }

    @Test func startedViaBackgroundKeepsVia() async {
        let (r, _) = await sendOutcome(.success(HTTPResponse(status: 200, body: Data(#"{"status":"started","via":"background","fallbackReason":"window hidden"}"#.utf8))))
        #expect(r == .accepted(via: "background"))
    }

    @Test func refusedCarriesDaemonReason() async {
        let (r, _) = await sendOutcome(.success(HTTPResponse(status: 409, body: Data(#"{"status":"refused","reason":"Conductor is busy with this chat"}"#.utf8))))
        #expect(r == .refused(reason: "Conductor is busy with this chat"))
    }

    @Test func forbiddenIsNotSent() async {
        let (r, _) = await sendOutcome(.success(HTTPResponse(status: 403, body: Data(#"{"error":"forbidden"}"#.utf8))))
        #expect(r == .notSent(reason: "Squeak rejected the access token"))
    }

    @Test func connectionRefusedIsNotSent() async {
        let (r, _) = await sendOutcome(.failure(.connectionRefused))
        guard case .notSent = r else { Issue.record("expected notSent, got \(r)"); return }
    }

    @Test func timeoutIsUncertain() async {
        let (r, reqs) = await sendOutcome(.failure(.timedOut))
        guard case .uncertain = r else { Issue.record("expected uncertain, got \(r)"); return }
        #expect(reqs.count == 1) // not retried
    }

    @Test func connectionDropAfterWriteIsUncertain() async {
        let (r, _) = await sendOutcome(.failure(.connectionLost))
        guard case .uncertain = r else { Issue.record("expected uncertain, got \(r)"); return }
    }

    @Test func serverErrorWithoutBodyIsUncertain() async {
        let (r, _) = await sendOutcome(.success(HTTPResponse(status: 500)))
        guard case .uncertain = r else { Issue.record("expected uncertain, got \(r)"); return }
    }

    @Test func missingTokenIsNotSentWithoutRequest() async {
        let (r, reqs) = await sendOutcome(.success(HTTPResponse(status: 200)), token: nil)
        guard case .notSent = r else { Issue.record("expected notSent, got \(r)"); return }
        #expect(reqs.isEmpty)
    }

    @Test func emptyTextAndNoReplyTargetAreNotSent() async {
        let t = FakeTransport()
        let a = adapter(t)
        let empty = await a.send("   ", to: session, clientId: UUID())
        let noTarget = await a.send("hi", to: makeSession("x", canSend: false), clientId: UUID())
        guard case .notSent = empty, case .notSent = noTarget else { Issue.record("expected notSent"); return }
        #expect(await t.requests.isEmpty)
    }

    @Test func replyTargetWithColonIsPathSafe() async {
        let t = FakeTransport()
        await t.json("POST", "/control/session/codex-rollout:abc/reply", #"{"status":"started","via":"terminal"}"#)
        var s = makeSession("k")
        s.replyTarget = "codex-rollout:abc"
        let r = await adapter(t).send("hello", to: s, clientId: UUID())
        #expect(r == .accepted(via: "terminal"))
    }

    @Test func portComesFromEnvironment() {
        let c = DaemonClient.live(environment: ["SQUEAK_DAEMON_PORT": "9911"], tokenFile: URL(filePath: "/nonexistent"))
        #expect(c.baseURL.absoluteString == "http://127.0.0.1:9911")
        #expect(DaemonClient.live(environment: [:], tokenFile: URL(filePath: "/nonexistent")).baseURL.port == 8477)
        #expect(!c.hasToken)
    }
}
