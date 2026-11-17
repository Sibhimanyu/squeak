import Foundation

/// The dock's one reserved line above the composer: the live row (glyph, clock) at the left and the "Next update ›"
/// pill at the right. The pill has exactly one owner, decided here: a single row holds it whether or not the live row
/// is drawn, so the row never swaps one pill for another (a swap crossfades two, and an interrupted fade left both).
public enum DockAttentionRow {
    public struct Layout: Equatable, Sendable {
        /// The row is drawn at all.
        public var showsRow: Bool
        /// The live row's content (glyph, words, clock) is drawn at the left.
        public var showsLive: Bool
        /// The next-attention pill is drawn at the right. Never more than one pill exists.
        public var showsPill: Bool
        public var pillCount: Int { showsPill ? 1 : 0 }
    }

    public static func layout(showsLiveRow: Bool, hasAttentionJump: Bool) -> Layout {
        Layout(showsRow: showsLiveRow || hasAttentionJump, showsLive: showsLiveRow, showsPill: hasAttentionJump)
    }
}
