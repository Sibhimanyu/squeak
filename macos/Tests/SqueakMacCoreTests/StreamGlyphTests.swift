import Foundation
import Testing

@testable import SqueakMacCore

@Suite struct StreamGlyphTests {
    @Test func stateDerivation() {
        let w = ChatMark(.waiting), k = ChatMark(.working), f = ChatMark(.failed), u = ChatMark(.unread)
        #expect(StreamGlyphState.of(marks: []) == .idle)
        #expect(StreamGlyphState.of(marks: [nil, nil]) == .idle)
        #expect(StreamGlyphState.of(marks: [k, w]) == .waiting)
        #expect(StreamGlyphState.of(marks: [f, k]) == .working)
        #expect(StreamGlyphState.of(marks: [nil], ducklingsRunning: 2) == .working)
        #expect(StreamGlyphState.of(marks: [w], ducklingsRunning: 2) == .waiting)
        #expect(StreamGlyphState.of(marks: [u, f]) == .failed)
        #expect(StreamGlyphState.of(marks: [nil, u]) == .unread)
    }

    @Test func accessibilityWords() {
        #expect(StreamGlyphState.working.label(for: "Hong Kong") == "Hong Kong, working")
        #expect(StreamGlyphState.idle.label(for: "Hong Kong") == "Hong Kong")
        #expect(StreamGlyphState.waiting.label(for: "A") == "A, waiting on you")
    }

    @Test func geometryAtPhaseZeroIsLucideWaves() {
        for row in 0..<3 {
            let p = StreamGlyphGeometry.points(row: row, phase: 0)
            let base = StreamGlyphGeometry.rows[row]
            #expect(p.first == CGPoint(x: 2, y: base))
            #expect(p.last!.x == 22)
            #expect(abs(StreamGlyphGeometry.y(row: row, x: 4.5, phase: 0) - (base + 1)) < 1e-9)
            #expect(abs(StreamGlyphGeometry.y(row: row, x: 9.5, phase: 0) - (base - 1)) < 1e-9)
            #expect(p.allSatisfy { abs($0.y - base) <= 1 + 1e-9 })
        }
    }

    @Test func geometryAtPiFlipsAndLoops() {
        let base = StreamGlyphGeometry.rows[0]
        #expect(abs(StreamGlyphGeometry.y(row: 0, x: 4.5, phase: .pi) - (base - 1)) < 1e-9)
        let a = StreamGlyphGeometry.points(row: 0, phase: 0), b = StreamGlyphGeometry.points(row: 0, phase: 2 * .pi)
        #expect(zip(a, b).allSatisfy { abs($0.y - $1.y) < 1e-9 })
        #expect(StreamGlyphGeometry.points(row: 1, phase: 1.3).count == 41)
    }

    @Test func clockIsALinearTwoSecondLoop() {
        #expect(StreamGlyphGeometry.phase(at: 0) == 0)
        #expect(abs(StreamGlyphGeometry.phase(at: 1) + .pi) < 1e-9)
        #expect(abs(StreamGlyphGeometry.phase(at: 4) - StreamGlyphGeometry.phase(at: 0)) < 1e-9)
    }
}
