import Foundation

/// Decides when a chat that is laying itself out may be shown. A chat opens before it is whole: rows are measured
/// over several passes and the history and the work land in swaps, so its height changes many times in the first
/// moments. It is kept laid out but unseen until its height has held still for `quiet`, or `cap` has passed since
/// the first frame (a turn streaming in never holds still), then shown once, already at the bottom.
/// Pure: height samples and times in, shown or not out.
struct ChatReveal: Equatable {
    var quiet: TimeInterval = 0.08
    var cap: TimeInterval = 0.5
    /// A change smaller than this is rounding, not growth.
    var tolerance: Double = 0.5

    private(set) var firstFrameAt: TimeInterval?
    private(set) var lastHeight: Double?
    private(set) var lastChangeAt: TimeInterval?
    private(set) var shown = false

    /// A sample of the content's height, taken at `now`; `ready` is whether the chat has a frame of rows to draw.
    mutating func sample(height: Double, ready: Bool, at now: TimeInterval) {
        guard ready else { return }
        markReady(at: now)
        if let last = lastHeight, abs(last - height) <= tolerance { return }
        lastHeight = height
        lastChangeAt = now
    }

    /// The chat has rows: the quiet period runs from this moment even if no height change follows (a cached
    /// frame laid out in one pass).
    mutating func markReady(at now: TimeInterval) {
        if firstFrameAt == nil { firstFrameAt = now; lastChangeAt = now }
    }

    /// Whether to show now. Once true, always true: `shown` latches.
    mutating func decide(at now: TimeInterval) -> Bool {
        if shown { return true }
        guard let first = firstFrameAt, let last = lastChangeAt else { return false }
        if now - last >= quiet || now - first >= cap { shown = true }
        return shown
    }
}
