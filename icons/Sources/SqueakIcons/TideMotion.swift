import Foundation

/// The pure maths of `TideGlyph`: a pure function of (cell, time, seed). The glyph is meant to look random, like a small
/// block of data-glyph activity, never a stream or a band. Each cell's brightness is smooth 3-D noise over (x, y, time) with
/// a spatial correlation of only 1-2 cells (two layers at different scales), carried along a slow drift in a seeded
/// direction that itself turns, with rare sparkle cells that rise and fall. A radial fade from the glyph's centre
/// multiplies every cell toward all four edges (corners darkest), so every grid reads as a soft cloud of pixels. The
/// result is quantised to four levels (off, 30%, 60%, 100%) and the steps are softened so a cell changes over about
/// half a second. The pace wanders (a slowly varying rate, never surging) and the seed feeds every hash, so two
/// glyphs never match.
public enum TideMotion {
    /// Live-tunable parameters; the defaults are the shipped look.
    public struct Tuning: Sendable, Equatable {
        /// Overall speed multiplier (drift, twinkle and sparkle).
        public var speed: Double = 0.65
        /// How far the pace wanders (1 = shipped 0.5x...1.3x; 0 = constant pace).
        public var paceDrift: Double = 0.5
        /// Unused since the random-glyph redesign; kept so tuning sources and the preview tools still compile.
        public var choppinessLow: Double = 0.15
        public var choppinessHigh: Double = 0.8
        /// Multiplies every sparkle chance.
        public var sparkle: Double = 1
        /// Radial fade strength: 0 = none, 1 = shipped (corners fade out completely).
        public var vignette: Double = 1
        /// Softness of the steps between levels, as a time scale in seconds (0 = pixels snap between the four levels).
        public var smoothness: Double = 0.8
        /// Timeline rate: 15, 30 or 60.
        public var frameRate: Int = 30 // kept for API compatibility; never throttles the glyph
        public init() {}
        public init(speed: Double = 0.65, paceDrift: Double = 0.5, choppinessLow: Double = 0.15, choppinessHigh: Double = 0.8, sparkle: Double = 1, vignette: Double = 1, smoothness: Double = 0.8, frameRate: Int = 30) {
            self.smoothness = smoothness; self.frameRate = frameRate
            self.speed = speed; self.paceDrift = paceDrift; self.choppinessLow = choppinessLow; self.choppinessHigh = choppinessHigh
            self.sparkle = sparkle; self.vignette = vignette
        }
        /// The tuning as Swift source.
        public var swiftSource: String {
            "TideMotion.Tuning(speed: \(f(speed)), paceDrift: \(f(paceDrift)), choppinessLow: \(f(choppinessLow)), choppinessHigh: \(f(choppinessHigh)), sparkle: \(f(sparkle)), vignette: \(f(vignette)), smoothness: \(f(smoothness)), frameRate: \(frameRate))"
        }
        private func f(_ v: Double) -> String { String(format: "%.3g", v) }
    }

    /// The clock every view reads: seconds of *shown* motion, shared by all glyphs and a pure function of the frames it has seen,
    /// never of how many views read it or how often. A read advances it by the wall time since the last advance, but by at most
    /// `maxStep` (about 1.2 frames at 15 fps), so a stall (a busy main thread, a paused or occluded view, sleep, a clock
    /// change) resumes where the water left off and no single frame ever moves more than 1.2x a normal one. Reads within
    /// `frameSlop` of the last advance (the other glyphs of the same frame, a body that runs again) return the same time and
    /// never advance it; a read from the past never moves it back. Combined with the bounded pace below, the flow's rate stays
    /// within 0.7x-1.1x of nominal.
    public final class Clock: @unchecked Sendable {
        public static let maxStep = 0.08
        public static let frameSlop = 0.004
        private let lock = NSLock()
        private var last: Date?
        private var t = 0.0
        public init() {}
        public func time(at date: Date) -> Double {
            lock.lock(); defer { lock.unlock() }
            guard let l = last else { last = date; return t }
            let dt = date.timeIntervalSince(l)
            if dt > Clock.frameSlop { t += min(dt, Clock.maxStep); last = date }
            return t
        }
    }
    public static let sharedClock = Clock()
    public static func clock(_ date: Date) -> Double { sharedClock.time(at: date) }

    @inline(__always) static func wrap(_ x: Double) -> Double { x.truncatingRemainder(dividingBy: 2 * .pi) }

    /// The radial fade, 0...1, by which a cell's brightness is multiplied: full in the middle, fading continuously toward
    /// all four edges (an ellipse matched to the glyph's own aspect, so top and bottom fade as much as left and right and the
    /// corners are darkest). Works on any grid from 4x2 up.
    public static func vignette(col: Int, row: Int, cols: Int, rows: Int, tuning: Tuning = Tuning()) -> Double {
        let nx = (Double(col) - Double(cols - 1) / 2) / (Double(cols) / 2)
        let ny = (Double(row) - Double(rows - 1) / 2) / (Double(rows) / 2)
        return vignetteCurve(r: (nx * nx + ny * ny).squareRoot(), tuning: tuning)
    }

    /// The fade at radius `r` (0 the centre, 1 the middle of an edge, about 1.25 a corner).
    public static func vignetteCurve(r: Double, tuning: Tuning = Tuning()) -> Double {
        let x = max(0, min(1, (r - 0.2) / 0.8))
        return max(0, min(1, 1 - tuning.vignette * x * x * (3 - 2 * x)))
    }

    /// The time a preview-tool still frame samples (the shipped glyph is never drawn still).
    public static let stillTime = 3.7

    // MARK: noise

    @inline(__always) static func mix(_ z0: UInt64) -> UInt64 {
        var z = z0 &+ 0x9E37_79B9_7F4A_7C15
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
    /// A uniform value in 0..<1 from any number of integer keys.
    static func unit(_ seed: UInt64, _ a: Int, _ b: Int = 0, _ c: Int = 0) -> Double {
        var h = mix(seed)
        h = mix(h ^ UInt64(bitPattern: Int64(a)))
        h = mix(h ^ UInt64(bitPattern: Int64(b)) &* 0xD6E8_FEB8_6659_FD93)
        h = mix(h ^ UInt64(bitPattern: Int64(c)) &* 0xA076_1D64_78BD_642F)
        return Double(h >> 11) / Double(1 << 53)
    }
    /// Smooth 3-D value noise, roughly -1...1 (hashed lattice, smoothstep blend).
    static func noise(_ x: Double, _ y: Double, _ z: Double, _ seed: UInt64) -> Double {
        let fx = x.rounded(.down), fy = y.rounded(.down), fz = z.rounded(.down)
        let ix = Int(fx), iy = Int(fy), iz = Int(fz)
        func s(_ t: Double) -> Double { t * t * (3 - 2 * t) }
        let tx = s(x - fx), ty = s(y - fy), tz = s(z - fz)
        func v(_ dx: Int, _ dy: Int, _ dz: Int) -> Double { unit(seed, ix + dx, iy + dy, iz + dz) * 2 - 1 }
        func lerp(_ a: Double, _ b: Double, _ t: Double) -> Double { a + (b - a) * t }
        let x00 = lerp(v(0, 0, 0), v(1, 0, 0), tx), x10 = lerp(v(0, 1, 0), v(1, 1, 0), tx)
        let x01 = lerp(v(0, 0, 1), v(1, 0, 1), tx), x11 = lerp(v(0, 1, 1), v(1, 1, 1), tx)
        return lerp(lerp(x00, x10, ty), lerp(x01, x11, ty), tz)
    }

    // MARK: pace

    /// The pace's nominal rate (the shipped slow pace); with `Tuning.speed` it is what the never-surge bound is measured against.
    static let baseRate = 0.55

    /// The wandering pace, 0.5...1.3 (a sum of three sines with seeded periods of about 11-19, 7-11 and 23-31 s).
    static func pace(_ t: Double, _ seed: UInt64, _ tuning: Tuning = Tuning()) -> Double {
        let w = paceWaves(seed)
        func sn(_ x: (w: Double, p: Double)) -> Double { sin(wrap(x.w * t) + x.p) }
        return 0.9 + 0.4 * tuning.paceDrift * (0.5 * sn(w.0) + 0.3 * sn(w.1) + 0.2 * sn(w.2))
    }
    private static func paceWaves(_ seed: UInt64) -> ((w: Double, p: Double), (w: Double, p: Double), (w: Double, p: Double)) {
        func wave(_ k: UInt64, _ lo: Double, _ hi: Double) -> (w: Double, p: Double) {
            (2 * .pi / (lo + (hi - lo) * unit(seed &+ k, 1)), 2 * .pi * unit(seed &+ k, 2))
        }
        return (wave(70, 11, 19), wave(71, 7, 11), wave(72, 23, 31))
    }

    /// The motion's clock: the integral of `baseRate * speed * pace`, so it never jumps. Drift, twinkle and sparkle all run on it.
    static func flowTime(_ t: Double, _ seed: UInt64, _ tuning: Tuning = Tuning()) -> Double {
        let w = paceWaves(seed)
        func part(_ x: (w: Double, p: Double), _ amp: Double) -> Double { -amp * (cos(wrap(x.w * t) + x.p) - cos(x.p)) / x.w }
        return baseRate * tuning.speed * (0.9 * t + 0.4 * tuning.paceDrift * (part(w.0, 0.5) + part(w.1, 0.3) + part(w.2, 0.2)))
    }

    // MARK: the field

    /// Lattice cells per cell of the glyph for the two noise layers (1/scale): a feature is about 1-2 cells across.
    fileprivate static let freqA = 1 / 1.7, freqB = 1 / 1.05

    /// 0...1 raw brightness of a cell before the fade: two layers of smooth noise (about 1.7 and 1 cell across) over (x, y, time),
    /// both carried along a slow drift in a seeded direction that keeps turning, plus sparkle cells.
    static func field(col: Int, row: Int, t: Double, seed: UInt64, tuning: Tuning = Tuning()) -> Double {
        // Shown seconds at nominal speed (speed 0.5 and pace 0.9 give u close to t).
        let u = flowTime(t, seed, tuning) / (baseRate * 0.5)
        // Drift: a steady slow travel in a seeded direction plus two bounded slow swirls across it, so the heading keeps turning
        // (the speed stays between about 0.1 and 0.7 cells/s) and no direction is favoured. Bounded terms only: the position
        // must never move faster than the clock, however large `t` is.
        let theta = 2 * .pi * unit(seed &+ 80, 1), c = cos(theta), s = sin(theta)
        let sw1 = 3.0 * sin(wrap(u * 2 * .pi / 53) + 6.28 * unit(seed &+ 80, 2)), sw2 = 2.0 * sin(wrap(u * 2 * .pi / 37) + 6.28 * unit(seed &+ 80, 3))
        let along = 0.3 * u + sw2, across = sw1
        let x = Double(col) + along * c - across * s, y = Double(row) + along * s + across * c
        let n = 0.6 * noise(x * freqA, y * freqA, u * 0.38, seed &+ 81) + 0.4 * noise(x * freqB + 9.1, y * freqB + 4.7, u * 0.62 + 3, seed &+ 82)
        let f = max(0, min(1, 0.5 + 1.45 * n))
        return f
    }

    /// Sparkle, 0...~0.6: now and then a cell flares to full and fades (a smooth bump over its own 1-2 s slot).
    static func sparkle(col: Int, row: Int, t: Double, seed: UInt64, tuning: Tuning = Tuning()) -> Double {
        let u = flowTime(t, seed, tuning) / (baseRate * 0.5)
        let a = col &+ row &* 977
        let len = 1.0 + 1.4 * unit(seed &+ 90, a)
        let pos = u / len + unit(seed &+ 91, a) * 60
        let slot = Int(pos.rounded(.down)), frac = pos - Double(slot)
        guard unit(seed &+ 92, a, slot) < 0.035 * tuning.sparkle else { return 0 }
        let b = sin(.pi * frac)
        return 0.6 * b * b
    }

    /// 0...~1.2 brightness at a cell: the field and sparkle times the radial fade.
    static func value(col: Int, row: Int, cols: Int, rows: Int, t: Double, seed: UInt64, tuning: Tuning = Tuning()) -> Double {
        let g = vignette(col: col, row: row, cols: cols, rows: rows, tuning: tuning)
        // The rim keeps a quarter of the brightness, so a dim cell can still sit out there: the glyph thins out, it does not end.
        let gain = 1 - 0.8 * (1 - g) * min(1, tuning.vignette)
        guard gain > 0 else { return 0 }
        let f = field(col: col, row: row, t: t, seed: seed, tuning: tuning)
        return (f + sparkle(col: col, row: row, t: t, seed: seed, tuning: tuning)) * gain
    }

    /// Brightness levels 0...3: off, dim, mid, full.
    public static func alpha(_ level: Int) -> Double {
        switch level {
        case ..<1: return 0
        case 1: return 0.3
        case 2: return 0.6
        default: return 1
        }
    }

    /// Level edges on `value`: below the first a cell is off. Set so about 40% of cells are off at any moment.
    static let edges = [0.125, 0.23, 0.40]

    static func quantise(_ v: Double, _ e: [Double] = edges) -> Int { v < e[0] ? 0 : v < e[1] ? 1 : v < e[2] ? 2 : 3 }

    public static func level(col: Int, row: Int, cols: Int, rows: Int, t: Double, seed: UInt64 = 0, tuning: Tuning = Tuning()) -> Int {
        quantise(value(col: col, row: row, cols: cols, rows: rows, t: t, seed: seed, tuning: tuning))
    }

    /// The staircase of `alpha` with each step softened over `width` (in brightness), so a cell changes level as a short ramp.
    static func softAlpha(_ v: Double, width: Double, _ e: [Double] = edges) -> Double {
        guard width > 0.001 else { return alpha(quantise(v, e)) }
        func step(_ edge: Double) -> Double {
            let x = max(0, min(1, (v - edge) / width + 0.5))
            return x * x * (3 - 2 * x)
        }
        return alpha(1) * step(e[0]) + (alpha(2) - alpha(1)) * step(e[1]) + (alpha(3) - alpha(2)) * step(e[2])
    }

    /// A cell's drawn alpha, continuous in time: the steps are ramps about `smoothness` / 8 of brightness wide, which with
    /// the noise's own rate is a 0.3-0.8 s change. `smoothness` 0 is the plain quantised level.
    public static func smoothAlpha(col: Int, row: Int, cols: Int, rows: Int, t: Double, seed: UInt64 = 0, tuning: Tuning = Tuning()) -> Double {
        softAlpha(value(col: col, row: row, cols: cols, rows: rows, t: t, seed: seed, tuning: tuning), width: tuning.smoothness / 8 * 1.3)
    }

    /// The still glyph's frame (Reduce Motion): the working field at `stillTime`.
    public static func stillLevel(col: Int, row: Int, cols: Int, rows: Int, seed: UInt64 = 0) -> Int {
        level(col: col, row: row, cols: cols, rows: rows, t: stillTime, seed: seed)
    }

}

// MARK: one frame, everything per-glyph worked out once

extension TideMotion {
    /// A glyph's brightness field at one instant with everything that does not depend on the cell computed once: the flow
    /// time (three cosines), the drift heading and swirls, and the hash prefix of each noise layer. `smoothAlpha` per cell
    /// recomputed all of it for every cell (80 cells of a stream glyph, at 30 fps, per glyph on screen), which was half of the
    /// Mac app's main-thread time in a live sample. The result is exactly `smoothAlpha`'s (a test pins it), cell for cell.
    public struct Frame: Sendable {
        let u: Double, along: Double, across: Double, c: Double, s: Double
        let hA: UInt64, hB: UInt64, hLen: UInt64, hPos: UInt64, hSlot: UInt64
        let sparkle: Double, vignette: Double, width: Double
        let tuning: Tuning

        public init(t: Double, seed: UInt64, tuning: Tuning = Tuning()) {
            let u = TideMotion.flowTime(t, seed, tuning) / (TideMotion.baseRate * 0.5)
            let theta = 2 * .pi * TideMotion.unit(seed &+ 80, 1)
            let c = cos(theta), s = sin(theta)
            let sw1 = 3.0 * sin(TideMotion.wrap(u * 2 * .pi / 53) + 6.28 * TideMotion.unit(seed &+ 80, 2))
            let sw2 = 2.0 * sin(TideMotion.wrap(u * 2 * .pi / 37) + 6.28 * TideMotion.unit(seed &+ 80, 3))
            self.u = u; self.c = c; self.s = s
            self.along = 0.3 * u + sw2; self.across = sw1
            self.hA = TideMotion.mix(seed &+ 81); self.hB = TideMotion.mix(seed &+ 82)
            self.hLen = TideMotion.mix(seed &+ 90); self.hPos = TideMotion.mix(seed &+ 91); self.hSlot = TideMotion.mix(seed &+ 92)
            self.sparkle = tuning.sparkle; self.vignette = tuning.vignette
            self.width = tuning.smoothness / 8 * 1.3
            self.tuning = tuning
        }

        /// `unit(seed, a, b, c)` with the seed's first mix already done (`h0 = mix(seed)`).
        @inline(__always) private static func unit(_ h0: UInt64, _ a: Int, _ b: Int = 0, _ c: Int = 0) -> Double {
            var h = TideMotion.mix(h0 ^ UInt64(bitPattern: Int64(a)))
            h = TideMotion.mix(h ^ UInt64(bitPattern: Int64(b)) &* 0xD6E8_FEB8_6659_FD93)
            h = TideMotion.mix(h ^ UInt64(bitPattern: Int64(c)) &* 0xA076_1D64_78BD_642F)
            return Double(h >> 11) / Double(1 << 53)
        }
        @inline(__always) private static func noise(_ x: Double, _ y: Double, _ z: Double, _ h0: UInt64) -> Double {
            let fx = x.rounded(.down), fy = y.rounded(.down), fz = z.rounded(.down)
            let ix = Int(fx), iy = Int(fy), iz = Int(fz)
            @inline(__always) func sm(_ t: Double) -> Double { t * t * (3 - 2 * t) }
            let tx = sm(x - fx), ty = sm(y - fy), tz = sm(z - fz)
            @inline(__always) func v(_ dx: Int, _ dy: Int, _ dz: Int) -> Double { unit(h0, ix + dx, iy + dy, iz + dz) * 2 - 1 }
            @inline(__always) func lerp(_ a: Double, _ b: Double, _ t: Double) -> Double { a + (b - a) * t }
            let x00 = lerp(v(0, 0, 0), v(1, 0, 0), tx), x10 = lerp(v(0, 1, 0), v(1, 1, 0), tx)
            let x01 = lerp(v(0, 0, 1), v(1, 0, 1), tx), x11 = lerp(v(0, 1, 1), v(1, 1, 1), tx)
            return lerp(lerp(x00, x10, ty), lerp(x01, x11, ty), tz)
        }

        /// The cell's drawn alpha; equal to `TideMotion.smoothAlpha` for the same time, seed and tuning.
        public func alpha(col: Int, row: Int, cols: Int, rows: Int) -> Double {
            let g = TideMotion.vignette(col: col, row: row, cols: cols, rows: rows, tuning: tuning)
            let gain = 1 - 0.8 * (1 - g) * min(1, vignette)
            guard gain > 0 else { return TideMotion.softAlpha(0, width: width) }
            let x = Double(col) + along * c - across * s, y = Double(row) + along * s + across * c
            let n = 0.6 * Frame.noise(x * TideMotion.freqA, y * TideMotion.freqA, u * 0.38, hA)
                + 0.4 * Frame.noise(x * TideMotion.freqB + 9.1, y * TideMotion.freqB + 4.7, u * 0.62 + 3, hB)
            let f = max(0, min(1, 0.5 + 1.45 * n))
            // Sparkle.
            let a = col &+ row &* 977
            let len = 1.0 + 1.4 * Frame.unit(hLen, a)
            let pos = u / len + Frame.unit(hPos, a) * 60
            let slot = Int(pos.rounded(.down)), frac = pos - Double(slot)
            var sp = 0.0
            if Frame.unit(hSlot, a, slot) < 0.035 * sparkle { let b = sin(.pi * frac); sp = 0.6 * b * b }
            return TideMotion.softAlpha((f + sp) * gain, width: width)
        }
    }
}
