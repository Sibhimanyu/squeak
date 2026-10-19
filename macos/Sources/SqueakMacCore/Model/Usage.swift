import Foundation

/// One plan window: how much is used (0-100) and when it resets.
public struct UsageWindow: Hashable, Sendable {
    public var usedPercent: Double
    public var resetsAt: Date?

    public init(usedPercent: Double, resetsAt: Date?) {
        self.usedPercent = usedPercent
        self.resetsAt = resetsAt
    }
}

/// One provider's reading: a short window (5 hours) and a long one (7 days, or Codex's weekly),
/// with when it was observed. Claude's is as old as the last time Claude Code reported it.
public struct ProviderUsage: Hashable, Sendable {
    public var fiveHour: UsageWindow?
    public var longWindow: UsageWindow?
    public var observedAt: Date?

    public init(fiveHour: UsageWindow?, longWindow: UsageWindow?, observedAt: Date?) {
        self.fiveHour = fiveHour
        self.longWindow = longWindow
        self.observedAt = observedAt
    }
}

/// What the usage screens draw: both readings and the estimated cost of today's sessions.
public struct UsageSnapshot: Hashable, Sendable {
    public var claude: ProviderUsage?
    public var codex: ProviderUsage?
    /// Sum of the estimated cost of sessions active today. Each session's total is for its whole
    /// life, so a long-running session counts in full on the day it was last active. An estimate.
    public var todayCostUsd: Double?
    public var todayCostSessions: Int

    public init(claude: ProviderUsage?, codex: ProviderUsage?, todayCostUsd: Double? = nil, todayCostSessions: Int = 0) {
        self.claude = claude
        self.codex = codex
        self.todayCostUsd = todayCostUsd
        self.todayCostSessions = todayCostSessions
    }
}

/// The daemon's answer to `POST /control/usage/claude-refresh`.
public struct ClaudeRefreshResult: Hashable, Sendable {
    public var claude: ProviderUsage?
    /// Answered from the cache because Refresh was pressed again inside a minute.
    public var throttled: Bool
    public var refreshed: Bool
    public var error: String?

    public init(claude: ProviderUsage?, throttled: Bool, refreshed: Bool, error: String? = nil) {
        self.claude = claude
        self.throttled = throttled
        self.refreshed = refreshed
        self.error = error
    }
}
