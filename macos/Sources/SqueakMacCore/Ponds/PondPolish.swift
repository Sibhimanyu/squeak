import Foundation

// Small first-Pond helps (the owner-approved polish after the first-Pond journey): the always-visible "Make task", the
// one-time "next steps" card, the one-time "Put this on GitHub?" line, the Share-a-duck words and what a clone says about
// GitHub. Pure decisions and words; views draw what comes back. Same in the old and the new layout.

// MARK: One-time things, per Pond

/// What a person dismissed or acted on, once per Pond. Persists in `UserDefaults`; never shows again after.
public struct PondOnce {
    public enum Thing: String, Sendable { case nextSteps, gitHubLine }

    private let defaults: UserDefaults
    public init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    private func name(_ thing: Thing, _ pond: String) -> String { "pondOnce.\(thing.rawValue).\(pond)" }
    public func done(_ thing: Thing, pond: String) -> Bool { defaults.bool(forKey: name(thing, pond)) }
    public func markDone(_ thing: Thing, pond: String) { defaults.set(true, forKey: name(thing, pond)) }
}

// MARK: Next steps card (Dashboard)

public enum PondNextSteps {
    public struct Steps: Equatable, Sendable {
        public var startDuck: Bool
        public var invite: Bool
        public var gitHub: Bool
        public var isEmpty: Bool { !(startDuck || invite || gitHub) }
    }

    public static let title = "Next steps"
    public static let startDuck = "Start a duck"
    public static let invite = "Invite someone"
    public static let gitHub = "Put it on GitHub"
    public static let dismiss = "Dismiss"

    /// The steps still worth showing, or nil: the card is gone for good once dismissed, and while nothing is left to do.
    /// Start a duck while there are no ducks; Invite for the owner while nobody else is in; GitHub only for a folder Pond
    /// on this Mac (the same "Make it a Git Pond" flow).
    public static func steps(dismissed: Bool, canStartDuck: Bool, hasDucks: Bool, canInvite: Bool, memberCount: Int, plainFolder: Bool, isRemote: Bool) -> Steps? {
        guard !dismissed else { return nil }
        let s = Steps(
            startDuck: canStartDuck && !hasDucks,
            invite: canInvite && !isRemote && memberCount <= 1,
            gitHub: plainFolder && !isRemote)
        return s.isEmpty ? nil : s
    }
}

// MARK: "Put this on GitHub?" (Room)

public enum PondGitHubLine {
    public static let text = "Put this on GitHub?"
    public static let action = "Put it on GitHub\u{2026}"
    public static let dismiss = "Not now"

    /// True once any duck has finished a turn or a Task in the Pond.
    public static func firstDuckFinished(turns: [RoomTurn], tasks: [RoomTask]) -> Bool {
        turns.contains { $0.outcome == .finished } || tasks.contains { $0.state == .done }
    }

    /// One quiet line, once per Pond: a folder Pond on this Mac, after the first duck finished, not yet dismissed or acted on.
    public static func shows(plainFolder: Bool, isRemote: Bool, firstDuckFinished: Bool, dismissed: Bool) -> Bool {
        plainFolder && !isRemote && firstDuckFinished && !dismissed
    }
}

// MARK: Make task, always visible on the latest message

public enum MakeTaskAffordance {
    /// The post id of the newest person message that can be made a Task; that one shows "Make task" at rest, the rest on hover.
    public static func latestPostId(in items: [RoomItem]) -> String? {
        for item in items.reversed() {
            guard case .group(let g) = item, g.author.kind != .duck else { continue }
            for m in g.messages.reversed() where m.canMakeTask { if let id = m.postId { return id } }
        }
        return nil
    }

    public static func isShown(postId: String?, latest: String?, hovering: Bool) -> Bool {
        hovering || (postId != nil && postId == latest)
    }
}

// MARK: Share a duck's chat

public enum ShareDuckWords {
    /// Not "Share a duck": that read as sharing the Pond (which is Invite).
    public static let menu = "Share this duck\u{2019}s chat\u{2026}"
    public static let helpEnabled = "Show the chat of one of this Mac\u{2019}s ducks to the flock. To bring a person in, use Invite."
    public static let helpNone = "No chats on this Mac to share yet"
    public static let helpAllShared = "Every duck on this Mac is already in the pond"
}

// MARK: Clone: which GitHub sign-in

/// `GET /native/github/status[?repo=]`: the `gh` sign-in this Mac uses, and for a repo whether it is private.
public struct GitHubSignIn: Equatable, Sendable, Decodable {
    public var ok: Bool
    public var login: String?
    public var reason: String?
    public var repo: String?
    public var visibility: String?

    public init(ok: Bool, login: String? = nil, reason: String? = nil, repo: String? = nil, visibility: String? = nil) {
        self.ok = ok; self.login = login; self.reason = reason; self.repo = repo; self.visibility = visibility
    }
}

public enum CloneSignIn {
    /// The line in the clone choice. nil while it is not known yet (nothing is claimed).
    public static func line(_ s: GitHubSignIn?) -> String? {
        guard let s else { return nil }
        if s.ok, let login = s.login, !login.isEmpty { return "Signed in to GitHub as \(login) (the gh sign-in on this Mac)." }
        if s.ok { return "Signed in to GitHub (the gh sign-in on this Mac)." }
        if s.reason == "not-installed" { return "Not signed in to GitHub. Install gh from cli.github.com, run gh auth login in Terminal, then try again." }
        return "Not signed in to GitHub. Run gh auth login in Terminal to clone private repositories."
    }

    /// A private repository is confirmed before it is cloned; anything not known to be private clones straight away.
    public static func asksBeforeCloning(_ s: GitHubSignIn?) -> Bool { s?.ok == true && s?.visibility == "private" }

    public static func privateQuestion(repo: String?, login: String?) -> String {
        "\(repo ?? "This repository") is private."
    }

    public static func privateMessage(login: String?) -> String {
        login.map { "Squeak will clone it with the GitHub sign-in of \($0) on this Mac." } ?? "Squeak will clone it with the GitHub sign-in on this Mac."
    }

    public static let cloneButton = "Clone"
}
