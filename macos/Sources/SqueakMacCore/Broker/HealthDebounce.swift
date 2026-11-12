import Foundation

/// Holds back a failing adapter's report until it has failed continuously for `grace`, so a
/// daemon restart (`ship.sh`: kill + a few seconds of startup) does not flash "Trouble connecting".
/// Meanwhile the last good report stands. Recovery is immediate, and failures that will not heal
/// by themselves (a missing or rejected token) are never held back.
public struct HealthDebounce: Sendable {
    public static let defaultGrace: TimeInterval = 15

    private let grace: TimeInterval
    private var failingSince: [String: Date] = [:]
    private var lastGood: [String: AdapterHealth] = [:]

    public init(grace: TimeInterval = HealthDebounce.defaultGrace) { self.grace = grace }

    /// What the UI should see for this raw report. `immediate` skips the grace period.
    public mutating func reduce(_ raw: AdapterHealth, immediate: Bool = false, now: Date) -> AdapterHealth {
        let id = raw.adapterId
        if raw.status == .connected {
            failingSince[id] = nil
            lastGood[id] = raw
            return raw
        }
        if immediate || raw.status == .tokenMissing { return raw }
        let since = failingSince[id] ?? now
        failingSince[id] = since
        guard now.timeIntervalSince(since) < grace, let good = lastGood[id] else { return raw }
        return good
    }
}
