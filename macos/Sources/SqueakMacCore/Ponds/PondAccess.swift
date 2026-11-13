import Foundation

// DESIGN.md §8.10, a shared pond works exactly like one's own. What differs is who may do what on a thread someone
// else started, and this file is the one place those rules live (docs/ponds.md, "Permissions"). Pure: the views draw
// what it says and decide nothing. The daemon enforces the same rules on the wire; this is only how they read.

/// What this person can do on one thread, from their pond role and whether the thread is theirs.
public struct ThreadAccess: Sendable, Equatable {
    public enum Action: String, Sendable, CaseIterable {
        /// Say something, steer a working agent, answer its question: a member's, on any thread they can see.
        case message, steer, answer
        /// Read the thread's changes.
        case viewChanges
        /// Kept by the starter, on the starter's own Mac: neither exists as a command on the wire.
        case approve, stop
        /// Only the starter decides who sees a thread.
        case togglePrivate
    }

    /// One control's state: `enabled` false draws it disabled, with `tooltip` as the reason (nil = no control at all).
    public struct Gate: Sendable, Equatable {
        public var enabled: Bool
        public var tooltip: String?
        public var visible: Bool
    }

    /// The composer: open, or one muted line in its place.
    public enum Composer: Sendable, Equatable {
        case open(placeholder: String)
        case watchOnly(line: String)
        /// A chat that runs without asking: only its starter may message it.
        case closed(reason: String)
    }

    public static let watchLine = "You can watch this pond"

    public var role: PondRole
    public var isMine: Bool
    public var starterName: String
    /// False when the chat runs without asking (`permissionMode`): other members cannot message it. Nil from an older host.
    public var asks: Bool?

    public init(role: PondRole, starter: String, me: String?, starterName: String, asks: Bool? = nil) {
        self.role = role
        self.isMine = me != nil && starter == me
        self.starterName = starterName.trimmingCharacters(in: .whitespaces)
        self.asks = asks
    }

    private var starter: String { starterName.isEmpty ? "the starter" : starterName }

    /// A viewer watches; a member (or owner) messages. Someone else's thread that runs without asking takes only its starter.
    public func composer(working: Bool) -> Composer {
        if !role.canMessage { return .watchOnly(line: Self.watchLine) }
        if asks == false, !isMine {
            return .closed(reason: "Only \(starter) can message this thread while it runs without asking.")
        }
        return .open(placeholder: working ? "Message, \u{21B5} queue \u{00B7} \u{2318}\u{21B5} steer" : "Message")
    }

    public func gate(_ action: Action) -> Gate {
        switch action {
        case .message, .steer, .answer:
            let ok: Bool
            switch composer(working: false) {
            case .open: ok = true
            case .watchOnly, .closed: ok = false
            }
            return Gate(enabled: ok, tooltip: ok ? nil : (role.canMessage ? "Only \(starter) can message this thread while it runs without asking." : Self.watchLine), visible: true)
        case .viewChanges:
            return Gate(enabled: true, tooltip: nil, visible: true)
        case .approve:
            return Gate(enabled: isMine, tooltip: isMine ? nil : "Only \(starter) can approve on their thread", visible: true)
        case .stop:
            return Gate(enabled: isMine, tooltip: isMine ? nil : "Only \(starter) can stop on their thread", visible: true)
        case .togglePrivate:
            return Gate(enabled: isMine, tooltip: nil, visible: isMine)
        }
    }

    public var canAnswer: Bool { gate(.answer).enabled }
}

/// How a thread that is not mine says so: its tab and its header (DESIGN.md §8.10). Nothing for my own thread.
public enum ThreadOwnership {
    /// "Aarav\u{2019}s thread \u{00B7} runs on their Mac"; nil for a thread of mine.
    public static func line(starterName: String, isMine: Bool) -> String? {
        guard !isMine else { return nil }
        let name = starterName.trimmingCharacters(in: .whitespaces)
        return name.isEmpty ? "A teammate\u{2019}s thread \u{00B7} runs on their Mac" : "\(name)\u{2019}s thread \u{00B7} runs on their Mac"
    }

    /// What a tab shows beside its title for a thread that is not mine: the starter's avatar. Nil for mine.
    public static func tabAvatar(starterId: String, starterName: String, isMine: Bool) -> AvatarSpec? {
        isMine ? nil : PondAvatars.spec(memberId: starterId, name: starterName)
    }

    /// The tab's tooltip: its title, then the ownership line.
    public static func tabHelp(title: String, starterName: String, isMine: Bool) -> String {
        [title.isEmpty ? "Thread" : title, line(starterName: starterName, isMine: isMine)].compactMap { $0 }.joined(separator: "\n")
    }
}

// MARK: Avatars

/// A person's avatar when there is no photo: initials on a colour derived from their member id, stable everywhere.
public struct AvatarSpec: Sendable, Equatable {
    public var initials: String
    /// Degrees; never in the duck's band (`PondTint.duckBand`).
    public var hue: Double
}

public enum PondAvatars {
    public static func spec(memberId: String, name: String) -> AvatarSpec {
        AvatarSpec(initials: initials(name), hue: PondTint.hue(for: memberId))
    }

    /// The first letters of the first and last words, uppercased; "?" for no name.
    public static func initials(_ name: String) -> String { PondSharing.initials(name) ?? "?" }
}

// MARK: Group chat

/// A thread where more than one person has spoken reads as a group chat: each human message gets a small avatar, mine on
/// the right, others on the left, the name once per run of consecutive messages from one person. The agent's replies stay
/// full width. A thread with one person talking is unchanged.
public enum GroupChat {
    public static let avatarSize: Double = 22

    public enum Side: Sendable, Equatable { case leading, trailing }

    public struct Message: Sendable, Equatable {
        public var author: String
        public var text: String
        public var at: Date?
        public var side: Side
        /// The name above the bubble: set only on the first message of a run by one person.
        public var showsName: Bool
        public var avatar: AvatarSpec
        public var isMine: Bool
    }

    public enum Entry: Sendable, Equatable, Identifiable {
        case message(id: Int, Message)
        /// Everything else, as the single-person transcript draws it.
        case plain(ThreadRow)

        public var id: Int {
            switch self {
            case .message(let id, _): id
            case .plain(let row): row.id
            }
        }
    }

    /// The member ids who wrote a human message; a message with no `by` is the starter's.
    public static func speakers(_ rows: [ThreadRow], starter: String) -> [String] {
        var seen: [String] = []
        for case .user(_, let by, _, _) in rows {
            let who = (by?.isEmpty == false ? by : nil) ?? starter
            if !seen.contains(who) { seen.append(who) }
        }
        return seen
    }

    /// More than one person has spoken (counting a message I have sent that the host has not shown yet).
    public static func isGroup(_ rows: [ThreadRow], starter: String, me: String? = nil, pendingMine: Bool = false) -> Bool {
        var who = Set(speakers(rows, starter: starter))
        if pendingMine, let me { who.insert(me) }
        return who.count > 1
    }

    /// The transcript as entries. In a single-person thread every row stays `.plain`.
    public static func lay(_ rows: [ThreadRow], starter: String, me: String?, nameOf: (String) -> String, pendingMine: Bool = false) -> [Entry] {
        guard isGroup(rows, starter: starter, me: me, pendingMine: pendingMine) else { return rows.map { .plain($0) } }
        var out: [Entry] = []
        var previous: String?
        for row in rows {
            guard case .user(let id, let by, let text, let at) = row else {
                previous = nil
                out.append(.plain(row))
                continue
            }
            let author = (by?.isEmpty == false ? by : nil) ?? starter
            let mine = me != nil && author == me
            out.append(.message(id: id, Message(
                author: author, text: text, at: at, side: mine ? .trailing : .leading, showsName: previous != author,
                avatar: PondAvatars.spec(memberId: author, name: nameOf(author)), isMine: mine)))
            previous = author
        }
        return out
    }

    /// What the name above a bubble says.
    public static func label(for message: Message, name: String) -> String { message.isMine ? "You" : (name.isEmpty ? "A teammate" : name) }
}
