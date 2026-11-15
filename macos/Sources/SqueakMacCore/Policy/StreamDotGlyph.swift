import Foundation

/// The stream glyph (DESIGN.md §8.1, "Stream glyph"): a 3 x 6 grid of dots whose rows each sit on a gentle wave, so the
/// lit dots trace three wave lines, in the dot-grid loader's language. Pure functions of state and the wall clock, so
/// every glyph on screen flows in step and a test pins every number.
///
/// idle: static, dim, `muted`. working: a soft brightness wave travels left to right through the dots in the state
/// colour, one pass every `flowSeconds`. needs you, error and unread: steady, no motion. Reduce Motion: the working
/// glyph holds one frame of the wave (the lit pattern), never the dim idle one.
public enum StreamDotGlyph {
    public static let rows = 3
    public static let columns = 6
    /// Seconds one brightness wave takes to cross the glyph; a calm loop.
    public static let flowSeconds = 1.6
    /// The most the glyph ticks a second while it flows.
    public static let framesPerSecond = 20.0
    /// Dot strengths: idle sits at `idleLevel`; the working wave runs between `troughLevel` and 1.
    public static let idleLevel = 0.45
    public static let troughLevel = 0.3
    /// How far a dot sits above or below its row's centre line, in grid pitches of the glyph's height / rows.
    public static let waveAmplitude = 0.26
    /// Per row, the wave's brightness lags the row above it by this fraction of a column's travel.
    public static let rowLag = 0.35

    /// A dot's centre in the unit square: x across columns, y on its row's wave (so rows 0..2 trace three lines).
    public static func centre(row: Int, column: Int) -> (x: Double, y: Double) {
        let pitchY = 1.0 / Double(rows)
        let baseY = (Double(row) + 0.5) * pitchY
        let y = baseY - waveAmplitude * pitchY * sin(2 * .pi * Double(column) / Double(columns))
        return ((Double(column) + 0.5) / Double(columns), y)
    }

    /// The working wave's strength at a dot, `troughLevel`...1, travelling right: the crest sits at column
    /// `columns * time / flowSeconds` and wraps.
    public static func wave(row: Int, column: Int, time: TimeInterval) -> Double {
        let x = (Double(column) + Double(row) * rowLag) / Double(columns)
        let phase = time.truncatingRemainder(dividingBy: flowSeconds) / flowSeconds
        let crest = 0.5 + 0.5 * cos(2 * .pi * (phase - x))
        return troughLevel + (1 - troughLevel) * crest
    }

    /// How strongly a dot is drawn (0...1 opacity of the state colour). `animated` false is Reduce Motion, or any
    /// moment the window is inactive.
    public static func level(state: StreamGlyphState, row: Int, column: Int, time: TimeInterval, animated: Bool) -> Double {
        switch state {
        case .idle: idleLevel
        case .working: wave(row: row, column: column, time: animated ? time : 0)
        case .waiting, .failed, .unread: 1
        }
    }

    /// Only a working glyph moves.
    public static func flows(_ state: StreamGlyphState) -> Bool { state == .working }
}
