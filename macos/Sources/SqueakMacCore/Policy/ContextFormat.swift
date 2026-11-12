import Foundation

/// The composer's context ring: token counts as "142k" / "1M", the tooltip, and the colour level.
public enum ContextFormat {
    public enum Level: Sendable, Equatable { case normal, warning, danger }

    public static let warnAt: Double = 80
    public static let dangerAt: Double = 95

    /// Percent used (capped at 100); nil when either number is missing or the window is empty (never a fake 0%).
    public static func percent(tokens: Int?, limit: Int?) -> Double? {
        guard let tokens, let limit, limit > 0, tokens >= 0 else { return nil }
        return min(Double(tokens) / Double(limit) * 100, 100)
    }

    public static func level(_ percent: Double?) -> Level {
        guard let percent, percent.isFinite else { return .normal }
        return percent >= dangerAt ? .danger : percent >= warnAt ? .warning : .normal
    }

    /// 842 -> "842", 142_000 -> "142k", 1_500 -> "1.5k", 1_000_000 -> "1M".
    public static func tokens(_ n: Int) -> String {
        func trim(_ v: Double, _ unit: String) -> String {
            let r = (v * 10).rounded() / 10
            return (r == r.rounded() ? String(Int(r)) : String(r)) + unit
        }
        if n >= 1_000_000 { return trim(Double(n) / 1_000_000, "M") }
        if n >= 1_000 { return trim(Double(n) / 1_000, "k") }
        return String(n)
    }

    /// "Context: 142k of 1M tokens (14%)", with the auto-compact line.
    public static func tooltip(tokens used: Int, limit: Int) -> String? {
        guard let p = percent(tokens: used, limit: limit) else { return nil }
        return "Context: \(tokens(used)) of \(tokens(limit)) tokens (\(Int(p.rounded()))%)\nCompacts automatically near the limit"
    }

    /// What the ring's popover says, decided here so the view only draws it. Numbers come from the host (tokens, window)
    /// or the daemon (percent); nothing is guessed, and the auto-compact line is the agent's own, without a number.
    public struct Popover: Sendable, Equatable {
        public var usage: String?
        public var percentText: String?
        public var fraction: Double
        public var level: Level
        public var windowLine: String?
        public var autoLine: String
        /// nil: no Compact action is offered (not a native chat). Otherwise whether it can run now, and why not.
        public var compact: CompactState?

        public enum CompactState: Sendable, Equatable { case ready, disabled(String) }

        public static let workingReason = "The chat is working. Compact it when it finishes."
        public static let compactHint = "Compact now: the agent summarises the chat to free room"

        public static func make(tokens: Int?, limit: Int?, percent: Double?, canCompact: Bool, working: Bool) -> Popover {
            let p = Self.percent(tokens: tokens, limit: limit) ?? percent
            let usage: String? = {
                guard let tokens else { return nil }
                if let limit, limit > 0 { return "\(Self.tokens(tokens)) / \(Self.tokens(limit))" }
                return "\(Self.tokens(tokens)) used"
            }()
            let state: CompactState? = canCompact ? (working ? .disabled(workingReason) : .ready) : nil
            return Popover(
                usage: usage,
                percentText: p.map { String(format: "%.1f%%", $0) },
                fraction: min(max(p ?? 0, 0), 100) / 100,
                level: level(p),
                windowLine: limit.flatMap { $0 > 0 ? "Window: \(Self.tokens($0)) tokens" : nil },
                autoLine: "Compacts automatically near the limit",
                compact: state)
        }

        private static func tokens(_ n: Int) -> String { ContextFormat.tokens(n) }
        private static func percent(tokens: Int?, limit: Int?) -> Double? { ContextFormat.percent(tokens: tokens, limit: limit) }
        private static func level(_ p: Double?) -> Level { ContextFormat.level(p) }
    }
}
