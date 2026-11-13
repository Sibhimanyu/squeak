import Foundation

/// Holds back a failing adapter's report until it has failed continuously for `grace`, so a
/// daemon restart (`ship.sh`: kill + a few seconds of startup) does not flash "Trouble connecting".
/// A report needs both time and evidence: at least `minFailures` failed polls in a row AND the grace
/// elapsed, and a service that is up but slow (`degraded`: a timeout, an odd response) gets the longer
/// `slowGrace`, because a busy session host can miss several answers and then recover. One slow or
/// timed-out request never flips the app to "Trouble connecting" / offline composer.
/// Meanwhile the last good report stands. Recovery is immediate, and failures that will not heal
/// by themselves (a missing or rejected token) are never held back.
public struct HealthDebounce: Sendable {
    public static let defaultGrace: TimeInterval = 15
    public static let defaultSlowGrace: TimeInterval = 30
    public static let defaultMinFailures = 3

    private let grace: TimeInterval
    private let slowGrace: TimeInterval
    private let minFailures: Int
    private var failingSince: [String: Date] = [:]
    private var failures: [String: Int] = [:]
    private var lastGood: [String: AdapterHealth] = [:]

    public init(
        grace: TimeInterval = HealthDebounce.defaultGrace,
        slowGrace: TimeInterval? = nil,
        minFailures: Int = HealthDebounce.defaultMinFailures
    ) {
        self.grace = grace
        self.slowGrace = slowGrace ?? max(grace, HealthDebounce.defaultSlowGrace)
        self.minFailures = minFailures
    }

    /// What the UI should see for this raw report. `immediate` skips the grace period.
    public mutating func reduce(_ raw: AdapterHealth, immediate: Bool = false, now: Date) -> AdapterHealth {
        let id = raw.adapterId
        if raw.status == .connected {
            failingSince[id] = nil
            failures[id] = nil
            lastGood[id] = raw
            return raw
        }
        if immediate || raw.status == .tokenMissing { return raw }
        let since = failingSince[id] ?? now
        failingSince[id] = since
        let count = (failures[id] ?? 0) + 1
        failures[id] = count
        var wait = grace
        if case .degraded = raw.status { wait = slowGrace }
        guard let good = lastGood[id] else { return raw }
        if now.timeIntervalSince(since) < wait || count < minFailures { return good }
        return raw
    }
}
