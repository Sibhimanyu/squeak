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

    @Test func finishedChatWithRunningDucklingIsWorkingOnBothPaths() {
        let key = SessionKey(provider: "squeak", hostSessionId: "a")
        let chat = HostSession(key: key, state: .finished, ducklings: DucklingSet(running: 1))
        let fromChats = StreamGlyphState.of(chats: [chat], mark: { _ in nil })
        let row = PondChatRow(id: "a", title: "t", agent: nil, state: PondThreadState(chat.state), mark: nil, lastAt: nil,
                              local: key, pondThread: nil, ducklingsRunning: chat.ducklings?.running ?? 0, people: [])
        #expect(fromChats == .working)
        #expect(StreamGlyphState.of(rows: [row]) == fromChats)
        let idle = PondChatRow(id: "b", title: "t", agent: nil, state: .finished, mark: nil, lastAt: nil, local: key, pondThread: nil, people: [])
        #expect(StreamGlyphState.of(rows: [idle]) == .idle)
        // Another Mac's finished thread carries no count: it stays idle, nothing invented.
        let remote = PondChatRow(id: "thread:x", title: "t", agent: nil, state: .finished, mark: nil, lastAt: nil, local: nil, pondThread: "x", people: [])
        #expect(StreamGlyphState.of(rows: [remote]) == .idle)
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

@Suite struct StreamGlyphMotionTests {
    @Test func swellLinesAreOutOfStep() {
        let l = StreamGlyphMotion.swell(at: 0.7)
        #expect(l.count == 3)
        #expect(l[0].phase != l[1].phase && l[1].phase != l[2].phase && l[0].phase != l[2].phase)
        #expect(abs((l[0].phase - l[1].phase) - StreamGlyphMotion.lineLag) < 1e-9)
        #expect(abs((l[1].phase - l[2].phase) - StreamGlyphMotion.lineLag) < 1e-9)
    }

    @Test func swellAmplitudeVariesButStaysOnTheGrid() {
        var seen = Set<Double>()
        for i in 0..<120 {
            for (row, line) in StreamGlyphMotion.swell(at: Double(i) * 0.1).enumerated() {
                #expect(line.amplitude >= 0.75 - 1e-9 && line.amplitude <= 1.25 + 1e-9)
                seen.insert((line.amplitude * 100).rounded())
                #expect(StreamGlyphMotion.points(row: row, line: line).allSatisfy { $0.y > 3 && $0.y < 21 })
            }
        }
        #expect(seen.count > 10)
    }

    @Test func swellIsSmoothFrameToFrame() {
        // 30 fps: no line's point jumps more than a fraction of the amplitude between frames.
        for i in 0..<90 {
            let t = Double(i) / 30
            for row in 0..<3 {
                let a = StreamGlyphMotion.points(row: row, line: StreamGlyphMotion.swell(at: t)[row])
                let b = StreamGlyphMotion.points(row: row, line: StreamGlyphMotion.swell(at: t + 1.0 / 30)[row])
                #expect(zip(a, b).allSatisfy { abs($0.y - $1.y) < 0.6 })
            }
        }
    }

    @Test func swellLoopsOnItsCycle() {
        let a = StreamGlyphMotion.swell(at: 1.1), b = StreamGlyphMotion.swell(at: 1.1 + StreamGlyphMotion.swellSeconds * 10)
        for (x, y) in zip(a, b) {
            #expect(abs(sin(x.phase) - sin(y.phase)) < 1e-6 && abs(x.amplitude - y.amplitude) < 1e-6)
        }
    }

    @Test func rippleRestsBetweenPulses() {
        #expect(StreamGlyphMotion.ripple(at: 2.0) == StreamGlyphMotion.rest)
        #expect(StreamGlyphMotion.ripple(at: 2.99) == StreamGlyphMotion.rest)
        #expect(StreamGlyphMotion.dotScale(at: 2.0) == 1)
        #expect(StreamGlyphMotion.rippleEnvelope(at: 0) == 0)
        #expect(StreamGlyphMotion.rippleEnvelope(at: StreamGlyphMotion.rippleLength / 2) > 0.999)
    }

    @Test func ripplePushesOutwardMiddleFirst() {
        let early = StreamGlyphMotion.ripple(at: 0.2)
        #expect(early[1].amplitude > early[0].amplitude)  // the middle line leads
        let peak = StreamGlyphMotion.ripple(at: 0.65)
        #expect(peak[0].shift < 0 && peak[2].shift > 0 && peak[1].shift == 0)
        #expect(peak[1].amplitude > StreamGlyphGeometry.amplitude)
        #expect(StreamGlyphMotion.ripple(at: 0.65 + 3) == peak || abs(StreamGlyphMotion.ripple(at: 3.65)[0].shift - peak[0].shift) < 1e-9)
        #expect(StreamGlyphMotion.dotScale(at: 0.55) > 1.3)
    }

    @Test func stillUnderReduceMotionAndForOtherStates() {
        #expect(StreamGlyphMotion.lines(working: true, waiting: false, at: 1.234, animated: false) == StreamGlyphMotion.rest)
        #expect(StreamGlyphMotion.lines(working: false, waiting: true, at: 0.6, animated: false) == StreamGlyphMotion.rest)
        #expect(StreamGlyphMotion.lines(working: false, waiting: false, at: 0.6, animated: true) == StreamGlyphMotion.rest)
        #expect(StreamGlyphMotion.lines(working: true, waiting: false, at: 1.234, animated: true) != StreamGlyphMotion.rest)
        // rest is Lucide's waves
        for row in 0..<3 {
            #expect(StreamGlyphMotion.points(row: row, line: StreamGlyphMotion.rest[row]) == StreamGlyphGeometry.points(row: row, phase: 0))
        }
    }
}
