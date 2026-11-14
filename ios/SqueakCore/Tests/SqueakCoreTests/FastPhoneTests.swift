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
