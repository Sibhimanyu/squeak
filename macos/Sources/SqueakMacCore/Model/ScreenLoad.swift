import Foundation

/// What a screen that fills in from a read shows: the skeleton while the first read is out and there is nothing
/// to draw yet, the content as soon as anything is on hand (cached or read), the empty note only once a read
/// has actually answered. "Nothing yet" must never be shown for "not asked yet".
public enum ScreenLoad: Sendable, Equatable {
    case loading, content, empty

    public static func phase(hasContent: Bool, firstReadDone: Bool) -> ScreenLoad {
        if hasContent { return .content }
        return firstReadDone ? .empty : .loading
    }
}

/// Which list row a queued-message change is for, so the card can say "Steering…" / "Deleting…" at once.
public enum QueueChangeKind: Sendable, Equatable {
    case steer, delete

    public var word: String { self == .steer ? "Steering…" : "Deleting…" }
}
