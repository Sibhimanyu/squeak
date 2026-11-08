import XCTest
@testable import SqueakUI

final class DictationTests: XCTestCase {
    private func recording(base: String = "") -> Dictation {
        var d = Dictation()
        d.start(base: base)
        d.handle(.granted)
        return d
    }

    func testStartAsksForPermissionsThenRecords() {
        var d = Dictation()
        XCTAssertEqual(d.state, .idle)
        d.start(base: "hi")
        XCTAssertEqual(d.state, .requesting)
        XCTAssertTrue(d.isActive)
        d.handle(.granted)
        XCTAssertEqual(d.state, .recording)
    }

    func testDeniedKeepsTheReasonAndCanRetry() {
        var d = Dictation()
        d.start(base: "")
        d.handle(.denied(.microphone))
        XCTAssertEqual(d.state, .denied(.microphone))
        XCTAssertFalse(d.isActive)
        d.start(base: "")
        XCTAssertEqual(d.state, .requesting)
    }

    func testPartialsStreamIntoTheDraftAndReplaceEachOther() {
        var d = recording(base: "Fix the bug")
        d.handle(.partial("and"))
        XCTAssertEqual(d.liveText, "Fix the bug and")
        d.handle(.partial("and add a test"))
        XCTAssertEqual(d.liveText, "Fix the bug and add a test")
    }

    func testStopFinishesThenFinalWordEndsIt() {
        var d = recording()
        d.handle(.partial("hello wor"))
        d.handle(.stop)
        XCTAssertEqual(d.state, .finishing)
        d.handle(.final("hello world"))
        XCTAssertEqual(d.state, .idle)
        XCTAssertEqual(d.liveText, "hello world")
    }

    func testStopThenFinishedKeepsThePartial() {
        var d = recording()
        d.handle(.partial("hello"))
        d.handle(.stop)
        d.handle(.finished)
        XCTAssertEqual(d.state, .idle)
        XCTAssertEqual(d.liveText, "hello")
    }

    func testCancelDiscardsWhatWasHeardAndKeepsTheDraft() {
        var d = recording(base: "draft")
        d.handle(.partial("not wanted"))
        d.handle(.cancel)
        XCTAssertEqual(d.state, .idle)
        XCTAssertEqual(d.liveText, "draft")
    }

    func testCancelWhileRequestingGoesIdle() {
        var d = Dictation()
        d.start(base: "x")
        d.handle(.cancel)
        XCTAssertEqual(d.state, .idle)
    }

    func testErrorWithWordsKeepsThemAndWithoutFails() {
        var kept = recording()
        kept.handle(.partial("kept"))
        kept.handle(.failed("boom"))
        XCTAssertEqual(kept.state, .idle)
        XCTAssertEqual(kept.liveText, "kept")

        var none = recording()
        none.handle(.failed("boom"))
        XCTAssertEqual(none.state, .failed("boom"))
    }

    func testStartWhileActiveIsIgnored() {
        var d = recording(base: "a")
        d.start(base: "b")
        XCTAssertEqual(d.state, .recording)
        XCTAssertEqual(d.base, "a")
    }

    func testStrayEventsDoNothing() {
        var d = Dictation()
        d.handle(.partial("x"))
        d.handle(.stop)
        XCTAssertEqual(d.state, .idle)
        XCTAssertEqual(d.transcript, "")
    }

    func testMerge() {
        XCTAssertEqual(Dictation.merge(base: "", heard: " hi "), "hi")
        XCTAssertEqual(Dictation.merge(base: "a", heard: "b"), "a b")
        XCTAssertEqual(Dictation.merge(base: "a\n", heard: "b"), "a\nb")
        XCTAssertEqual(Dictation.merge(base: "a", heard: ""), "a")
    }

    func testSetupLabelSplitsModelFromLevel() {
        let a = ComposerSetupLabel.split("Opus 5.5 · 1M · Medium · Fast")
        XCTAssertEqual(a.model, "Opus 5.5 · 1M")
        XCTAssertEqual(a.detail, "Medium · Fast")
        let b = ComposerSetupLabel.split("GPT 5.5")
        XCTAssertEqual(b.model, "GPT 5.5")
        XCTAssertEqual(b.detail, "")
        XCTAssertEqual(ComposerSetupLabel.split("Opus · Extra high").detail, "Extra high")
    }

    func testLevelWindowRollsAndClamps() {
        var w = LevelWindow(capacity: 3)
        w.push(rms: 0)
        w.push(rms: 0.1)
        w.push(rms: 1)
        w.push(rms: 1)
        XCTAssertEqual(w.levels.count, 3)
        XCTAssertEqual(w.levels.last, 1)
        XCTAssertGreaterThan(w.levels[0], 0)
        w.clear()
        XCTAssertEqual(w.levels, [0, 0, 0])
    }
}
