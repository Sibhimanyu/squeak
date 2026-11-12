import Foundation
import Testing
@testable import SqueakMacCore

/// A daemon that behaves like the new `/state`: ETag on 200, 304 for a matching If-None-Match.
private actor ETagDaemon: HTTPTransport {
    var body: String
    var etag: String?
    private(set) var requests: [HTTPRequest] = []
    private(set) var sentValidators: [String?] = []
    init(body: String, etag: String? = "v1") { self.body = body; self.etag = etag }

    func set(body: String, etag: String?) { self.body = body; self.etag = etag }

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        requests.append(request)
        let given = request.headers["if-none-match"]
        sentValidators.append(given)
        if let etag, given == etag { return HTTPResponse(status: 304, headers: ["etag": etag]) }
        return HTTPResponse(status: 200, body: Data(body.utf8), headers: etag.map { ["etag": $0] } ?? [:])
    }
}

private final class Tick: @unchecked Sendable {
    private let lock = NSLock()
    private var t = Date(timeIntervalSince1970: 1_800_000_000)
    func now() -> Date { lock.withLock { t } }
    func advance(_ s: TimeInterval) { lock.withLock { t = t.addingTimeInterval(s) } }
}

private let stateA = #"{"active":[{"key":"conductor:c1","origin":"conductor","agent":"claude","state":"working","title":"A"}]}"#
private let stateB = #"{"active":[{"key":"conductor:c1","origin":"conductor","agent":"claude","state":"finished","title":"A"}]}"#

@Suite("State change detection")
struct StateChangeDetectionTests {
    fileprivate func client(_ t: ETagDaemon, window: TimeInterval = 0, clock: Tick = Tick()) -> DaemonClient {
        DaemonClient(baseURL: URL(string: "http://127.0.0.1:8477")!, transport: t, tokenProvider: { "tok" },
                     stateShareWindow: window, now: { clock.now() })
    }

    @Test func aSecondReadSendsTheETagAndSkipsTheDecodeOnA304() async throws {
        let d = ETagDaemon(body: stateA)
        let c = client(d)
        let first = try await c.state()
        let second = try await c.state()
        #expect(first.sessions.map(\.key) == second.sessions.map(\.key))
        #expect(await d.sentValidators == [nil, "v1"])
        #expect(c.stateCache.decodes == 1 && c.stateCache.notModified == 1)
    }

    @Test func aChangedBodyIsDecodedAndTheNewTagUsedNext() async throws {
        let d = ETagDaemon(body: stateA)
        let c = client(d)
        _ = try await c.state()
        await d.set(body: stateB, etag: "v2")
        let changed = try await c.state()
        #expect(changed.sessions.first?.state == "finished")
        _ = try await c.state()
        #expect(await d.sentValidators == [nil, "v1", "v2"])
        #expect(c.stateCache.decodes == 2)
    }

    @Test func anOlderDaemonWithoutAnETagStillWorksAndIdenticalBytesSkipTheDecode() async throws {
        let d = ETagDaemon(body: stateA, etag: nil)
        let c = client(d)
        _ = try await c.state()
        _ = try await c.state()
        #expect(await d.sentValidators == [nil, nil])
        #expect(c.stateCache.decodes == 1)
        await d.set(body: stateB, etag: nil)
        #expect(try await c.state().sessions.first?.state == "finished")
        #expect(c.stateCache.decodes == 2)
    }

    @Test func readersWithinTheWindowShareOneRequest() async throws {
        let d = ETagDaemon(body: stateA)
        let clock = Tick()
        let c = client(d, window: 0.75, clock: clock)
        async let a = c.state(), b = c.state(), e = c.state()
        _ = try await (a, b, e)
        _ = try await c.state()
        #expect(await d.requests.count == 1)
        clock.advance(1)
        _ = try await c.state()
        #expect(await d.requests.count == 2)
    }

    @Test func aFailedReadIsNotCachedAsAnAnswer() async throws {
        let t = FakeTransport()
        await t.json("GET", "/state", status: 503, "no")
        let c = DaemonClient(baseURL: URL(string: "http://127.0.0.1:8477")!, transport: t, tokenProvider: { "tok" }, stateShareWindow: 5)
        await #expect(throws: (any Error).self) { try await c.state() }
        await t.json("GET", "/state", stateA)
        #expect(try await c.state().sessions.count == 1)
    }
}

@Suite("Nudge pacing and name cache")
struct NudgePacingTests {
    @Test func aBurstOfNudgesIsSpacedByTheMinGapNotTheDebounce() {
        var p = NudgePacer(debounce: 0.2, minGap: 1.0)
        let t0 = Date(timeIntervalSince1970: 1000)
        #expect(p.delay(now: t0) == 0.2)            // nothing ran yet: just the debounce
        p.ran(at: t0)
        #expect(abs(p.delay(now: t0.addingTimeInterval(0.3)) - 0.7) < 1e-3) // 0.3 s after a refresh: wait out the gap
        #expect(p.delay(now: t0.addingTimeInterval(0.95)) == 0.2)           // never below the debounce
        #expect(p.delay(now: t0.addingTimeInterval(5)) == 0.2)              // quiet: answered promptly
    }

    @Test func requestRateUnderAStatusStormIsBoundedByTheGap() {
        // 100 nudges in 10 s (10/s, as a working agent produces): refreshes run at most once per minGap + debounce.
        var p = NudgePacer(debounce: 0.2, minGap: 1.0)
        var now = Date(timeIntervalSince1970: 0)
        var runs = 0
        var pendingAt: Date?
        for step in 0..<1000 {
            now = Date(timeIntervalSince1970: Double(step) * 0.01)
            if step % 10 == 0, pendingAt == nil { pendingAt = now.addingTimeInterval(p.delay(now: now)) }
            if let due = pendingAt, now >= due { p.ran(at: now); runs += 1; pendingAt = nil }
        }
        #expect(runs <= 11) // not the 100 nudges
        #expect(runs >= 8)
    }

    @Test func workspaceNamesAreReusedUntilAnUnknownIdOrTheyAgeOut() {
        let clock = Tick()
        let cache = NativeNameCache(maxAge: 60, now: { clock.now() })
        #expect(cache.fresh(covering: ["w1"]) == nil)
        cache.put(["w1": ("one", nil), "w2": ("two", "T")])
        #expect(cache.fresh(covering: ["w1", "w2"])?["w2"]?.title == "T")
        #expect(cache.fresh(covering: ["w1", "w3"]) == nil)
        clock.advance(61)
        #expect(cache.fresh(covering: ["w1"]) == nil)
    }
}
