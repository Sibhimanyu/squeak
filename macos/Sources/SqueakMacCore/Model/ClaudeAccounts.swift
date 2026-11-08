import Foundation

/// The Claude accounts saved with `claude-swap`, as the daemon's `GET /control/claude-accounts` lists them (it reads
/// no token). `available` is false when the Mac cannot switch (no script, or fewer than two accounts).
public struct ClaudeAccountList: Decodable, Hashable, Sendable {
    public struct Account: Decodable, Hashable, Sendable, Identifiable {
        public var name: String
        public var email: String
        /// `organizationType`: `claude_pro`, `claude_team`, `claude_max`.
        public var plan: String
        public var id: String { name }

        public init(name: String, email: String, plan: String) {
            self.name = name; self.email = email; self.plan = plan
        }

        /// "Pro", "Team", "Max"; an unknown plan is worded from its name.
        public var planLabel: String {
            var words = plan
            if words.hasPrefix("claude_") { words.removeFirst("claude_".count) }
            words = words.replacingOccurrences(of: "_", with: " ").trimmingCharacters(in: .whitespaces)
            return words.isEmpty ? "Claude" : words.prefix(1).uppercased() + words.dropFirst()
        }
    }

    public var available: Bool
    public var current: String?
    public var accounts: [Account]

    public init(available: Bool, current: String?, accounts: [Account]) {
        self.available = available; self.current = current; self.accounts = accounts
    }
}

public enum ClaudeAccountOutcome: Equatable, Sendable {
    case switched(current: String?)
    case refused(String)
    /// The daemon predates the route (404/503).
    case outdated
}
