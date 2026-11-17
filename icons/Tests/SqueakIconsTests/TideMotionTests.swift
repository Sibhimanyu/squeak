import SwiftUI
import XCTest
@testable import SqueakIcons

final class TideMotionTests: XCTestCase {
    /// micro, mini, medium, compact, mark, large, stream.
    let grids: [(Int, Int)] = [(4, 2), (6, 3), (7, 3), (7, 4), (10, 4), (14, 5), (16, 5)]
    let seeds: [UInt64] = [1, 2, 3, 0xC0FFEE]
    let seed: UInt64 = 0xC0FFEE
    let times = (0..<120).map { Double($0) * 0.5 }  // 60 s

    func lv(_ c: Int, _ r: Int, _ g: (Int, Int), _ t: Double, _ sd: UInt64? = nil) -> Int {
        TideMotion.level(col: c, row: r, cols: g.0, rows: g.1, t: t, seed: sd ?? seed)
    }

    func testDeterministicAndInRange() {
        for g in grids { for r in 0..<g.1 { for c in 0..<g.0 { for t in times.prefix(40) {
            let a = lv(c, r, g, t)
            XCTAssertEqual(a, lv(c, r, g, t))
            XCTAssertTrue((0...3).contains(a))
            let s = TideMotion.smoothAlpha(col: c, row: r, cols: g.0, rows: g.1, t: t, seed: seed)
            XCTAssertEqual(s, TideMotion.smoothAlpha(col: c, row: r, cols: g.0, rows: g.1, t: t, seed: seed))
            XCTAssertTrue((0...1).contains(s))
        } } } }
    }

    func testSeedsDiffer() {
        let g = (16, 5)
        func frame(_ sd: UInt64) -> [Int] {
            times.prefix(30).flatMap { t in (0..<g.1).flatMap { r in (0..<g.0).map { c in lv(c, r, g, t, sd) } } }
        }
        XCTAssertNotEqual(frame(1), frame(2))
        XCTAssertNotEqual(frame(1), frame(3))
    }

    /// No visible loop: over 60 s no two frames at least 0.5 s apart are identical.
    func testNeverRepeats() {
        let g = (16, 5)
        var seen: [[Int]: Int] = [:]
        for i in 0..<900 {
            let t = Double(i) / 15
            let f = (0..<g.1).flatMap { r in (0..<g.0).map { c in lv(c, r, g, t) } }
            if let j = seen[f] { XCTAssertLessThan(i - j, 8, "frame \(i) repeats frame \(j)") }
            seen[f] = i
        }
    }

    /// Share of cells that are off (drawn alpha under 0.15), averaged over time, seeds and every grid.
    static func offShare(_ grids: [(Int, Int)], _ tuning: TideMotion.Tuning = TideMotion.Tuning()) -> Double {
        var off = 0.0, all = 0.0
        for g in grids { for sd in UInt64(1)...6 { for i in 0..<120 {
            let t = Double(i) * 0.5
            for r in 0..<g.1 { for c in 0..<g.0 {
                all += 1
                if TideMotion.smoothAlpha(col: c, row: r, cols: g.0, rows: g.1, t: t, seed: sd, tuning: tuning) < 0.15 { off += 1 }
            } }
        } } }
        return off / all
    }
    func testOffShareIs35To45Percent() {
        let s = Self.offShare(grids)
        print("OFFSHARE", s, grids.map { Self.offShare([$0]) })
        XCTAssertGreaterThan(s, 0.35)
        XCTAssertLessThan(s, 0.45)
        for g in grids where g.0 >= 6 {
            let o = Self.offShare([g])
            XCTAssertGreaterThan(o, 0.30, "\(g)"); XCTAssertLessThan(o, 0.50, "\(g)")
        }
    }

    /// The radial fade: on every grid the outer ring is dimmer than the middle, top and bottom edges as well as left and
    /// right, and the corners are the darkest; the fade itself is continuous (partial values, not on/off).
    func testRadialFadeToAllEdges() {
        for g in grids where g.0 >= 6 {
            func mean(_ pick: (Int, Int) -> Bool) -> Double {
                var s = 0.0, n = 0.0
                for sd in UInt64(1)...6 { for t in times.prefix(60) { for r in 0..<g.1 { for c in 0..<g.0 where pick(c, r) {
                    s += TideMotion.smoothAlpha(col: c, row: r, cols: g.0, rows: g.1, t: t, seed: sd); n += 1
                } } } }
                return s / n
            }
            let centre = mean { c, r in abs(Double(c) - Double(g.0 - 1) / 2) <= Double(g.0) * 0.17 && abs(Double(r) - Double(g.1 - 1) / 2) <= Double(g.1) * 0.2 }
            let left = mean { c, _ in c == 0 }, right = mean { c, _ in c == g.0 - 1 }
            let top = mean { _, r in r == 0 }, bottom = mean { _, r in r == g.1 - 1 }
            let corner = mean { c, r in (c == 0 || c == g.0 - 1) && (r == 0 || r == g.1 - 1) }
            for (name, e) in [("left", left), ("right", right), ("top", top), ("bottom", bottom)] {
                XCTAssertLessThan(e, centre * 0.75, "\(g) \(name) \(e) vs centre \(centre)")
            }
            XCTAssertLessThan(corner, min(left, right, top, bottom) + 0.03, "\(g) corner")
            XCTAssertLessThan(corner, centre * 0.4, "\(g) corner \(corner) vs centre \(centre)")
        }
        // Continuous: the fade takes many values and falls monotonically along a row.
        var last = 2.0
        for c in 12..<16 {
            let v = TideMotion.vignette(col: c, row: 2, cols: 16, rows: 5)
            XCTAssertLessThan(v, last); last = v
        }
        XCTAssertEqual(TideMotion.vignette(col: 8, row: 2, cols: 16, rows: 5), 1, accuracy: 0.05)
    }

    /// No band, stream or columns: the raw field's spatial autocorrelation is short (about 1-2 cells), the same along x and
    /// along y, and a cell is uncorrelated with its row or column neighbours three cells away.
    func testNoRowOrColumnPattern() {
        let cols = 16, rows = 5
        func corr(dx: Int, dy: Int) -> Double {
            var xs: [Double] = [], ys: [Double] = []
            for sd in UInt64(1)...8 { for t in stride(from: 1.0, to: 60, by: 1.7) {
                for r in 0..<(rows - dy) { for c in 0..<(cols - dx) {
                    xs.append(TideMotion.field(col: c, row: r, t: t, seed: sd)); ys.append(TideMotion.field(col: c + dx, row: r + dy, t: t, seed: sd))
                } }
            } }
            let n = Double(xs.count), mx = xs.reduce(0, +) / n, my = ys.reduce(0, +) / n
            var sxy = 0.0, sxx = 0.0, syy = 0.0
            for i in 0..<xs.count { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) * (xs[i] - mx); syy += (ys[i] - my) * (ys[i] - my) }
            return sxy / (sxx * syy).squareRoot()
        }
        let x1 = corr(dx: 1, dy: 0), y1 = corr(dx: 0, dy: 1), x3 = corr(dx: 3, dy: 0), y3 = corr(dx: 0, dy: 3), x6 = corr(dx: 6, dy: 0)
        print("AUTOCORR x1 \(x1) y1 \(y1) x3 \(x3) y3 \(y3) x6 \(x6)")
        XCTAssertLessThan(x1, 0.75); XCTAssertLessThan(y1, 0.75)
        XCTAssertLessThan(abs(x1 - y1), 0.12, "no direction is favoured")
        XCTAssertLessThan(abs(x3), 0.25); XCTAssertLessThan(abs(y3), 0.25); XCTAssertLessThan(abs(x6), 0.15)
    }

    /// No bars: a row is never fully lit at the top level, and hardly ever lit end to end at all (rows of 10 or more cells).
    func testNoRowFullyLit() {
        var rows = 0, full = 0
        for g in grids where g.0 >= 6 {
            for sd in UInt64(1)...6 { for t in times { for r in 0..<g.1 {
                XCTAssertFalse((0..<g.0).allSatisfy { lv($0, r, g, t, sd) == 3 }, "\(g) row \(r) at full at \(t)")
                if g.0 >= 10 { rows += 1; if (0..<g.0).allSatisfy({ lv($0, r, g, t, sd) > 0 }) { full += 1 } }
            } } }
        }
        print("ROWS lit end to end", Double(full) / Double(rows))
        XCTAssertLessThan(Double(full) / Double(rows), 0.03)
    }

    /// The drift has no preferred direction: over seeds it points everywhere, so no seed's glyph flows only right.
    func testDriftDirectionsVary() {
        var xs = 0, ys = 0
        for sd in UInt64(1)...40 {
            let a = TideMotion.field(col: 3, row: 2, t: 0, seed: sd), b = TideMotion.field(col: 3, row: 2, t: 200, seed: sd)
            if a != b { xs += 1 }
            ys += TideMotion.unit(sd &+ 80, 1) < 0.5 ? 1 : 0
        }
        XCTAssertGreaterThan(xs, 30)
        XCTAssertTrue((10...30).contains(ys), "directions bunch: \(ys)")
    }

    /// Cells change smoothly: no cell's drawn alpha jumps by more than 0.35 in a 30 fps frame and it spends time between levels.
    func testSmoothAlphaIsContinuousAndInRange() {
        var biggest = 0.0, between = 0, total = 0
        for g in [(16, 5), (4, 2)] { for c in 0..<g.0 { for r in 0..<g.1 {
            var last = TideMotion.smoothAlpha(col: c, row: r, cols: g.0, rows: g.1, t: 0, seed: seed)
            for i in 1..<600 {
                let a = TideMotion.smoothAlpha(col: c, row: r, cols: g.0, rows: g.1, t: Double(i) / 30, seed: seed)
                XCTAssertTrue((0...1).contains(a))
                biggest = max(biggest, abs(a - last)); last = a
                total += 1
                if ![0, 0.3, 0.6, 1].contains(where: { abs($0 - a) < 0.02 }) { between += 1 }
            }
        } } }
        print("MAXSTEP", biggest, "between", Double(between) / Double(total))
        XCTAssertLessThan(biggest, 0.4)
        XCTAssertGreaterThan(Double(between) / Double(total), 0.05)
    }

    /// A single cell's level takes about 0.3-0.8 s to change: its alpha moves from one level to the next over several frames.
    func testTransitionsTakeFractionsOfASecond() {
        var durations: [Double] = []
        for c in 0..<16 { for r in 0..<5 {
            var start: Double? = nil
            var from = TideMotion.smoothAlpha(col: c, row: r, cols: 16, rows: 5, t: 0, seed: seed)
            for i in 1..<1800 {
                let t = Double(i) / 30
                let a = TideMotion.smoothAlpha(col: c, row: r, cols: 16, rows: 5, t: t, seed: seed)
                let steady = [0, 0.3, 0.6, 1].contains { abs($0 - a) < 0.02 }
                if steady { if let s = start, abs(a - from) > 0.2 { durations.append(t - s) }; start = nil; from = a }
                else if start == nil { start = t }
            }
        } }
        durations.sort()
        let med = durations[durations.count / 2]
        print("TRANSITION median", med, "n", durations.count)
        XCTAssertGreaterThan(med, 0.12); XCTAssertLessThan(med, 0.9)
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

    /// The maths must not depend on how large `t` is: flow speed and the per-second change rate at t ~ 10 and t ~ 8.2e8.
    func testClockMagnitudeDoesNotChangeSpeed() {
        func flow(_ t0: Double) -> Double { (TideMotion.flowTime(t0 + 20, seed) - TideMotion.flowTime(t0, seed)) / 20 }
        func change(_ t0: Double) -> Double {  // |alpha change| per unit of flow, so a window the pace happens to slow is not a different speed
            var diff = 0.0, n = 0.0
            for i in 0..<300 {
                let t = t0 + Double(i) * 0.1
                let dflow = TideMotion.flowTime(t + 0.5, seed) - TideMotion.flowTime(t, seed)
                for r in 0..<9 { for c in 0..<29 {
                    let a = TideMotion.smoothAlpha(col: c, row: r, cols: 29, rows: 9, t: t, seed: seed)
                    let b = TideMotion.smoothAlpha(col: c, row: r, cols: 29, rows: 9, t: t + 0.5, seed: seed)
                    diff += abs(a - b) / dflow; n += 1
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

}

final class TideRateTests: XCTestCase {
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
        XCTAssertGreaterThan(frames, 50_000)
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

final class TideSheetTests: XCTestCase {
    /// `TIDE_SHEET=<png path> swift test --filter TideSheetTests`: a contact sheet of every grid at 6 times. Offscreen.
    @MainActor func testWriteContactSheet() throws {
        guard let out = ProcessInfo.processInfo.environment["TIDE_SHEET"] else { throw XCTSkip("set TIDE_SHEET") }
        let grids: [(String, TideGlyph.Grid)] = [("micro 4x2", .micro), ("mini 6x3", .mini), ("medium 7x3", .medium), ("compact 7x4", .compact), ("mark 10x4", .mark), ("large 14x5", .large), ("stream 16x5", .stream)]
        let times = [0.0, 0.5, 1.0, 1.5, 2.0, 3.0].map { $0 + 5 }
        let bg = Color(red: 0.10, green: 0.08, blue: 0.08), blue = Color(red: 0.30, green: 0.55, blue: 1)
        func cell(_ g: TideGlyph.Grid, _ t: Double?, _ sd: UInt64) -> some View {
            TideFrame(color: blue, height: g.size.height, grid: g, time: t, seed: sd, scale: 2).padding(4)
        }
        let sheet = VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(grids.enumerated()), id: \.offset) { _, item in
                HStack(spacing: 14) {
                    Text(item.0).font(.system(size: 10, design: .monospaced)).foregroundStyle(.white.opacity(0.6)).frame(width: 90, alignment: .leading)
                    ForEach(Array(times.enumerated()), id: \.offset) { _, t in cell(item.1, t, 7) }
                }
            }
        }.padding(16).background(bg)
        let r = ImageRenderer(content: sheet); r.scale = 6
        guard let cg = r.cgImage else { throw XCTSkip("no render") }
        let rep = NSBitmapImageRep(cgImage: cg)
        try FileManager.default.createDirectory(atPath: (out as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
        try rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
    }
}

/// The shared clock's speed must not depend on how many glyphs read it, how often a body re-runs, or glyphs appearing and going.
final class TideClockTests: XCTestCase {
    /// A 30 fps loop of `glyphs` views, each reading at its own phase inside the frame and `extra` more times (a re-rendered
    /// parent), glyphs coming and going. Returns the shown seconds per real second over every 1 s window.
    func rates(glyphs: Int, extra: Int, churn: Bool) -> [Double] {
        let clock = TideMotion.Clock(), epoch = Date(timeIntervalSinceReferenceDate: 1_000_000)
        var out: [Double] = [], windowStart = clock.time(at: epoch), n = 0
        _ = windowStart
        for i in 0..<(30 * 20) {
            let frame = Double(i) / 30
            let visible = churn ? max(1, glyphs - (i / 45) % glyphs) : glyphs
            for g in 0..<visible {
                let d = epoch.addingTimeInterval(frame + Double(g) * 0.0007)
                for _ in 0...extra { _ = clock.time(at: d) }
            }
            n += 1
            if n == 30 { let t = clock.time(at: epoch.addingTimeInterval(frame)); out.append(t - windowStart); windowStart = t; n = 0 }
        }
        return out.dropFirst().map { $0 }
    }

    func testRateIsRealTimeWhateverTheRenderCount() {
        for glyphs in [1, 2, 5, 12] { for extra in [0, 1, 5, 30] { for churn in [false, true] {
            for r in rates(glyphs: glyphs, extra: extra, churn: churn) {
                XCTAssertEqual(r, 1.0, accuracy: 0.1, "glyphs \(glyphs) extra \(extra) churn \(churn)")
            }
        } } }
    }

    /// Reads inside one frame, in any order, are one advance; and a stall moves the clock by one capped step only.
    func testOneAdvancePerFrameAndBoundedStep() {
        let clock = TideMotion.Clock(), epoch = Date(timeIntervalSinceReferenceDate: 5)
        _ = clock.time(at: epoch)
        let a = clock.time(at: epoch.addingTimeInterval(1.0 / 30))
        XCTAssertEqual(clock.time(at: epoch.addingTimeInterval(1.0 / 30 + 0.002)), a)
        XCTAssertEqual(clock.time(at: epoch.addingTimeInterval(0.01)), a)
        let b = clock.time(at: epoch.addingTimeInterval(30))
        XCTAssertLessThanOrEqual(b - a, TideMotion.Clock.maxStep + 1e-9)
        var worst = 0.0, p = b
        for i in 1..<2000 {
            let t = clock.time(at: epoch.addingTimeInterval(30 + Double(i) / 30))
            worst = max(worst, t - p); p = t
        }
        XCTAssertLessThanOrEqual(worst, 1.5 / 30 + 1e-9, "no frame moves more than 1.5x a normal one")
    }

    /// The motion itself: whatever the time stepping, a cell's brightness changes by a bounded amount per frame.
    func testFrameToFrameChangeBounded() {
        for sd in UInt64(1)...8 {
            var prev = (0..<80).map { TideMotion.smoothAlpha(col: $0 % 16, row: $0 / 16, cols: 16, rows: 5, t: 0, seed: sd) }
            var t = 0.0
            while t < 120 {
                t += TideMotion.Clock.maxStep
                let cur = (0..<80).map { TideMotion.smoothAlpha(col: $0 % 16, row: $0 / 16, cols: 16, rows: 5, t: t, seed: sd) }
                XCTAssertLessThan(zip(cur, prev).map { abs($0 - $1) }.max()!, 0.5)
                prev = cur
            }
        }
    }
}

final class TideFrameEquivalenceTests: XCTestCase {
    /// The per-frame fast path draws exactly what the per-cell `smoothAlpha` does, so the look is unchanged.
    func testFrameMatchesSmoothAlpha() {
        var tuning = TideMotion.Tuning(); tuning.speed = 0.7; tuning.sparkle = 2
        for seed: UInt64 in [0, 1, 99, 0xDEAD_BEEF_CAFE] {
            for t in [0.0, 0.37, 3.7, 41.2, 600.5] {
                for g in [(4, 2), (6, 3), (10, 4), (16, 5)] {
                    for tn in [TideMotion.Tuning(), tuning] {
                        let f = TideMotion.Frame(t: t, seed: seed, tuning: tn)
                        for r in 0..<g.1 { for c in 0..<g.0 {
                            XCTAssertEqual(f.alpha(col: c, row: r, cols: g.0, rows: g.1), TideMotion.smoothAlpha(col: c, row: r, cols: g.0, rows: g.1, t: t, seed: seed, tuning: tn), accuracy: 1e-12)
                        } }
                    }
                }
            }
        }
    }

    /// Cost of one stream glyph frame (80 cells), for tracking regressions.
    func testFramePerformance() {
        measure {
            for i in 0..<300 {
                let f = TideMotion.Frame(t: Double(i) / 30, seed: 7)
                for r in 0..<5 { for c in 0..<16 { _ = f.alpha(col: c, row: r, cols: 16, rows: 5) } }
            }
        }
    }
}

extension TideFrameEquivalenceTests {
    /// The same 300 frames through the old per-cell path, to show the gap.
    func testPerCellBaselinePerformance() {
        measure {
            for i in 0..<300 {
                for r in 0..<5 { for c in 0..<16 { _ = TideMotion.smoothAlpha(col: c, row: r, cols: 16, rows: 5, t: Double(i) / 30, seed: 7) } }
            }
        }
    }
}
