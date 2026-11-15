import Foundation
import Testing

@testable import SqueakMacCore

@Suite struct StreamDotGlyphTests {
    @Test func dotsTraceThreeWaveLines() {
        for row in 0..<StreamDotGlyph.rows {
            let ys = (0..<StreamDotGlyph.columns).map { StreamDotGlyph.centre(row: row, column: $0).y }
            #expect(Set(ys.map { ($0 * 1000).rounded() }).count > 1)  // not a flat line
            #expect(ys.allSatisfy { $0 > 0 && $0 < 1 })
            #expect(ys.max()! - ys.min()! < 1.0 / Double(StreamDotGlyph.rows))  // lines never touch
        }
        let xs = (0..<StreamDotGlyph.columns).map { StreamDotGlyph.centre(row: 0, column: $0).x }
        #expect(xs == xs.sorted() && xs.first! > 0 && xs.last! < 1)
    }

    @Test func idleIsStaticAndDim() {
        for t in [0.0, 0.4, 9.9] {
            #expect(StreamDotGlyph.level(state: .idle, row: 1, column: 2, time: t, animated: true) == StreamDotGlyph.idleLevel)
        }
        #expect(!StreamDotGlyph.flows(.idle))
    }

    @Test func steadyStatesDoNotMove() {
        for state in [StreamGlyphState.waiting, .failed, .unread] {
            #expect(!StreamDotGlyph.flows(state))
            #expect(StreamDotGlyph.level(state: state, row: 0, column: 3, time: 0.7, animated: true) == 1)
        }
    }

    @Test func workingWaveStaysInRangeAndLoops() {
        for row in 0..<3 { for col in 0..<6 { for i in 0..<32 {
            let t = Double(i) * 0.05
            let v = StreamDotGlyph.wave(row: row, column: col, time: t)
            #expect(v >= StreamDotGlyph.troughLevel - 1e-9 && v <= 1 + 1e-9)
            #expect(abs(v - StreamDotGlyph.wave(row: row, column: col, time: t + StreamDotGlyph.flowSeconds)) < 1e-9)
        } } }
    }

    @Test func crestTravelsLeftToRight() {
        func brightest(_ t: Double) -> Int {
            (0..<6).max { StreamDotGlyph.wave(row: 0, column: $0, time: t) < StreamDotGlyph.wave(row: 0, column: $1, time: t) }!
        }
        #expect(brightest(0.01) == 0)
        #expect(brightest(StreamDotGlyph.flowSeconds * 3 / 6) == 3)
        #expect(brightest(StreamDotGlyph.flowSeconds * 5 / 6) == 5)
    }

    @Test func reduceMotionHoldsOneFrameOfTheWave() {
        let a = StreamDotGlyph.level(state: .working, row: 0, column: 2, time: 0.3, animated: false)
        let b = StreamDotGlyph.level(state: .working, row: 0, column: 2, time: 1.1, animated: false)
        #expect(a == b)
        let held = (0..<6).map { StreamDotGlyph.level(state: .working, row: 0, column: $0, time: 5, animated: false) }
        #expect(held.max()! > held.min()!)  // still a lit pattern, not flat
        #expect(held.max()! > StreamDotGlyph.idleLevel)
    }

    @Test func rollupPrecedenceAndCounts() {
        let w = ChatMark(.waiting), k = ChatMark(.working), f = ChatMark(.failed)
        #expect(StatusRollup.of(marks: [nil, nil]).state == .idle)
        let r = StatusRollup.of(marks: [k, w, f, k])
        #expect(r == StatusRollup(state: .waiting, working: 2, needsYou: 1))
        #expect(StatusRollup.of(marks: [f, nil]).state == .failed)
        #expect(StatusRollup.of(marks: [nil, nil], ducklingsRunning: [0, 1]) == StatusRollup(state: .working, working: 1, needsYou: 0))
    }

    @Test func daemonActivityWords() {
        #expect(StatusRollup.of(activity: "needs_you", working: 1, needsYou: 2) == StatusRollup(state: .waiting, working: 1, needsYou: 2))
        #expect(StatusRollup.of(activity: "error", working: nil, needsYou: nil)?.state == .failed)
        #expect(StatusRollup.of(activity: "later-word", working: 1, needsYou: 0) == nil)
        #expect(StatusRollup.of(activity: nil, working: nil, needsYou: nil) == nil)
    }

    @Test func pondRowMarkAndLabel() {
        #expect(PondRowMark.of(StatusRollup(state: .idle), count: 3) == .count(3))
        #expect(PondRowMark.of(StatusRollup(state: .idle), count: nil) == nil)
        #expect(PondRowMark.of(StatusRollup(state: .working, working: 1), count: 3) == .working)
        #expect(PondRowMark.of(StatusRollup(state: .waiting, working: 1, needsYou: 2), count: 3) == .needsYou(2))
        #expect(PondRowMark.of(StatusRollup(state: .failed), count: 3) == .error)
        #expect(StatusRollup(state: .waiting, working: 1, needsYou: 1).label(for: "greenroom") == "greenroom, 1 working, 1 needs you")
        #expect(StatusRollup(state: .idle).label(for: "greenroom") == "greenroom")
    }
}
