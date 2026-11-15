import XCTest
@testable import SqueakCore

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

    func testDotsTraceThreeWaveLines() {
        for row in 0..<StreamDotGlyph.rows {
            let ys = (0..<StreamDotGlyph.columns).map { StreamDotGlyph.centre(row: row, column: $0).y }
            XCTAssertGreaterThan(Set(ys.map { ($0 * 1000).rounded() }).count, 1)
            XCTAssertTrue(ys.allSatisfy { $0 > 0 && $0 < 1 })
            XCTAssertLessThan(ys.max()! - ys.min()!, 1.0 / Double(StreamDotGlyph.rows))
        }
    }

    func testOnlyWorkingMovesAndLoops() {
        XCTAssertFalse(StreamDotGlyph.flows(.idle)); XCTAssertFalse(StreamDotGlyph.flows(.needsYou)); XCTAssertFalse(StreamDotGlyph.flows(.error))
        XCTAssertEqual(StreamDotGlyph.level(.idle, row: 1, column: 2, time: 3, animated: true), StreamDotGlyph.idleLevel)
        XCTAssertEqual(StreamDotGlyph.level(.needsYou, row: 0, column: 0, time: 3, animated: true), 1)
        for row in 0..<3 { for col in 0..<6 { for i in 0..<32 {
            let t = Double(i) * 0.05
            let v = StreamDotGlyph.wave(row: row, column: col, time: t)
            XCTAssertTrue(v >= StreamDotGlyph.troughLevel - 1e-9 && v <= 1 + 1e-9)
            XCTAssertEqual(v, StreamDotGlyph.wave(row: row, column: col, time: t + StreamDotGlyph.flowSeconds), accuracy: 1e-9)
        } } }
    }

    func testCrestTravelsRightAndReduceMotionHoldsAFrame() {
        func brightest(_ t: Double) -> Int {
            (0..<6).max { StreamDotGlyph.wave(row: 0, column: $0, time: t) < StreamDotGlyph.wave(row: 0, column: $1, time: t) }!
        }
        XCTAssertEqual(brightest(0.01), 0)
        XCTAssertEqual(brightest(StreamDotGlyph.flowSeconds * 3 / 6), 3)
        let a = StreamDotGlyph.level(.working, row: 0, column: 2, time: 0.3, animated: false)
        let b = StreamDotGlyph.level(.working, row: 0, column: 2, time: 1.1, animated: false)
        XCTAssertEqual(a, b)
    }
}
