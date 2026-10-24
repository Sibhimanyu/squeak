import Foundation
import Security

/// Detailed usage over one range, as the Mac works it out from the agents' own files
/// (src/fleet/usage-stats.ts): tokens by kind, an estimated Claude cost, sessions, active days and
/// streaks, the favourite model, the busiest hour, the longest session and the top projects. It
/// arrives only in a `stats` command's result, never in the published view.
public struct UsageStatsView: Codable, Equatable, Sendable {
    public struct Totals: Codable, Equatable, Sendable {
        public let tokens: Int
        public let input: Int
        public let output: Int
        public let cacheRead: Int
        public let cacheWrite: Int
        public let messages: Int
        public let sessions: Int
        /// Claude only, an estimate; nil when nothing in range was priced.
        public let costUsd: Double?
    }
    public struct Model: Codable, Equatable, Sendable, Identifiable {
        public let model: String
        /// "claude" or "codex".
        public let agent: String
        public let tokens: Int
        /// 0–1 of the range's tokens.
        public let share: Double
        public let costUsd: Double?
        public var id: String { model }
    }
    public struct Day: Codable, Equatable, Sendable, Identifiable {
        /// Local date, YYYY-MM-DD.
        public let date: String
        public let tokens: Int
        public var id: String { date }
    }
    public struct Project: Codable, Equatable, Sendable, Identifiable {
        public let name: String
        public let tokens: Int
        public var id: String { name }
    }
    public struct LongestSession: Codable, Equatable, Sendable {
        public let minutes: Int
        public let project: String?
    }
    /// Claude Code's own record over the same range (what its `/stats` shows), for comparison.
    public struct ClaudeCodeRecord: Codable, Equatable, Sendable {
        public let tokens: Int
        public let sessions: Int
        public let messages: Int
        public let since: String?
        public let through: String?
    }

    /// "7d", "30d" or "all".
    public let range: String
    /// "claude" or "codex"; nil from a Mac that answered both together.
    public let agent: String?
    /// The earliest day with data for this agent; nil when none (or from an older Mac).
    public let since: String?
    /// Claude only: how many days Claude Code keeps a conversation's file, and from which day all are there.
    public let keepDays: Int?
    public let keptFrom: String?
    public let claudeCodeRecord: ClaudeCodeRecord?
    public let computedAt: String
    /// Files the Mac is still reading for the first time; the numbers grow until 0.
    public let pending: Int
    public let totals: Totals
    public let activeDays: Int
    public let currentStreak: Int
    public let longestStreak: Int
    public let favoriteModel: String?
    /// 0–23, local to the Mac.
    public let peakHour: Int?
    public let longestSession: LongestSession?
    public let models: [Model]
    public let daily: [Day]
    public let projects: [Project]
}

/// A signed ask for detailed usage over one range. Reaches no agent.
public struct StatsCommand: Codable, Equatable, Sendable {
    public let v: Int
    public let kind: String
    /// "7d", "30d" or "all".
    public let range: String
    /// "claude" or "codex".
    public let agent: String
    public let nonce: String
    /// Epoch milliseconds.
    public let expiresAt: Int64
}

extension Channel {
    /// The signed document asking the Mac for one agent's detailed usage over `range`.
    public func statsDocument(range: String, agent: String, signer: CommandSigner, now: Date = Date()) throws -> (id: String, document: ChannelDocument) {
        var nonce = Data(count: 16)
        _ = nonce.withUnsafeMutableBytes { SecRandomCopyBytes(kSecRandomDefault, 16, $0.baseAddress!) }
        let command = StatsCommand(
            v: 1, kind: "stats", range: range, agent: agent,
            nonce: nonce.map { String(format: "%02x", $0) }.joined(),
            expiresAt: Int64((now.timeIntervalSince1970 + Self.commandLifetime) * 1000)
        )
        let box = try ChannelCrypto.seal(command, key: pairing.k)
        let id = UUID().uuidString.lowercased()
        return (id, ChannelDocument(box: box, sig: try signer.sign(box), device: deviceId))
    }
}

/// The words of Usage › Details, kept here so they are tested on the Mac too.
public enum UsageStatsFormat {
    /// 13,900,186,405 → "13.9B"; 2,994,740 → "3.0M"; 912 → "912".
    public static func tokens(_ n: Int) -> String {
        let value = Double(n)
        switch value {
        case 1e9...: return String(format: "%.1fB", value / 1e9)
        case 1e6...: return String(format: "%.1fM", value / 1e6)
        case 1e4...: return String(format: "%.0fK", value / 1e3)
        case 1e3...: return String(format: "%.1fK", value / 1e3)
        default: return "\(n)"
        }
    }

    /// "$4,128" above $100, "$12.40" below; nil stays nil (unpriced is not free).
    public static func cost(_ usd: Double?) -> String? {
        guard let usd else { return nil }
        let formatter = NumberFormatter()
        formatter.numberStyle = .currency
        formatter.currencyCode = "USD"
        formatter.locale = Locale(identifier: "en_US")
        formatter.maximumFractionDigits = usd >= 100 ? 0 : 2
        return formatter.string(from: NSNumber(value: usd))
    }

    /// "17h 24m", "45m".
    public static func duration(minutes: Int) -> String {
        minutes >= 60 ? "\(minutes / 60)h \(minutes % 60)m" : "\(minutes)m"
    }

    /// 14 → "2 PM – 3 PM".
    public static func hour(_ h: Int) -> String {
        func label(_ hour: Int) -> String {
            let h12 = hour % 12 == 0 ? 12 : hour % 12
            return "\(h12) \(hour % 24 < 12 ? "AM" : "PM")"
        }
        return "\(label(h)) – \(label(h + 1))"
    }

    /// "claude-opus-5-5" → "Opus 5.5"; "gpt-6.1-sol" stays as Codex names it.
    public static func model(_ id: String) -> String {
        let parts = id.split(separator: "-").map(String.init)
        guard parts.first == "claude", parts.count >= 3 else { return id }
        let family = parts[1].prefix(1).uppercased() + parts[1].dropFirst()
        let version = parts.dropFirst(2).prefix(while: { $0.allSatisfy(\.isNumber) }).joined(separator: ".")
        return version.isEmpty ? family : "\(family) \(version)"
    }

    /// "2026-09-24" → "24 Sep"; nil stays nil.
    public static func day(_ date: String?) -> String? {
        guard let date else { return nil }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_GB")
        f.dateFormat = "yyyy-MM-dd"
        guard let parsed = f.date(from: date) else { return nil }
        f.dateFormat = "d MMM"
        return f.string(from: parsed)
    }

    /// Where an agent's numbers come from and how far back they go, in one paragraph for the page.
    public static func source(_ s: UsageStatsView) -> String {
        if s.agent == "codex" {
            let since = day(s.since).map { " Its logs go back to \($0)." } ?? ""
            return "Counted from Codex's session logs on your Mac (~/.codex/sessions): the Codex CLI, Codex in the ChatGPT app, and Codex chats run from Conductor.\(since) Codex isn't priced here; your ChatGPT plan's limits are on the Usage page."
        }
        let keep = s.keepDays ?? 30
        let from = day(s.keptFrom).map { " so All time here starts around \($0)" } ?? ""
        return "Counted from Claude Code's conversation files on your Mac (~/.claude/projects): the Terminal, Conductor's chats and the Claude app's Code tab. Claude Code deletes each file after \(keep) days,\(from). Each message is counted once, which is what you're billed for; the cost is an estimate at API rates."
    }

    /// Why Claude Code's own number is bigger, in one sentence.
    public static func recordNote(_ r: UsageStatsView.ClaudeCodeRecord) -> String {
        let since = day(r.since).map { " since \($0)" } ?? ""
        return "Claude Code's /stats counts \(tokens(r.tokens)) tokens\(since). It keeps its count after the files are deleted, but adds up every copy Claude saves of a message as it writes, about twice the tokens actually used."
    }

    /// "1 day", "12 days".
    public static func days(_ n: Int) -> String { n == 1 ? "1 day" : "\(n) days" }
}
