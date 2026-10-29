import XCTest
@testable import SqueakMacCore

final class SetupWalkthroughTests: XCTestCase {
    private func ready() -> WalkFacts {
        WalkFacts(setup: SetupFacts(service: .running, conductorInstalled: false))
    }

    func testOrderAndCount() {
        let w = SetupWalkthrough(WalkFacts())
        XCTAssertEqual(w.steps.map(\.rawValue), ["service", "hooks", "conductor", "hands", "notifications", "hotkey", "iphone", "telegram", "cliq", "voice", "awake"])
        XCTAssertEqual(w.progressLabel(.notifications), "5 of 11")
    }

    func testRequiredCannotBeSkippedOrPassed() {
        let w = SetupWalkthrough(WalkFacts(), skipped: ["service", "hooks"])
        XCTAssertFalse(w.canSkip(.service)); XCTAssertFalse(w.canSkip(.hooks))
        XCTAssertFalse(w.canContinue(.service))
        XCTAssertEqual(w.state(.service), .todo)
        XCTAssertEqual(SetupWalkthrough.skipping(.hooks, in: []), [])
        XCTAssertEqual(w.firstOpen, .service)
        XCTAssertFalse(w.isFinished)
    }

    func testSkipResumeAndFinish() {
        let w = SetupWalkthrough(ready(), skipped: ["hands", "notifications"])
        XCTAssertEqual(w.state(.hands), .skipped)
        XCTAssertTrue(w.canContinue(.hands))
        XCTAssertEqual(w.firstOpen, .hooks)
        XCTAssertFalse(w.isFinished)
        XCTAssertEqual(w.next(after: .conductor), .hands)
        XCTAssertNil(w.next(after: .awake)); XCTAssertNil(w.previous(before: .service))
    }

    func testDoneFromFactsPassesThrough() {
        var f = ready()
        f.telegram = true; f.awake = true
        let w = SetupWalkthrough(f, skipped: ["telegram"])
        XCTAssertEqual(w.state(.telegram), .done)
        XCTAssertEqual(w.state(.conductor), .done)
        XCTAssertEqual(w.state(.cliq), .todo)
        XCTAssertTrue(w.doneSteps.contains(.awake))
    }

    func testSkipSetRoundTrip() {
        let s = SetupWalkthrough.skipping(.cliq, in: ["voice"])
        XCTAssertEqual(s, ["voice", "cliq"])
        XCTAssertEqual(SetupWalkthrough.unskipping(.cliq, in: s), ["voice"])
        let w = SetupWalkthrough(WalkFacts(), skipped: s)
        XCTAssertEqual(w.skippedSteps, [.cliq, .voice])
    }
}
