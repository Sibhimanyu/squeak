import XCTest
@testable import SqueakMacCore

final class SessionSetTrackingTests: XCTestCase {
    private func key(_ id: String) -> SessionKey { SessionKey(provider: "squeak", hostSessionId: id) }

    func testSwapWithSameCountIsAChange() {
        var t = RevisionTracker(SessionSetSignature(keys: [key("a"), key("b")]))
        XCTAssertTrue(t.update(SessionSetSignature(keys: [key("a"), key("c")])))
        XCTAssertEqual(t.revision, 1)
        XCTAssertFalse(t.update(SessionSetSignature(keys: [key("c"), key("a")])))
        XCTAssertEqual(t.revision, 1)
    }

    func testArchiveFlipIsAChangeWithSameKeys() {
        var t = RevisionTracker(SessionSetSignature(keys: [key("a")]))
        XCTAssertTrue(t.update(SessionSetSignature(keys: [key("a")], archived: [key("a")])))
    }

    func testDeltaNamesWhatLeftAndArrived() {
        let d = SessionSetDiff.delta(from: SessionSetSignature(keys: [key("a"), key("b")]), to: SessionSetSignature(keys: [key("b"), key("c")]))
        XCTAssertEqual(d.removed, [key("a")])
        XCTAssertEqual(d.added, [key("c")])
    }

    func testEmptyListIsNeverPruned() {
        XCTAssertFalse(SessionSetDiff.shouldPrune(SessionSetSignature()))
        XCTAssertTrue(SessionSetDiff.shouldPrune(SessionSetSignature(keys: [key("a")])))
    }

    func testTabCapMemoMeasuresOncePerTitlesAndWidthBucket() {
        let memo = TabCapMemo()
        var calls = 0
        func v(_ titles: [String], _ w: Double) -> Double { memo.value(titles: titles, width: w) { calls += 1; return 100 } }
        _ = v(["a", "b"], 800); _ = v(["a", "b"], 803)
        XCTAssertEqual(calls, 1)
        _ = v(["a", "c"], 803)
        XCTAssertEqual(calls, 2)
        _ = v(["a", "c"], 900)
        XCTAssertEqual(calls, 3)
    }

    func testHiddenHoldHoldsWhileHiddenAndReleasesLatestOnce() {
        var g = HiddenHold<[Int]>()
        XCTAssertNil(g.offer([1], open: false))
        XCTAssertNil(g.offer([1, 2], open: false))
        XCTAssertEqual(g.current(shown: []), [1, 2])
        XCTAssertEqual(g.release(), [1, 2])
        XCTAssertNil(g.release())
        XCTAssertEqual(g.offer([3], open: true), [3])
        XCTAssertEqual(g.current(shown: [3]), [3])
    }

    func testStripPlaceFromRowUsesTheTreesWorkspaceId() throws {
        let project = try JSONDecoder().decode(NativeProject.self, from: Data(#"{"id":"p1","name":"orchard","rootPath":"/r/orchard","defaultBranch":"main"}"#.utf8))
        let ws = try JSONDecoder().decode(NativeWorkspace.self, from: Data(#"{"id":"w1","projectId":"p1","name":"mallard","path":"/r/orchard/mallard","branch":"fix/x"}"#.utf8))
        let place = StripPlaceFromRow.place(project: project, workspace: ws)
        XCTAssertEqual(place.workspace.id, "orchard/\(ws.path)")
        XCTAssertEqual(place.project.name, "orchard")
        XCTAssertFalse(place.workspace.isMain)
        XCTAssertTrue(StripPlaceFromRow.place(project: project, workspace: nil).workspace.isMain)
    }
}
