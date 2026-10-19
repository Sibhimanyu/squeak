import Foundation

/// When sending needs Face ID. Once is enough while the app stays in use:
/// after a successful check, sends go straight out until the app has been
/// in the background for longer than `away` (the screen locking counts).
/// So a phone picked up off a table after a while still asks, and a
/// conversation does not.
public struct SendUnlock: Equatable, Sendable {
    public static let away: TimeInterval = 5 * 60

    private var unlocked = false
    private var backgroundedAt: Date?

    public init() {}

    public var needsAuthentication: Bool { !unlocked }

    public mutating func authenticated() {
        unlocked = true
        backgroundedAt = nil
    }

    public mutating func backgrounded(at now: Date = Date()) {
        if backgroundedAt == nil { backgroundedAt = now }
    }

    public mutating func foregrounded(at now: Date = Date()) {
        if let since = backgroundedAt, now.timeIntervalSince(since) > Self.away { unlocked = false }
        backgroundedAt = nil
    }
}
