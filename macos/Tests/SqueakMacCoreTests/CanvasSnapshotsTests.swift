import XCTest
@testable import SqueakMacCore

final class CanvasSnapshotsTests: XCTestCase {
    private func board(_ id: String, at: Int64 = 1, w: Double = 100, h: Double = 50, bg: String? = nil) -> CanvasArtboardInfo {
        CanvasArtboardInfo(id: id, name: id, width: w, height: h, background: bg, file: "/c/\(id).html", modifiedAt: at)
    }
    private func key(_ b: CanvasArtboardInfo, assets: Int64 = 1, path: String = "/p/a.canvas", scale: Int = 2) -> CanvasSnapshotKey {
        CanvasSnapshotKey(canvasPath: path, board: b, assetsModifiedAt: assets, scale: scale)
    }

    func testKeyChangesWithEverythingThatChangesThePicture() {
        let base = key(board("a")).fileName
        XCTAssertEqual(base, key(board("a")).fileName)
        XCTAssertNotEqual(base, key(board("a", at: 2)).fileName)
        XCTAssertNotEqual(base, key(board("a"), assets: 2).fileName)
        XCTAssertNotEqual(base, key(board("a", w: 101)).fileName)
        XCTAssertNotEqual(base, key(board("a", bg: "#fff")).fileName)
        XCTAssertNotEqual(base, key(board("a"), scale: 1).fileName)
        XCTAssertNotEqual(base, key(board("a"), path: "/p/b.canvas").fileName)
        XCTAssertNotEqual(key(board("a")).boardPrefix, key(board("b")).boardPrefix)
        XCTAssertEqual(key(board("a")).boardPrefix, key(board("a", at: 9)).boardPrefix)
        XCTAssertTrue(base.hasPrefix(key(board("a")).boardPrefix))
        XCTAssertEqual(key(board("a", w: 100, h: 50)).pixelBytes, 200 * 100 * 4)
    }

    func testLRUEvictsOldestAndHonoursTouch() {
        var lru = CostLRU<String>(capacity: 100)
        XCTAssertEqual(lru.insert("a", cost: 40), [])
        XCTAssertEqual(lru.insert("b", cost: 40), [])
        XCTAssertTrue(lru.touch("a"))
        XCTAssertEqual(lru.insert("c", cost: 40), ["b"])
        XCTAssertEqual(lru.keys, ["a", "c"])
        XCTAssertEqual(lru.total, 80)
        XCTAssertFalse(lru.touch("zzz"))
    }

    func testLRUReinsertReplacesCostAndOversizeIsNotKept() {
        var lru = CostLRU<String>(capacity: 100)
        _ = lru.insert("a", cost: 60)
        XCTAssertEqual(lru.insert("a", cost: 30), [])
        XCTAssertEqual(lru.total, 30)
        XCTAssertEqual(lru.insert("big", cost: 101), ["big"])
        XCTAssertFalse(lru.contains("big"))
        XCTAssertEqual(lru.total, 30)
        lru.remove("a")
        XCTAssertEqual(lru.total, 0)
        XCTAssertEqual(lru.count, 0)
    }

    func testLRURemoveWhere() {
        var lru = CostLRU<String>(capacity: 100)
        _ = lru.insert("x1", cost: 10); _ = lru.insert("y1", cost: 10); _ = lru.insert("x2", cost: 10)
        XCTAssertEqual(lru.removeAll { $0.hasPrefix("x") }, ["x1", "x2"])
        XCTAssertEqual(lru.keys, ["y1"])
        XCTAssertEqual(lru.total, 10)
    }

    func testPriorityNearestFirstStableOnTies() {
        let frames = ["a": CGRect(x: 0, y: 0, width: 100, height: 100), "b": CGRect(x: 200, y: 0, width: 100, height: 100),
                      "c": CGRect(x: 400, y: 0, width: 100, height: 100), "d": CGRect(x: 600, y: 0, width: 100, height: 100)]
        XCTAssertEqual(CanvasRenderPlan.priority(ids: ["a", "b", "c", "d"], frames: frames, centre: CGPoint(x: 450, y: 50)), ["c", "b", "d", "a"])
        XCTAssertEqual(CanvasRenderPlan.priority(ids: ["a", "b", "c", "d"], frames: frames, centre: CGPoint(x: 350, y: 50)), ["b", "c", "a", "d"])
        XCTAssertEqual(CanvasRenderPlan.priority(ids: ["x", "a"], frames: frames, centre: .zero), ["a", "x"])
    }

    func testBudgetKeepsAtLeastOne() {
        XCTAssertEqual(CanvasRenderPlan.withinBudget(order: ["a", "b", "c"], cost: ["a": 60, "b": 60, "c": 10], budget: 100), ["a"])
        XCTAssertEqual(CanvasRenderPlan.withinBudget(order: ["a", "b", "c"], cost: ["a": 40, "b": 40, "c": 10], budget: 100), ["a", "b", "c"])
        XCTAssertEqual(CanvasRenderPlan.withinBudget(order: ["a"], cost: ["a": 500], budget: 100), ["a"])
        XCTAssertEqual(CanvasRenderPlan.withinBudget(order: [], cost: [:], budget: 100), [])
    }

    func testCancellationsOnlyFarRendersWhileNearerWait() {
        let order = ["a", "b", "c", "d", "e", "f"]
        XCTAssertEqual(CanvasRenderPlan.cancellations(inFlight: ["e", "f"], waiting: ["a"], order: order, keep: 3), ["e", "f"])
        XCTAssertEqual(CanvasRenderPlan.cancellations(inFlight: ["b", "e"], waiting: ["a"], order: order, keep: 3), ["e"])
        XCTAssertEqual(CanvasRenderPlan.cancellations(inFlight: ["e"], waiting: [], order: order, keep: 3), [])
        XCTAssertEqual(CanvasRenderPlan.cancellations(inFlight: ["e"], waiting: ["f"], order: order, keep: 3), [])
        XCTAssertEqual(CanvasRenderPlan.cancellations(inFlight: ["gone"], waiting: ["a"], order: order, keep: 3), ["gone"])
    }

    func testDiskVictimsOldestFirstAndSuperseded() {
        let now = Date()
        let files = [
            CanvasDiskCache.File(name: "new", bytes: 50, modified: now),
            CanvasDiskCache.File(name: "old", bytes: 50, modified: now.addingTimeInterval(-100)),
            CanvasDiskCache.File(name: "mid", bytes: 50, modified: now.addingTimeInterval(-50)),
        ]
        XCTAssertEqual(CanvasDiskCache.victims(files, capacity: 100), ["old"])
        XCTAssertEqual(CanvasDiskCache.victims(files, capacity: 60), ["old", "mid"])
        XCTAssertEqual(CanvasDiskCache.victims(files, capacity: 500), [])
        let k = key(board("a")), older = key(board("a", at: 0)), other = key(board("b"))
        XCTAssertEqual(CanvasDiskCache.superseded([k.fileName, older.fileName, other.fileName], by: k), [older.fileName])
    }
}
