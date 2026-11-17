/// The one rule for the working glyph (DESIGN.md §3.3, §8.1): the twinkling pixel grid means activity, so it is drawn
/// only on something that is working right now, and only moving. Everything else (idle, finished, read, off duty,
/// archived, stale, offline) draws no glyph. Reduce Motion swaps it for a distinct, non-pixel icon, never a frozen frame.
public enum GlyphPresentation: Equatable, Sendable {
    case animatedGlyph, reduceMotionIcon, none

    /// `working`: something under this mark is working right now (background tasks count; a stale or offline source does not).
    public static func of(working: Bool, reduceMotion: Bool) -> GlyphPresentation {
        guard working else { return .none }
        return reduceMotion ? .reduceMotionIcon : .animatedGlyph
    }
}
