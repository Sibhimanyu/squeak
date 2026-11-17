import XCTest
@testable import SqueakCore
import SqueakIcons

final class StatusGlyphTests: XCTestCase {
    private func chat(_ state: String, ducklings: Int? = nil, question: Bool = false) -> PhoneSnapshot.Session {
        var s = PhoneSnapshot.Session(
            key: UUID().uuidString, conductorSessionId: nil, label: "a", agent: "claude", state: state,
            lastActivityAt: "2026-11-09T10:00:00Z", detail: nil, git: nil, contextPercent: nil,
            turnId: nil, message: nil, choices: nil, title: "t")
        if let ducklings { s.ducklings = .init(running: ducklings, items: []) }
        return s
    }

    func testRollupPrecedenceAndDucklings() {
        XCTAssertEqual(StatusRollup(sessions: []).activity, .idle)
        XCTAssertEqual(StatusRollup(sessions: [chat("finished"), chat("idle")]).activity, .idle)
        let held = StatusRollup(sessions: [chat("finished", ducklings: 1), chat("working")])
        XCTAssertEqual(held, StatusRollup(activity: .working, working: 2, needsYou: 0))
        XCTAssertEqual(StatusRollup(sessions: [chat("error"), chat("working")]).activity, .working)
        XCTAssertEqual(StatusRollup(sessions: [chat("error"), chat("finished")]).activity, .error)
        XCTAssertEqual(StatusRollup(sessions: [chat("awaiting_approval"), chat("working")]),
                       StatusRollup(activity: .needsYou, working: 1, needsYou: 1))
    }

    func testMacWordsAndMarks() {
        XCTAssertEqual(StatusRollup(activity: "needs_you", working: 1, needsYou: 2)?.mark, .needsYou(2))
        XCTAssertEqual(StatusRollup(activity: "working", working: 3, needsYou: nil)?.mark, .working)
        XCTAssertEqual(StatusRollup(activity: "error", working: nil, needsYou: nil)?.mark, .error)
        XCTAssertNil(StatusRollup(activity: "idle", working: 0, needsYou: 0)?.mark)
        XCTAssertNil(StatusRollup(activity: "later-word", working: 1, needsYou: 0))
        XCTAssertNil(StatusRollup(activity: nil, working: nil, needsYou: nil))
    }

    func testVoiceOverLabel() {
        XCTAssertEqual(StatusRollup(activity: .needsYou, working: 1, needsYou: 1).label(for: "greenroom"), "greenroom, 1 working, 1 needs you")
        XCTAssertEqual(StatusRollup(activity: .idle).label(for: "greenroom"), "greenroom")
        XCTAssertEqual(StatusRollup(activity: .error).label(for: "greenroom"), "greenroom, failed")
    }

    func testGlyphOnlyForWorkAndNeverFrozen() {
        for a in [StatusRollup.Activity.idle, .needsYou, .error] {
            XCTAssertEqual(StatusRollup(activity: a).glyph(macIsLive: true, reduceMotion: false), .none)
            XCTAssertEqual(StatusRollup(activity: a).glyph(macIsLive: true, reduceMotion: true), .none)
        }
        let working = StatusRollup(activity: .working, working: 1)
        XCTAssertEqual(working.glyph(macIsLive: true, reduceMotion: false), .animatedGlyph)
        XCTAssertEqual(working.glyph(macIsLive: true, reduceMotion: true), .reduceMotionIcon)
        // A silent Mac's "working" is stale: no glyph, not a held one.
        XCTAssertEqual(working.glyph(macIsLive: false, reduceMotion: false), .none)
    }
}
