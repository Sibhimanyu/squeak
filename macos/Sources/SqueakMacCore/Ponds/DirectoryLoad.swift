import Foundation

/// Whether the pond directory has been read yet, and when to ask again. "Not loaded yet" is not "no ponds": the sidebar
/// says "No ponds yet" only after the host answered with an empty list (or is too old to have the route).
public struct DirectoryLoad: Equatable, Sendable {
    public private(set) var loaded = false
    /// The host answered 404: older than the route, so asking again is pointless.
    public private(set) var unsupported = false
    public private(set) var failures = 0
    public private(set) var inFlight = false

    public init() {}

    /// Delays after the 1st, 2nd, ... failure; every failure past the list waits `steady`.
    public static let backoff: [TimeInterval] = [0.5, 1, 2, 4]
    public static let steady: TimeInterval = 8
    /// The directory call is slow on a busy host (measured 8 s), so it gets more than the default.
    public static let timeout: TimeInterval = 20

    public static func delay(afterFailures n: Int) -> TimeInterval {
        n >= 1 && n <= backoff.count ? backoff[n - 1] : steady
    }

    /// True while a retry is owed: never loaded, not an old host.
    public var needsRetry: Bool { !loaded && !unsupported }
    public var nextDelay: TimeInterval { Self.delay(afterFailures: max(failures, 1)) }
    /// The sidebar shows "Loading ponds…" (or nothing) rather than the empty message.
    public var isLoading: Bool { !loaded && !unsupported }
    /// The empty message may show only when the host answered (or cannot).
    public func showsEmptyMessage(isEmpty: Bool) -> Bool { isEmpty && !isLoading }

    /// Starts a load; false when one is already running (no stacking).
    public mutating func begin() -> Bool {
        guard !inFlight else { return false }
        inFlight = true
        return true
    }

    public mutating func succeeded() { inFlight = false; loaded = true; failures = 0 }
    public mutating func unsupportedHost() { inFlight = false; unsupported = true }
    /// A failure never clears a directory already held; it only counts toward the next delay.
    public mutating func failed() { inFlight = false; if !loaded { failures += 1 } }
}
