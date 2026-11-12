import Foundation

/// How the waves icon moves (2026-11-12). Pure functions of the wall clock, so glyphs on screen move in step and a test
/// pins every number. Working is a rolling swell: the three lines are out of step (top, then middle, then bottom), each
/// with a slowly breathing amplitude, so one wave seems to travel across the whole icon. Waiting is a ripple: once every
/// `rippleSeconds` the middle line swells and the outer two follow, pushing outward like a drop landing, then everything
/// settles back to Lucide's `waves` until the next one. Rest (and Reduce Motion) is `StreamGlyphMotion.rest`.
public enum StreamGlyphMotion {
    /// One line's drawing parameters: the wave's phase, its amplitude and a vertical shift, on the 24 grid.
    public struct Line: Equatable, Sendable {
        public var phase: Double
        public var amplitude: Double
        public var shift: Double
    }

    /// The icon at rest: Lucide `waves`.
    public static let rest: [Line] = (0..<3).map { _ in Line(phase: 0, amplitude: StreamGlyphGeometry.amplitude, shift: 0) }

    /// Seconds a swell takes to travel one period: slower than the old flow, so it reads calm.
    public static let swellSeconds = 2.8
    /// Phase each line lags the one above it, radians (a third of a period would be 2.09; less keeps it one wave).
    public static let lineLag = 0.95
    /// The amplitude breathes by this fraction either way, over `breathSeconds`, each line at its own point.
    public static let breath = 0.25
    public static let breathSeconds = 5.6

    public static let rippleSeconds = 3.0
    /// How long one pulse lasts, per line, and the delay of each outer line behind the middle one.
    public static let rippleLength = 1.1
    public static let rippleDelay = 0.18
    /// At the pulse's peak the amplitude grows by this much and the outer lines move out by `rippleSpread`.
    public static let rippleGain = 0.7
    public static let rippleSpread = 1.4

    /// The rolling swell at a wall-clock time. Every line is the same wave, delayed; amplitude stays within 0.75…1.25
    /// of Lucide's, so the strokes never leave the 24 grid.
    public static func swell(at time: TimeInterval) -> [Line] {
        let base = -2 * Double.pi * (time.truncatingRemainder(dividingBy: swellSeconds) / swellSeconds)
        return (0..<3).map { row in
            let breathe = sin(2 * .pi * time / breathSeconds + Double(row) * 1.3)
            return Line(phase: base - Double(row) * lineLag,
                        amplitude: StreamGlyphGeometry.amplitude * (1 + breath * breathe), shift: 0)
        }
    }

    /// 0 at rest, 1 at a pulse's peak: a smooth bell (`sin²`) over `rippleLength` seconds, then exactly 0 until the next
    /// pulse. `delay` pushes it later (the outer lines).
    public static func rippleEnvelope(at time: TimeInterval, delay: Double = 0) -> Double {
        let t = (time - delay).truncatingRemainder(dividingBy: rippleSeconds)
        let u = (t < 0 ? t + rippleSeconds : t) / rippleLength
        guard u < 1 else { return 0 }
        let s = sin(.pi * u)
        return s * s
    }

    /// The ripple at a wall-clock time: the middle line first, the top and bottom one `rippleDelay` later, moving out.
    public static func ripple(at time: TimeInterval) -> [Line] {
        (0..<3).map { row in
            let e = rippleEnvelope(at: time, delay: row == 1 ? 0 : rippleDelay)
            let outward = row == 0 ? -1.0 : row == 2 ? 1.0 : 0
            return Line(phase: 0, amplitude: StreamGlyphGeometry.amplitude * (1 + rippleGain * e), shift: outward * rippleSpread * e)
        }
    }

    /// The waiting dot's scale: it swells with the middle line's pulse.
    public static func dotScale(at time: TimeInterval) -> Double { 1 + 0.35 * rippleEnvelope(at: time) }

    /// What to draw: `nil` state motion (idle, failed, unread), Reduce Motion or an inactive scene is the rest shape.
    public static func lines(working: Bool, waiting: Bool, at time: TimeInterval, animated: Bool) -> [Line] {
        guard animated else { return rest }
        if working { return swell(at: time) }
        if waiting { return ripple(at: time) }
        return rest
    }

    /// One line's points on the 24 grid.
    public static func points(row: Int, line: Line) -> [CGPoint] {
        stride(from: StreamGlyphGeometry.left, through: StreamGlyphGeometry.right, by: StreamGlyphGeometry.step).map { x in
            let y = StreamGlyphGeometry.rows[row] + line.shift
                + line.amplitude * sin(2 * .pi * (x - StreamGlyphGeometry.left) / StreamGlyphGeometry.period + line.phase)
            return CGPoint(x: x, y: y)
        }
    }
}
