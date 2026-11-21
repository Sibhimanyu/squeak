import XCTest

@testable import SqueakMacCore

final class ActivityDerivedCacheTests: XCTestCase {
    private func step(_ kind: String, _ text: String, at: Double = 0) -> ActivityStep {
        ActivityStep(kind: kind, text: text, at: Date(timeIntervalSince1970: at))
    }

    func testSameStepsAreDerivedOnce() {
        let cache = ActivityDerivedCache()
        let steps = [step("tool", "Read a.swift", at: 1), step("progress", "p", at: 2), step("retry", "r", at: 3)]
        XCTAssertEqual(cache.listed(steps).map(\.kind), ["tool"])
        _ = cache.listed(steps)
        _ = cache.block(steps, working: true)
        _ = cache.block(steps, working: true)
        _ = cache.progressDetail(steps)
        XCTAssertEqual(cache.computeCount, 1)
    }

    func testAStepEditedInPlaceRecomputes() {
        let cache = ActivityDerivedCache()
        var steps = [step("tool", "Read a.swift", at: 1), step("tool", "Run tests", at: 2), step("tool", "Edit b", at: 3)]
        _ = cache.listed(steps)
        steps[1].text = "Run tests (done)"
        XCTAssertEqual(cache.listed(steps)[1].text, "Run tests (done)")
        XCTAssertEqual(cache.computeCount, 2)
    }

    func testAnEqualCopyIsAHit() {
        let cache = ActivityDerivedCache()
        let steps = [step("tool", "a", at: 1)]
        _ = cache.listed(steps)
        _ = cache.listed(steps.map { $0 })
        XCTAssertEqual(cache.computeCount, 1)
    }

    func testBlockFollowsTheWorkingFlagWithoutRecomputingTheSteps() {
        let cache = ActivityDerivedCache()
        let steps = (0..<8).map { step("tool", "Read \($0)", at: Double($0)) }
        let live = cache.block(steps, working: true)
        let done = cache.block(steps, working: false)
        XCTAssertEqual(live, TurnFolding.block(steps: steps, working: true))
        XCTAssertEqual(done, TurnFolding.block(steps: steps, working: false))
        XCTAssertNotEqual(live, done)
        XCTAssertEqual(cache.computeCount, 1)
    }

    func testTurnStartReadsAgainWhenTheMessagesMove() {
        let cache = ActivityDerivedCache()
        let steps = [step("tool", "a", at: 50)]
        let first = [ChatMessage(id: "u1", role: .user, text: "hi", at: Date(timeIntervalSince1970: 10))]
        XCTAssertEqual(cache.turnStart(messages: first, activity: steps), Date(timeIntervalSince1970: 10))
        let second = first + [ChatMessage(id: "u2", role: .user, text: "again", at: Date(timeIntervalSince1970: 40))]
        XCTAssertEqual(cache.turnStart(messages: second, activity: steps), Date(timeIntervalSince1970: 40))
        XCTAssertEqual(cache.turnStart(messages: second, activity: steps), Date(timeIntervalSince1970: 40))
    }

    func testProgressDetailIsTheNewestProgressStep() {
        let cache = ActivityDerivedCache()
        var p = step("progress", "x", at: 2)
        p.detail = .progress(steps: ["a", "b"], current: 1, percent: nil, status: nil)
        XCTAssertEqual(cache.progressDetail([step("tool", "a", at: 1), p]), p.detail)
        XCTAssertNil(cache.progressDetail([step("tool", "a", at: 1)]))
    }
}
