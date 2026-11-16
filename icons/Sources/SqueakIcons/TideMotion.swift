import Foundation

/// The pure maths of `TideGlyph`: a pure function of (pixel, time, seed). The lit region is a horizontal stream whose
/// top and bottom surfaces are smooth noise advected left to right; inside it, domain-warped 3-D noise drifts right and
/// interferes into bright patches (light on water), and every pixel adds irregular hashed sparkles. The pace and
/// the character both drift like real water: the flow's clock is the integral of a slowly wandering rate (0.5x to 1.3x
/// of a slow base, over 10-30 s) and a second slow channel morphs the texture between calm (long smooth streaks, little
/// foam) and choppy (short streaks, more sparkle and ripple). Rates are sums of sines with seeded, incommensurate
/// periods, so the motion never visibly loops, and the seed (one per view) feeds every hash, so two glyphs never match. The two ends
/// dissolve, so no box edge shows, and no pixel sits on a curve, so there are no lines of dots.
public enum TideMotion {
    /// Brightness levels 0...3: off, dim, mid, full.
    public static func alpha(_ level: Int) -> Double {
        switch level {
        case ..<1: return 0
        case 1: return 0.38
        case 2: return 0.68
        default: return 1
        }
    }

    /// A soft elliptical falloff, 0...1, by which every pixel's alpha is multiplied so no edge reads as a box: full in the
    /// middle, fading to nothing at the left and right ends (wider than the rows), a little at top and bottom.
    public static func vignette(col: Int, row: Int, cols: Int, rows: Int) -> Double {
        let nx = (Double(col) + 0.5) / Double(cols) * 2 - 1
        let ny = (Double(row) + 0.5) / Double(rows) * 2 - 1
        let r = (nx * nx + (0.55 * ny) * (0.55 * ny)).squareRoot()
        let x = max(0, min(1, (r - 0.5) / 0.5))
        let f = 1 - x * x * (3 - 2 * x)
        return f
    }

    /// The time a still glyph samples.
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

    // MARK: stream

    /// Flow speed of the glyph at its calmest and busiest, relative to the first version: the mean rate is ~0.5x.
    static let baseRate = 0.55

    /// The wandering pace, 0.5...1.3 (a sum of three sines with seeded periods of about 11-19, 7-11 and 23-31 s).
    static func pace(_ t: Double, _ seed: UInt64) -> Double {
        let w = paceWaves(seed)
        return 0.9 + 0.4 * (0.5 * sin(w.0.w * t + w.0.p) + 0.3 * sin(w.1.w * t + w.1.p) + 0.2 * sin(w.2.w * t + w.2.p))
    }
    private static func paceWaves(_ seed: UInt64) -> ((w: Double, p: Double), (w: Double, p: Double), (w: Double, p: Double)) {
        func wave(_ k: UInt64, _ lo: Double, _ hi: Double) -> (w: Double, p: Double) {
            (2 * .pi / (lo + (hi - lo) * unit(seed &+ k, 1)), 2 * .pi * unit(seed &+ k, 2))
        }
        return (wave(70, 11, 19), wave(71, 7, 11), wave(72, 23, 31))
    }

    /// The stream's clock: the integral of `baseRate * pace`, so it never jumps and runs at half the old speed on average.
    /// It drives the flow, the surface waves and the sparkles; the morph below runs on it too.
    static func flowTime(_ t: Double, _ seed: UInt64) -> Double {
        let w = paceWaves(seed)
        func part(_ x: (w: Double, p: Double), _ amp: Double) -> Double { -amp * (cos(x.w * t + x.p) - cos(x.p)) / x.w }
        return baseRate * (0.9 * t + 0.4 * (part(w.0, 0.5) + part(w.1, 0.3) + part(w.2, 0.2)))
    }

    /// 0 (calm) ... 1 (choppy): a slow seeded channel over 15-30 s that changes the texture's character.
    static func choppiness(_ t: Double, _ seed: UInt64) -> Double {
        max(0, min(1, 0.5 + 1.4 * (0.7 * noise(t / 21, 0.5, 0.5, seed &+ 60) + 0.3 * noise(t / 13 + 7, 1.5, 0.5, seed &+ 61))))
    }

    /// The surfaces at horizontal position `x` (0...1): the stream's top and bottom edge in y units where the outer
    /// rows sit near +-1; the band is about two thirds of the height and each surface moves about one row. The surface
    /// waves are advected slowly (the body's streaks run faster, so layers of water move at different speeds).
    static func surfaces(x: Double, t: Double, seed: UInt64) -> (top: Double, bottom: Double) {
        let tau = flowTime(t, seed), chop = choppiness(t, seed)
        let ripple = 0.22 + 0.26 * chop, fx = 0.85 + 0.4 * chop  // choppy water ripples more and finer
        let thick = 1 + 0.15 * noise(tau * 0.2, 0.5, 0.5, seed &+ 12)
        let sway = 0.12 * noise(x * 1.1 - 0.10 * tau, tau * 0.1, 0.5, seed &+ 13)
        let top = 0.62 * thick + ripple * noise(x * 3.2 * fx - 0.30 * tau, tau * 0.22, 1.5, seed &+ 14)
        let bottom = 0.62 * thick + ripple * noise(x * 3.0 * fx - 0.27 * tau, tau * 0.2, 2.5, seed &+ 15)
        return (-top + sway, bottom + sway)
    }

    /// The current's streaks at a pixel, 0...1: noise stretched about 3.5x along x and advected right much faster than
    /// the surface, row-staggered and domain-warped, so features are short broken horizontal streaks (2-6 px).
    static func streaks(col: Int, row: Int, cols: Int, rows: Int, t: Double, seed: UInt64) -> Double {
        let tau = flowTime(t, seed), chop = choppiness(t, seed)
        let l1 = 4.8 - 2.2 * chop, l2 = 2.9 - 1.3 * chop  // calm: long smooth streaks; choppy: short ones
        let c = (Double(col) + 0.5) / Double(cols) * 21, r = Double(row) / Double(rows) * 6  // units of the 21x6 grid
        let stagger = unit(seed &+ 40, row) * 23
        let u = c + stagger - 9.0 * tau + 0.9 * noise(c * 0.3, r * 0.7, tau * 0.4, seed &+ 41)
        let n = 0.6 * noise(u / l1, r / 0.95, tau * 0.6, seed &+ 42) + 0.4 * noise(u / l2 + 5.3, r / 0.8 + 3, tau * 0.9, seed &+ 43)
        let x = (n + 0.12) / 0.62
        let f = max(0, min(1, x))
        return f * f * (3 - 2 * f)
    }

    /// 0...1 brightness at a pixel before quantizing.
    static func value(col: Int, row: Int, cols: Int, rows: Int, t: Double, seed: UInt64) -> Double {
        let x = (Double(col) + 0.5) / Double(cols)
        let y = (Double(row) - Double(rows - 1) / 2) / (Double(rows) / 2)
        // Ends dissolve over the outer ~20% of the width. The left end is thinner (water entering); the right trails off.
        let span = max(1.2, Double(cols) * 0.2)
        let dc = Double(min(col, cols - 1 - col))
        let e = max(0, min(1, (dc + 0.3) / span))
        let ends = e * e * (3 - 2 * e)
        let left = col < cols / 2
        let narrow = left ? 0.15 + 0.85 * ends : 0.45 + 0.55 * ends
        let s = surfaces(x: x, t: t, seed: seed)
        let mid = (s.top + s.bottom) / 2
        let topEdge = mid + (s.top - mid) * narrow, bottomEdge = mid + (s.bottom - mid) * narrow
        let dTop = y - topEdge, dBottom = bottomEdge - y
        let a = col &+ row &* 977
        let tau = flowTime(t, seed), chop = choppiness(t, seed)
        let slot = Int((tau / 0.22 + unit(seed &+ 50, a) * 40).rounded(.down))
        // Spray: now and then a crest lifts a pixel just above the surface and drops back.
        if dTop < -0.05, dTop > -0.42, ends > 0.3, unit(seed &+ 51, col, slot) < 0.025, unit(seed &+ 52, col, row, slot) < 0.7 {
            return 0.85 * ends
        }
        let d = min(dTop, dBottom)
        let body = max(0, min(1, d / 0.3 + 0.25))
        if ends > 0, body <= 0, !left, ends < 0.65, unit(seed &+ 53, a, slot) < 0.08 * (1 - ends) { return 0.5 }  // droplets
        guard body > 0, ends > 0 else { return 0 }
        // The current: streaks with a short trail (head bright, tail dimmer to the left), a pure function of (seed, t).
        var light = 0.0, decay = 1.0
        for k in 0..<4 {
            light = max(light, decay * streaks(col: col, row: row, cols: cols, rows: rows, t: t - 0.15 * Double(k), seed: seed))
            decay *= 0.6
        }
        // Foam and crest highlights at the top, deeper water dimmer at the bottom.
        let foam = max(0, min(1, 1 - dTop / 0.42)) * (0.5 + 0.65 * chop)
        let depth = 1.05 - 0.4 * max(0, min(1, (0.5 - dBottom) / 0.5))
        // Sparkles: two layers of hashed events with irregular durations; more of them in the foam.
        let da = 0.3 + 0.6 * unit(seed &+ 31, a), db = 0.7 + 0.9 * unit(seed &+ 32, a)
        let sa = Int((tau / da + unit(seed &+ 33, a) * 50).rounded(.down)), sb = Int((tau / db + unit(seed &+ 34, a) * 50).rounded(.down))
        let jitter = (unit(seed &+ 35, a, sa) - 0.5) * 0.3
        let chance = (0.05 + 0.06 * foam) * (0.5 + 1.2 * chop)
        let spark = (unit(seed &+ 36, a, sa) < chance || unit(seed &+ 37, a, sb) < 0.02 * (0.5 + 1.2 * chop)) ? 0.6 : 0
        let v = max(0, min(1, (light * depth + 0.3 * foam * light + jitter + spark)))
        return ends * min(1, body * 1.2) * (0.08 + 0.92 * v)
    }

    public static func level(col: Int, row: Int, cols: Int, rows: Int, t: Double, seed: UInt64 = 0) -> Int {
        let v = value(col: col, row: row, cols: cols, rows: rows, t: t, seed: seed)
        return v < 0.12 ? 0 : v < 0.30 ? 1 : v < 0.54 ? 2 : 3
    }

    /// The still glyph's frame: the left half at `stillTime`, mirrored, so it is exactly symmetric left/right.
    public static func stillLevel(col: Int, row: Int, cols: Int, rows: Int, seed: UInt64 = 0) -> Int {
        level(col: min(col, cols - 1 - col), row: row, cols: cols, rows: rows, t: stillTime, seed: seed)
    }
}
