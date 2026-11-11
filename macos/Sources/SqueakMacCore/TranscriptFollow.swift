import Foundation

/// The transcript's one follow model, like a terminal's: either the view follows the newest end, or it never moves
/// by itself. Pure (no UI): the scroll driver feeds it events and does what the action says.
///
/// - Following starts true (open) and comes back by the jump button, a message just sent, or the reader scrolling back
///   to within `reattachDistance` of the end.
/// - Following turns false only on a scroll the reader made (`userScrolled`), never because content grew: a growing last
///   row moves the end away from the viewport, and that must read as "still following", not "scrolled up".
/// - While following, every content change scrolls to the end, with no animation.
/// - While not following, content changes do nothing, except to hold the row the reader is on when older rows are paged
///   in above it (`holdPlace`: the distance from the end stays what it was, which is exactly "the same row stays put",
///   because a page adds height only above it).
public struct TranscriptFollow: Equatable, Sendable {
    /// Within this many points of the end the reader counts as being at it.
    public static let reattachDistance: Double = 24

    public enum Event: Equatable, Sendable {
        /// The transcript appeared.
        case opened
        /// A row arrived, a streamed delta landed, a row changed height, the viewport resized.
        case contentChanged
        /// The reader scrolled (wheel, trackpad, scrollbar, keys) and is now this far from the end (points, 0 = at it).
        case userScrolled(distanceFromBottom: Double)
        /// The reader's scroll gesture (momentum included) ended.
        case userScrollEnded(distanceFromBottom: Double)
        /// The jump-to-latest button, or the reader sent a message.
        case jumpTapped
        /// Older rows are about to be added above the reader's place (the reader is this far from the end now).
        case holdPlace(distanceFromBottom: Double)
        /// The page has been laid out.
        case releasePlace
    }

    public enum Action: Equatable, Sendable {
        case none
        /// Put the end in view, now, without animation.
        case scrollToBottom
        /// Put the viewport this far from the end (keeps the reader's row where it was after rows landed above it).
        case restore(distanceFromBottom: Double)
    }

    public private(set) var following = true
    /// Distance from the end to keep while older rows land above (nil: no page in flight).
    public private(set) var held: Double?

    public init() {}

    @discardableResult
    public mutating func handle(_ event: Event) -> Action {
        switch event {
        case .opened:
            following = true
            held = nil
            return .scrollToBottom
        case .contentChanged:
            if following { return .scrollToBottom }
            if let held { return .restore(distanceFromBottom: held) }
            return .none
        case .userScrolled(let d):
            following = d <= Self.reattachDistance
            if held != nil { held = max(0, d) }
            return .none
        case .userScrollEnded(let d):
            following = d <= Self.reattachDistance
            if held != nil { held = max(0, d) }
            // The reader let go within reach of the end: settle on it (never while they are still moving).
            return following && d > 0.5 ? .scrollToBottom : .none
        case .jumpTapped:
            following = true
            held = nil
            return .scrollToBottom
        case .holdPlace(let d):
            held = following ? nil : max(0, d)
            return .none
        case .releasePlace:
            held = nil
            return .none
        }
    }
}
