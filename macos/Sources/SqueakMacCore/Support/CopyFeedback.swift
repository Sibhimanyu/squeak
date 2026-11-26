import Foundation

/// What a Copy button shows: its label, then "Copied" for `holdFor` seconds, with an injected clock.
public struct CopyFeedback: Sendable, Equatable {
    public static let holdFor: TimeInterval = 1.5
    private var copiedAt: Date?
    public init() {}

    public mutating func copied(at now: Date) { copiedAt = now }
    public func isCopied(now: Date) -> Bool {
        guard let copiedAt else { return false }
        let age = now.timeIntervalSince(copiedAt)
        return age >= 0 && age < Self.holdFor
    }
    public func label(_ plain: String, now: Date) -> String { isCopied(now: now) ? "Copied \u{2713}" : plain }
}
