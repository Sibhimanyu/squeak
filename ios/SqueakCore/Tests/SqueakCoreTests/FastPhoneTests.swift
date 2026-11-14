import XCTest
@testable import SqueakCore

final class FastPhoneTests: XCTestCase {
    private func tmp() -> URL {
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("fast-\(UUID().uuidString)")
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    private func doc(_ titles: [String], pond: String = "p1") -> PondThreads {
        PondThreads(pond: pond, total: titles.count, streams: [.init(
            id: "s", name: "Main", main: true,
            threads: titles.enumerated().map { .init(key: "k\($0.offset)", title: $0.element, state: "idle", at: "2026-11-14T10:00:00Z") })])
    }

    func testPondThreadsComeBackWithNoNetworkAndPerMac() {
        let dir = tmp()
        let a = PondThreadsStore(directory: dir, name: "mac-a")
        a.record(doc(["one", "two"]), for: "p1")
        a.flush()
        XCTAssertEqual(PondThreadsStore(directory: dir, name: "mac-a").load("p1"), doc(["one", "two"]))
        XCTAssertNil(PondThreadsStore(directory: dir, name: "mac-b").load("p1"))
        a.clear(); a.flush()
        XCTAssertNil(PondThreadsStore(directory: dir, name: "mac-a").load("p1"))
    }

    func testPondThreadsStayBoundedAndKeepIdsOnRefresh() {
        let store = PondThreadsStore(directory: tmp(), name: "m")
        let base = Date()
        for i in 0..<(PondThreadsStore.maxPonds + 5) { store.record(doc(["t"], pond: "p\(i)"), for: "p\(i)", now: base.addingTimeInterval(Double(i))) }
        XCTAssertNil(store.load("p0"))
        XCTAssertNotNil(store.load("p\(PondThreadsStore.maxPonds + 4)"))
        let ids = store.load("p24")?.threads.map(\.id)
        store.record(doc(["renamed"], pond: "p24"), for: "p24")
        XCTAssertEqual(store.load("p24")?.threads.map(\.id), ids)
        XCTAssertEqual(store.load("p24")?.threads.first?.title, "renamed")
    }

    func testOldPondThreadsAreNotShown() {
        let dir = tmp()
        let store = PondThreadsStore(directory: dir, name: "m")
        store.record(doc(["x"]), for: "p", now: Date().addingTimeInterval(-PondThreadsStore.maxAge - 60))
        store.flush()
        XCTAssertNil(PondThreadsStore(directory: dir, name: "m").load("p"))
    }

    func testPrefetchRespectsBounds() {
        let now = Date()
        let c = (0..<10).map { PrefetchPlan.Candidate(key: "k\($0)", canDelta: $0 != 9, lastActivity: now.addingTimeInterval(-Double($0))) }
        XCTAssertEqual(PrefetchPlan.keys(from: c, warmedAt: [:], now: now, lowPower: false), ["k0", "k1", "k2", "k3"])
        XCTAssertEqual(PrefetchPlan.keys(from: c, warmedAt: ["k0": now.addingTimeInterval(-5)], now: now, lowPower: false), ["k1", "k2", "k3", "k4"])
        XCTAssertTrue(PrefetchPlan.keys(from: c, warmedAt: [:], now: now, lowPower: true).isEmpty)
        XCTAssertTrue(PrefetchPlan.keys(from: c, warmedAt: [:], now: now, lowPower: false, constrained: true).isEmpty)
        XCTAssertTrue(PrefetchPlan.keys(from: c, warmedAt: [:], now: now, lowPower: false, macReachable: false).isEmpty)
        XCTAssertFalse(PrefetchPlan.keys(from: c, warmedAt: [:], now: now, limit: 20, lowPower: false).contains("k9"))
    }

    func testScrollPrefetchIsRateLimitedAndBounded() {
        let now = Date()
        func allowed(_ warms: [Date] = [], key: String = "k", warmed: [String: Date] = [:], low: Bool = false) -> Bool {
            PrefetchPlan.scrollAllowed(key: key, canDelta: true, warmedAt: warmed, recentScrollWarms: warms, now: now, lowPower: low)
        }
        XCTAssertTrue(allowed())
        XCTAssertFalse(allowed(low: true))
        XCTAssertFalse(allowed(warmed: ["k": now.addingTimeInterval(-3)]))
        XCTAssertFalse(allowed((0..<4).map { now.addingTimeInterval(-Double($0)) }))
        XCTAssertTrue(allowed((0..<4).map { now.addingTimeInterval(-11 - Double($0)) }))
        XCTAssertFalse(PrefetchPlan.scrollAllowed(key: "k", canDelta: false, warmedAt: [:], recentScrollWarms: [], now: now, lowPower: false))
    }

    func testOptimisticArchiveAndRenameRollBackAndReconcile() {
        func session(_ key: String, _ title: String) -> PhoneSnapshot.Session {
            PhoneSnapshot.Session(key: key, conductorSessionId: nil, label: "repo", agent: "claude", state: "idle",
                                  lastActivityAt: "2026-11-14T10:00:00Z", detail: nil, git: nil, contextPercent: nil, turnId: nil,
                                  message: nil, choices: nil, title: title)
        }
        var view = PhoneSnapshot(v: 1, mac: "m", generatedAt: "", duck: .init(blockedCount: 0, workingCount: 0), sessions: [], recent: [])
        view.sessions = [session("a", "A"), session("b", "B"), session("c", "C")]
        view.recent = nil
        var edits = OptimisticEdits()
        edits.archive("a"); edits.rename("b", to: "Bee")
        var shown = edits.apply(to: view)
        XCTAssertEqual(shown.sessions.map(\.key), ["b", "c"])
        XCTAssertEqual(shown.sessions.first?.title, "Bee")
        // Refusal: back as it was, same order.
        edits.rollback("a"); edits.rollback("b")
        XCTAssertEqual(edits.apply(to: view).sessions.map(\.key), ["a", "b", "c"])
        // Confirmation: the Mac's view carries it, so the edit retires.
        edits.archive("a"); edits.rename("b", to: "Bee")
        var confirmed = view
        confirmed.sessions = [session("b", "Bee"), session("c", "C")]
        edits.reconcile(with: confirmed)
        XCTAssertTrue(edits.isEmpty)
        // Never confirmed: dropped after the ttl.
        edits.rename("c", to: "Sea", now: now(-OptimisticEdits.ttl - 1))
        edits.reconcile(with: view)
        shown = edits.apply(to: view)
        XCTAssertEqual(shown.sessions.last?.title, "C")
    }

    /// Real cache costs at the Mac's own caps (a pond sends its newest 200 threads): what a first frame pays instead of a
    /// channel round trip. Printed as `fast-phone-timing` lines so a run can be read; the bounds are loose on purpose.
    func testCachedPathCostsMillisecondsNotARoundTrip() {
        let dir = tmp()
        let titles = (0..<200).map { "thread number \($0) with a realistic title length" }
        let store = PondThreadsStore(directory: dir, name: "t")
        store.record(doc(titles), for: "big"); store.flush()
        var t0 = ProcessInfo.processInfo.systemUptime
        let held = PondThreadsStore(directory: dir, name: "t").load("big")
        let pondLoad = (ProcessInfo.processInfo.systemUptime - t0) * 1000
        XCTAssertEqual(held?.threads.count, 200)
        var view = PhoneSnapshot(v: 1, mac: "m", generatedAt: "", duck: .init(blockedCount: 0, workingCount: 0), sessions: [], recent: [])
        view.sessions = (0..<200).map {
            PhoneSnapshot.Session(key: "k\($0)", conductorSessionId: nil, label: "r", agent: "claude", state: "idle", lastActivityAt: "2026-11-14T10:00:00Z",
                                  detail: nil, git: nil, contextPercent: nil, turnId: nil, message: nil, choices: nil, title: "T\($0)")
        }
        var edits = OptimisticEdits(); edits.archive("k5"); edits.rename("k6", to: "x")
        t0 = ProcessInfo.processInfo.systemUptime
        _ = edits.apply(to: view)
        let apply = (ProcessInfo.processInfo.systemUptime - t0) * 1000
        print("fast-phone-timing pond-threads-cache-load(200 threads)=\(String(format: "%.2f", pondLoad)) ms optimistic-apply(200 rows)=\(String(format: "%.2f", apply)) ms")
        XCTAssertLessThan(pondLoad, 100)
        XCTAssertLessThan(apply, 50)
    }

    private func now(_ offset: TimeInterval) -> Date { Date().addingTimeInterval(offset) }

    func testPerfLogMeasuresAndIsOffByDefault() {
        let t = ManualClock()
        let on = PerfLog(enabled: true, clock: { t.now })
        on.begin(.openChat, "k"); t.now += 0.25
        XCTAssertEqual(on.end(.openChat, "k", cached: true)?.seconds ?? 0, 0.25, accuracy: 0.001)
        XCTAssertEqual(on.lines, ["open-chat 250 ms cache"])
        let off = PerfLog(enabled: false)
        off.begin(.openMac)
        XCTAssertNil(off.end(.openMac))
    }
}

private final class ManualClock: @unchecked Sendable { var now: TimeInterval = 0 }
