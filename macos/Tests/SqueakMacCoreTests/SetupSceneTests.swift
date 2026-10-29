import XCTest
@testable import SqueakMacCore

final class SetupSceneTests: XCTestCase {
    private func input(_ s: SetupStage, _ edit: (inout SetupSceneInput) -> Void = { _ in }) -> SetupSceneInput {
        var i = SetupSceneInput(stage: s); edit(&i); return i
    }

    func testWelcomeSleepsThenWakes() {
        XCTAssertEqual(SetupDirector.plan(input(.welcome)).mood, .asleep)
        XCTAssertEqual(SetupDirector.plan(input(.welcome) { $0.started = true }).mood, .idle)
    }

    func testConnectMoods() {
        XCTAssertEqual(SetupDirector.plan(input(.connect)).mood, .working)
        XCTAssertEqual(SetupDirector.plan(input(.connect) { $0.connectFailed = true }).mood, .needsYou)
        XCTAssertEqual(SetupDirector.plan(input(.connect) { $0.connectReady = true }).mood, .celebrating)
    }

    func testFirstWinShowsRealTitleAndCelebrates() {
        let waiting = SetupDirector.plan(input(.firstWin))
        XCTAssertEqual(waiting.mood, .idle)
        XCTAssertEqual(waiting.scene, .menuBar(sessionTitle: nil))
        let seen = SetupDirector.plan(input(.firstWin) { $0.sessionTitle = "Fix login" })
        XCTAssertEqual(seen.mood, .celebrating)
        XCTAssertEqual(seen.scene, .menuBar(sessionTitle: "Fix login"))
    }

    func testAwayScenesFollowChoiceAndState() {
        XCTAssertEqual(SetupDirector.plan(input(.away)).scene, .awayChoose)
        XCTAssertEqual(SetupDirector.plan(input(.away) { $0.awayChoice = .web }).scene, .web)
        XCTAssertEqual(SetupDirector.plan(input(.away) { $0.awayChoice = .iphone; $0.awayWaiting = true }).mood, .working)
        XCTAssertEqual(SetupDirector.plan(input(.away) { $0.awayChoice = .telegram; $0.awaySucceeded = true; $0.awayWaiting = true }).mood, .celebrating)
        XCTAssertEqual(SetupDirector.plan(input(.away) { $0.awayChoice = .telegram }).scene, .telegram)
    }

    func testDoneCelebrates() {
        XCTAssertEqual(SetupDirector.plan(input(.done)), SetupScenePlan(mood: .celebrating, scene: .done))
    }

    func testMoodArtAndMotionFollowDesign() {
        XCTAssertEqual(SetupDuckMood.idle.spriteFile, "duck.png")
        XCTAssertEqual(SetupDuckMood.needsYou.spriteFile, "duck-needs_you.png")
        XCTAssertEqual(SetupDuckMood.asleep.period, 5.0)
        XCTAssertEqual(SetupDuckMood.working.period, 1.1)
        XCTAssertEqual(SetupDuckMood.celebrating.motion, .hop)
        XCTAssertEqual(SetupDuckMood.needsYou.motion, .wobble)
        XCTAssertEqual(SetupDuckMood.offline.motion, .still)
        XCTAssertEqual(SetupMotion.standard, 0.2)
    }

    func testRowsAppearOneAfterAnother() {
        func row(_ id: String, _ s: ConnectRowState) -> ConnectRow { ConnectRow(id: id, title: id, detail: nil, state: s) }
        let rows = [row("a", .done), row("b", .working), row("c", .pending)]
        XCTAssertEqual(SetupDirector.revealedRows(rows).map(\.id), ["a", "b"])
        XCTAssertEqual(SetupDirector.revealedRows(rows.map { row($0.id, .done) }).count, 3)
    }

    func testTrackFills() {
        XCTAssertEqual(SetupDirector.trackFill(.welcome), 0)
        XCTAssertEqual(SetupDirector.trackFill(.done), 1)
        XCTAssertEqual(SetupDirector.trackFill(.firstWin), 0.5)
        XCTAssertTrue(SetupDirector.isReached(.connect, current: .away))
        XCTAssertFalse(SetupDirector.isReached(.done, current: .away))
    }
}
