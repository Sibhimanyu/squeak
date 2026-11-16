import XCTest
@testable import SqueakIcons

final class TideMotionTests: XCTestCase {
    let grids: [(Int, Int)] = [(11, 4), (21, 6), (29, 9)]
    let times = (0..<150).map { Double($0) / 15 }
    let seed: UInt64 = 0xC0FFEE

    func lv(_ c: Int, _ r: Int, _ g: (Int, Int), _ t: Double) -> Int {
        TideMotion.level(col: c, row: r, cols: g.0, rows: g.1, t: t, seed: seed)
    }
    func seq(_ c: Int, _ r: Int, _ g: (Int, Int) = (21, 6)) -> [Int] { times.map { lv(c, r, g, $0) } }

    func testDeterministicAndInRange() {
        for g in grids { for r in 0..<g.1 { for c in 0..<g.0 { for t in times {
            let a = lv(c, r, g, t)
            XCTAssertEqual(a, lv(c, r, g, t))
            XCTAssertTrue((0...3).contains(a))
        } } } }
    }

    func testSeedsDiffer() {
        let g = (21, 6)
        func frame(_ sd: UInt64) -> [Int] {
            times.prefix(30).flatMap { t in (0..<g.1).flatMap { r in (0..<g.0).map { c in TideMotion.level(col: c, row: r, cols: g.0, rows: g.1, t: t, seed: sd) } } }
        }
        XCTAssertNotEqual(frame(1), frame(2))
        XCTAssertNotEqual(frame(1), frame(3))
    }

    /// No visible loop: over 60 s at 15 fps, no two frames at least 0.5 s apart are identical.
    func testNeverRepeats() {
        let g = (21, 6)
        var seen: [[Int]: Int] = [:]
        for i in 0..<900 {
            let t = Double(i) / 15
            let f = (0..<g.1).flatMap { r in (0..<g.0).map { c in TideMotion.level(col: c, row: r, cols: g.0, rows: g.1, t: t, seed: seed) } }
            if let j = seen[f] { XCTAssertLessThan(i - j, 8, "frame \(i) repeats frame \(j)") }
            seen[f] = i
        }
    }

    func testEndsDissolve() {
        for g in grids {
            func mean(_ cols: [Int]) -> Double {
                var s = 0.0
                for c in cols { for r in 0..<g.1 { for t in times { s += Double(lv(c, r, g, t)) } } }
                return s / Double(cols.count * g.1 * times.count)
            }
            let mid = mean([g.0 / 2])
            XCTAssertLessThan(mean([0]), mid * 0.4, "outer column \(g)")
            XCTAssertLessThan(mean([g.0 - 1]), mid * 0.4, "outer column \(g)")
            if g.0 >= 9 { XCTAssertLessThan(mean([1, g.0 - 2]), mid, "second column \(g)") }
        }
    }

    func testCentreRowBrighterThanOuterRows() {
        let g = (21, 6)
        let mid = (0..<21).reduce(0) { $0 + seq($1, 3).reduce(0, +) }
        let top = (0..<21).reduce(0) { $0 + seq($1, 0).reduce(0, +) }
        XCTAssertGreaterThan(mid, top)
    }

    /// Streaks, not round patches: lit pixels run longer horizontally than vertically.
    func testStreaksAreAnisotropic() {
        let g = (29, 9)
        var hRuns = 0.0, hCount = 0.0, vRuns = 0.0, vCount = 0.0
        for t in stride(from: 0.0, to: 20.0, by: 0.4) {
            let f = (0..<g.1).map { r in (0..<g.0).map { c in lv(c, r, g, t) >= 2 } }
            for r in 0..<g.1 { var run = 0
                for c in 0...g.0 { if c < g.0, f[r][c] { run += 1 } else if run > 0 { hRuns += Double(run); hCount += 1; run = 0 } } }
            for c in 0..<g.0 { var run = 0
                for r in 0...g.1 { if r < g.1, f[r][c] { run += 1 } else if run > 0 { vRuns += Double(run); vCount += 1; run = 0 } } }
        }
        XCTAssertGreaterThan(hRuns / hCount, 1.4 * vRuns / vCount)
    }

    func testNeighboursNeverSync() {
        let g = (21, 6)
        for r in 0..<g.1 { for c in 1..<(g.0 - 2) {  // the outermost columns are meant to be dark
            if seq(c, r).contains(where: { $0 > 0 }) { XCTAssertNotEqual(seq(c, r), seq(c + 1, r), "\(c),\(r) right") }
        } }
        for r in 0..<(g.1 - 1) { for c in 1..<(g.0 - 1) {
            if seq(c, r).contains(where: { $0 > 0 }) { XCTAssertNotEqual(seq(c, r), seq(c, r + 1), "\(c),\(r) down") }
        } }
    }

    func testNoStripes() {
        let g = (21, 6)
        for r in 0..<g.1 {
            let cols = (1..<(g.0 - 1)).map { seq($0, r) }
            let flat = (0..<times.count).filter { f in Set(cols.map { $0[f] }).count == 1 && cols[0][f] > 0 }.count
            XCTAssertLessThanOrEqual(Double(flat) / Double(times.count), 0.30, "row \(r)")
        }
    }

    /// The bright patches travel to the right: the column profile at t+dt matches the one at t shifted right.
    func testFlowsRight() {
        let g = (29, 9)
        func profile(_ t: Double) -> [Double] {
            let p = (0..<g.0).map { c in (0..<g.1).reduce(0.0) { $0 + Double(lv(c, $1, g, t)) } }
            let m = p.reduce(0, +) / Double(p.count)
            return p.map { $0 - m }
        }
        var num = 0.0, den = 0.0
        for i in 0..<100 {
            let t = Double(i) * 0.1, a = profile(t), b = profile(t + 0.1)
            for s in -3...3 {
                var corr = 0.0
                for c in 3..<(g.0 - 3) { corr += a[c] * b[c + s] }
                num += Double(s) * corr; den += corr
            }
        }
        XCTAssertGreaterThan(num / den, 0.1)
    }

    func testRimMoves() {
        let g = (21, 6)
        let sets = Set(times.map { t in (0..<g.0).flatMap { c in [0, 5].map { lv(c, $0, g, t) > 0 } } })
        XCTAssertGreaterThan(sets.count, 10)
    }

    func testStillFrameIsBalanced() {
        for g in grids {
            var l = 0.0, r = 0.0
            for row in 0..<g.1 { for col in 0..<g.0 {
                let v = Double(TideMotion.stillLevel(col: col, row: row, cols: g.0, rows: g.1, seed: seed))
                if col < g.0 / 2 { l += v } else if col > g.0 / 2 { r += v }
            } }
            XCTAssertGreaterThan(l + r, 0)
            XCTAssertEqual(l, r, "\(g)")
        }
    }

    /// The vignette: every edge column is dimmer than the centre columns, the ends fade to near nothing, and it is symmetric.
    func testVignetteFadesEdges() {
        for g in grids {
            for row in 0..<g.1 {
                let centre = TideMotion.vignette(col: g.0 / 2, row: row, cols: g.0, rows: g.1)
                for col in [0, g.0 - 1] {
                    let edge = TideMotion.vignette(col: col, row: row, cols: g.0, rows: g.1)
                    XCTAssertLessThan(edge, centre * 0.15, "\(g) col \(col) row \(row)")
                }
                XCTAssertEqual(TideMotion.vignette(col: 2, row: row, cols: g.0, rows: g.1),
                               TideMotion.vignette(col: g.0 - 3, row: row, cols: g.0, rows: g.1), accuracy: 1e-9)
            }
            for c in 0..<g.0 { for r in 0..<g.1 {
                let v = TideMotion.vignette(col: c, row: r, cols: g.0, rows: g.1)
                XCTAssertTrue((0...1).contains(v))
            } }
        }
    }

    /// The pace wanders: always inside 0.5x...1.3x of the base, and the measured flow speed in two 3 s windows differs by
    /// at least 30% for some seed. The clock never goes backwards or jumps.
    func testPaceWandersAndClockIsContinuous() {
        var found = false
        for sd in UInt64(1)...8 {
            var speeds: [Double] = []
            for k in 0..<20 {
                let t = Double(k) * 3
                speeds.append((TideMotion.flowTime(t + 3, sd) - TideMotion.flowTime(t, sd)) / 3)
            }
            if speeds.max()! / speeds.min()! >= 1.3 { found = true }
            for t in stride(from: 0.0, to: 90, by: 0.5) {
                let p = TideMotion.pace(t, sd)
                XCTAssertTrue((0.49...1.31).contains(p), "pace \(p)")
            }
            var last = TideMotion.flowTime(0, sd)
            for i in 1..<1350 {
                let now = TideMotion.flowTime(Double(i) / 15, sd)
                XCTAssertGreaterThan(now, last)
                XCTAssertLessThan(now - last, 0.55 * 1.3 / 15 + 1e-9)
                last = now
            }
        }
        XCTAssertTrue(found)
    }

    /// The texture's character drifts over tens of seconds, calm to choppy, and stays in range.
    func testChoppinessDrifts() {
        let v = stride(from: 0.0, to: 120, by: 1).map { TideMotion.choppiness($0, seed) }
        XCTAssertTrue(v.allSatisfy { (0...1).contains($0) })
        XCTAssertGreaterThan(v.max()! - v.min()!, 0.4)
        for i in 1..<v.count { XCTAssertLessThan(abs(v[i] - v[i - 1]), 0.25) }
    }
}
