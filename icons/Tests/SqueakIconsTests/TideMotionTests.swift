import SwiftUI
import XCTest
@testable import SqueakIcons

final class TideMotionTests: XCTestCase {
    let grids: [(Int, Int)] = [(6, 3), (10, 4), (16, 5)]
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
            let fast = TideMotion.Tuning(speed: 1, paceDrift: 1, choppinessLow: 0, choppinessHigh: 1)  // the original flow, so one step shifts visibly
            let p = (0..<g.0).map { c in (0..<g.1).reduce(0.0) { $0 + Double(TideMotion.level(col: c, row: $1, cols: g.0, rows: g.1, t: t, seed: seed, tuning: fast)) } }
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
        let sets = Set(stride(from: 0.0, to: 40, by: 0.1).map { t in (0..<g.0).flatMap { c in [0, 5].map { lv(c, $0, g, t) > 0 } } })
        XCTAssertGreaterThan(sets.count, 10)
    }

    func testStillFrameIsBalanced() {
        for g in grids {
            var l = 0.0, r = 0.0
            for row in 0..<g.1 { for col in 0..<g.0 {
                let v = Double(TideMotion.stillLevel(col: col, row: row, cols: g.0, rows: g.1, seed: seed))
                if col < g.0 / 2 { l += v } else if col >= (g.0 + 1) / 2 { r += v }
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
        XCTAssertGreaterThan(v.max()! - v.min()!, 0.25)
        for i in 1..<v.count { XCTAssertLessThan(abs(v[i] - v[i - 1]), 0.25) }
    }

    /// The maths must not depend on how large `t` is: flow speed and the per-second change rate at t ~ 10 and t ~ 8.2e8.
    func testClockMagnitudeDoesNotChangeSpeed() {
        func flow(_ t0: Double) -> Double { (TideMotion.flowTime(t0 + 20, seed) - TideMotion.flowTime(t0, seed)) / 20 }
        func change(_ t0: Double) -> Double {
            var diff = 0.0, n = 0.0
            for i in 0..<300 {
                let t = t0 + Double(i) * 0.1
                for r in 0..<9 { for c in 0..<29 {
                    let a = TideMotion.smoothAlpha(col: c, row: r, cols: 29, rows: 9, t: t, seed: seed)
                    let b = TideMotion.smoothAlpha(col: c, row: r, cols: 29, rows: 9, t: t + 0.5, seed: seed)
                    diff += abs(a - b); n += 1
                } }
            }
            return diff / n
        }
        // Compare against windows whose pace phase is equal: use a long window so the average pace is comparable.
        let small = flow(10), big = flow(8.2e8)
        XCTAssertEqual(big / small, 1, accuracy: 0.15, "flow \(small) vs \(big)")
        let cs = change(10), cb = change(8.2e8)
        XCTAssertEqual(cb / cs, 1, accuracy: 0.15, "change \(cs) vs \(cb)")
    }

    func testSmoothAlphaIsContinuousAndInRange() {
        var tune = TideMotion.Tuning()
        tune.smoothness = 0.3
        for c in 0..<21 { for r in 0..<6 {
            var last = TideMotion.smoothAlpha(col: c, row: r, cols: 21, rows: 6, t: 0, seed: seed, tuning: tune)
            for i in 1..<300 {
                let a = TideMotion.smoothAlpha(col: c, row: r, cols: 21, rows: 6, t: Double(i) / 30, seed: seed, tuning: tune)
                XCTAssertTrue((0...1).contains(a))
                XCTAssertLessThan(abs(a - last), 0.6)
                last = a
            }
        } }
    }

    /// The rendered mask: with the vignette on, the outermost columns of a drawn glyph have lower average alpha than
    /// the centre; with it off they do not (and the edge squares carry partial alpha inside one square).
    @MainActor func testRenderedMaskFadesEdges() throws {
        func columns(fade: Bool) throws -> [Double] {
            let w = 200, h = 60
            var sum = [Double](repeating: 0, count: w)
            for t in stride(from: 1.0, to: 9.0, by: 2.0) {
                let r = ImageRenderer(content: TideFrame(color: .white, height: 60, grid: .init(cols: 21, rows: 6, gap: 0), time: t, seed: seed, fade: fade)
                    .frame(width: 200, height: 60).background(Color.black))
                r.scale = 1
                guard let cg = r.cgImage, let data = cg.dataProvider?.data, let p = CFDataGetBytePtr(data) else { throw XCTSkip("no render") }
                let bpp = cg.bitsPerPixel / 8
                for y in 0..<min(h, cg.height) { for x in 0..<min(w, cg.width) { sum[x] += Double(p[y * cg.bytesPerRow + x * bpp]) } }
            }
            return sum
        }
        let on = try columns(fade: true), off = try columns(fade: false)
        func avg(_ a: [Double], _ r: Range<Int>) -> Double { a[r].reduce(0, +) / Double(r.count) }
        XCTAssertLessThan(avg(on, 0..<10), avg(on, 90..<110) * 0.3)
        XCTAssertLessThan(avg(on, 190..<200), avg(on, 90..<110) * 0.3)
        XCTAssertGreaterThan(avg(off, 15..<35), 0)
        XCTAssertLessThan(avg(on, 15..<35), avg(off, 15..<35))
    }
}

final class TideOffShareTests: XCTestCase {
    /// Share of in-band pixels drawn off (alpha under 0.15, the lowest level is 0.38), averaged over 10 s at 15 fps on the mark and large grids and several seeds.
    static func offShare(_ tuning: TideMotion.Tuning = TideMotion.Tuning()) -> Double {
        var off = 0.0, band = 0.0
        for g in [(10, 4), (16, 5)] { for sd in UInt64(1)...4 { for i in 0..<150 {
            let t = Double(i) / 15
            for r in 0..<g.1 { for c in 0..<g.0 where TideMotion.inBand(col: c, row: r, cols: g.0, rows: g.1, t: t, seed: sd, tuning: tuning) {
                band += 1
                if TideMotion.smoothAlpha(col: c, row: r, cols: g.0, rows: g.1, t: t, seed: sd, tuning: tuning) < 0.15 { off += 1 }  // what is drawn: dimmer than the lowest level
            } }
        } } }
        return off / band
    }
    func testOffShareInRange() {
        let s = Self.offShare()
        print("OFFSHARE", s)
        XCTAssertGreaterThan(s, 0.30)
        XCTAssertLessThan(s, 0.40)
    }

    /// The speed never goes haywire: over hours of simulated time with random stalls (pauses, sleep, background), clock
    /// resets of the view (a fresh seed) and several instances reading one clock, the flow's rate stays within 0.5x-1.5x
    /// of nominal in every frame and the clock never moves faster than real time.
    func testFlowRateStaysBoundedOverHoursWithPausesAndRecreation() {
        let tuning = TideMotion.Tuning()
        let nominal = TideMotion.baseRate * tuning.speed
        let clock = TideMotion.Clock()
        var rng = SystemRandomNumberGenerator()
        var wall = Date(timeIntervalSinceReferenceDate: 7e8)
        var prevTime = clock.time(at: wall)
        var seed: UInt64 = 0xC0FFEE
        var prevFlow = TideMotion.flowTime(prevTime, seed, tuning)
        var elapsed = 0.0
        var frames = 0
        while elapsed < 6 * 3600 {
            var step = 1.0 / 30
            let r = Double.random(in: 0..<1, using: &rng)
            if r < 0.0005 { step = Double.random(in: 1...600, using: &rng) }  // pause, sleep or a long stall
            else if r < 0.02 { step = Double.random(in: 0.05...0.5, using: &rng) }  // a busy frame
            wall = wall.addingTimeInterval(step); elapsed += step
            let t = clock.time(at: wall)
            XCTAssertGreaterThanOrEqual(t, prevTime)
            let dt = t - prevTime
            XCTAssertLessThanOrEqual(dt, min(step, TideMotion.Clock.maxStep) + 1e-6)
            // Several instances reading the same moment see the same time.
            XCTAssertEqual(clock.time(at: wall), t)
            if Double.random(in: 0..<1, using: &rng) < 0.01 { seed = UInt64.random(in: .min ... .max, using: &rng); prevFlow = TideMotion.flowTime(t, seed, tuning); prevTime = t; continue }
            let flow = TideMotion.flowTime(t, seed, tuning)
            if dt > 1e-6 {
                let rate = (flow - prevFlow) / dt / nominal
                XCTAssertGreaterThan(rate, 0.5, "frame \(frames)")
                XCTAssertLessThan(rate, 1.5, "frame \(frames)")
            }
            prevFlow = flow; prevTime = t; frames += 1
        }
        XCTAssertGreaterThan(frames, 100_000)
    }

    /// The analytic rate over a long run, for several seeds and the widest drift the tuning panel allows.
    func testPaceBoundsForEverySeed() {
        for sd in UInt64(1)...20 {
            let tuning = TideMotion.Tuning(speed: 0.5, paceDrift: 1)
            for i in 0..<20_000 {
                let t = Double(i) * 0.5 + 3e5
                let rate = (TideMotion.flowTime(t + 0.01, sd, tuning) - TideMotion.flowTime(t, sd, tuning)) / 0.01 / (TideMotion.baseRate * tuning.speed)
                XCTAssertTrue((0.5...1.5).contains(rate), "seed \(sd) t \(t) rate \(rate)")
            }
        }
    }
}
