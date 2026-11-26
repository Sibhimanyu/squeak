import Foundation

// DESIGN.md 8.12, the Pond's Dashboard (docs/spec.md "Pond journey and Dashboard"). Everything the page decides lives here,
// where CI can test it: the one state line, which buttons a role may press (and why a closed one is closed), what the
// ⋯ menu holds, which blocks draw, and the order of the Ducks. The view only draws what comes back.

/// The Pond's connection, the last word of the state line.
public enum PondConnection: Sendable, Equatable {
    case live
    case reconnecting
    case ownerOffline

    /// From the one freshness value the page already holds. The Owner's own Mac is never "offline" to the Owner.
    public static func of(_ freshness: PondFreshness, role: PondRole) -> PondConnection {
        switch freshness {
        case .live, .reading, .refreshing: .live
        case .offline: role == .owner ? .reconnecting : .ownerOffline
        case .couldntRead, .stale: .reconnecting
        }
    }
}

/// What the Dashboard header says and offers, for one person in one Pond.
public struct PondDashboardHeader: Sendable, Equatable {
    public struct Facts: Sendable, Equatable {
        public var role: PondRole
        /// The directory knows the Pond (an invite, a rename and a delete need it).
        public var hasPond: Bool
        /// Only on this Mac: never shared yet.
        public var isLocal: Bool
        /// A folder Pond (no Git remote) on this Mac.
        public var plainFolder: Bool
        /// Someone else's Pond, run on their Mac.
        public var isRemote: Bool
        public var ownerName: String?
        /// People in the Pond, the Owner included.
        public var people: Int
        public var connection: PondConnection
        /// The chrome's word on starting a Duck here.
        public var start: PondChrome.Start
        /// This Mac cannot start a Duck of its own here right now (the host says why); the button stays and says it.
        public var startBlockedReason: String?
        /// Writes (Invite, rename, delete) wait while the Pond is unreachable.
        public var canWrite: Bool

        public init(
            role: PondRole, hasPond: Bool = true, isLocal: Bool = false, plainFolder: Bool = false, isRemote: Bool = false,
            ownerName: String? = nil, people: Int = 1, connection: PondConnection = .live, start: PondChrome.Start = .own,
            startBlockedReason: String? = nil, canWrite: Bool = true
        ) {
            self.role = role; self.hasPond = hasPond; self.isLocal = isLocal; self.plainFolder = plainFolder; self.isRemote = isRemote
            self.ownerName = ownerName; self.people = people; self.connection = connection; self.start = start
            self.startBlockedReason = startBlockedReason; self.canWrite = canWrite
        }
    }

    /// The primary button: pressed, or drawn closed with its reason (never silently missing while a role could ask).
    public enum Start: Sendable, Equatable {
        case open(label: String, help: String)
        case closed(reason: String)
        case hidden
    }

    public enum MenuItem: String, Sendable, Equatable { case settings, notebook, rename, leave, delete }

    public var stateLine: String
    public var start: Start
    public var showsInvite: Bool
    public var inviteDisabledReason: String?
    public var showsPutOnGitHub: Bool
    /// One quiet line under the header when a control is closed ("You can view this Pond. Ask Sibhi to make you a Member.").
    public var closedLine: String?
    public var menu: [MenuItem]

    public static let startLabel = "Start a duck"

    public static func make(_ f: Facts) -> PondDashboardHeader {
        let owner = ownerWord(f.ownerName)
        let connection: String = switch f.connection {
        case .live: "Live"
        case .reconnecting: "Reconnecting\u{2026}"
        case .ownerOffline: "\(owner)\u{2019}s Mac offline"
        }

        let line: String
        if f.role == .owner && !f.isRemote {
            if f.isLocal { line = "Only on this Mac" }
            else if f.connection == .live { line = "Shared with \(people(f.people)) \u{00B7} Live" }
            else { line = "Shared with \(people(f.people)) \u{00B7} \(connection)" }
        } else {
            line = "\(owner)\u{2019}s Pond \u{00B7} \(f.role.word) \u{00B7} \(connection)"
        }

        var start: Start
        var closedLine: String?
        switch f.start {
        case .own:
            start = .open(label: startLabel, help: "Start a duck in this Pond")
        case .askOwner:
            start = .open(label: startLabel, help: "Asks \(owner) to start it on their Mac")
        case .hidden:
            start = .closed(reason: f.role == .viewer ? viewerLine(f.ownerName) : "Ask \(owner) to let you start Ducks.")
        }
        if f.role == .viewer { start = .closed(reason: viewerLine(f.ownerName)) }
        if case .open = start, let why = f.startBlockedReason { start = .closed(reason: why) }
        if case .closed(let reason) = start { closedLine = reason }

        let owns = f.role == .owner && !f.isRemote
        var menu: [MenuItem] = [.settings, .notebook]
        if owns { if f.hasPond { menu += [.rename, .delete] } } else if f.isRemote || f.role != .owner { menu.append(.leave) }

        return PondDashboardHeader(
            stateLine: line, start: start,
            showsInvite: owns && f.hasPond,
            inviteDisabledReason: f.canWrite ? nil : "Squeak can\u{2019}t reach the Pond right now. Invite works again when it\u{2019}s back.",
            showsPutOnGitHub: owns && f.plainFolder,
            closedLine: closedLine, menu: menu)
    }

    public static func viewerLine(_ ownerName: String?) -> String {
        "You can view this Pond. Ask \(ownerWord(ownerName)) to make you a Member."
    }

    static func ownerWord(_ name: String?) -> String {
        let n = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return n.isEmpty ? "The owner" : n
    }

    private static func people(_ n: Int) -> String { "\(max(n, 2)) people" }
}

// MARK: Avatars

/// The header's small avatars: people first (you first), pending invites after them as outlined ones, capped with "+N".
public struct PondAvatarRow: Sendable, Equatable {
    public enum Item: Sendable, Equatable, Identifiable {
        case person(id: String, name: String, you: Bool)
        case pending(index: Int)
        public var id: String {
            switch self {
            case .person(let id, _, _): "p:" + id
            case .pending(let i): "i:\(i)"
            }
        }
    }

    public var items: [Item]
    /// People and invites beyond the cap, drawn "+N".
    public var more: Int
    public static let cap = 5

    public static func build(people: [(id: String, name: String, you: Bool)], pendingInvites: Int, cap: Int = PondAvatarRow.cap) -> PondAvatarRow {
        let ordered = people.sorted { ($0.you ? 0 : 1) < ($1.you ? 0 : 1) }
        var all: [Item] = ordered.map { .person(id: $0.id, name: $0.name, you: $0.you) }
        all += (0..<max(pendingInvites, 0)).map { .pending(index: $0) }
        return PondAvatarRow(items: Array(all.prefix(cap)), more: max(all.count - cap, 0))
    }
}

// MARK: Ducks

/// The Dashboard's one list of Ducks: working first, then the rest most recent first; Off duty folded at the end
/// (DESIGN.md 8.12 allows this one state-based order; every other list stays newest first and never moves by state).
public struct PondDuckSections: Sendable, Equatable {
    public var onDuty: [PondChatRow]
    public var offDuty: [PondChatRow]

    public static func isWorking(_ row: PondChatRow) -> Bool {
        row.onDuty && (row.state == .working || (row.statusLine == nil && row.ducklingsRunning > 0))
    }

    public static func build(_ layout: PondHomeLayout) -> PondDuckSections { build(layout.threads) }

    public static func build(_ rows: [PondChatRow]) -> PondDuckSections {
        func recent(_ a: PondChatRow, _ b: PondChatRow) -> Bool {
            let x = a.lastAt ?? .distantPast, y = b.lastAt ?? .distantPast
            return x != y ? x > y : a.title.localizedCompare(b.title) == .orderedAscending
        }
        let on = rows.filter(\.onDuty), off = rows.filter { !$0.onDuty }
        let working = on.filter(isWorking).sorted(by: recent)
        let rest = on.filter { !isWorking($0) }.sorted(by: recent)
        return PondDuckSections(onDuty: working + rest, offDuty: off.sorted(by: recent))
    }

    public var isEmpty: Bool { onDuty.isEmpty && offDuty.isEmpty }
    public var count: Int { onDuty.count + offDuty.count }
}

// MARK: Needs you

/// One thing that waits on this person, drawn as one row in "Needs you".
public struct PondDashboardNeedsYouItem: Sendable, Equatable, Identifiable {
    public enum Kind: Sendable, Equatable {
        /// A Duck's question, approval or failure: Open goes to the Duck.
        case duck(rowId: String)
        /// A Member's Task waiting on the Owner: Approve, Decline.
        case taskApproval(taskId: String)
        /// The Owner's own Task blocked on something: Open the Room.
        case taskBlocked(taskId: String)
        /// A Member's own Task waiting for the Owner: words only, the Member has no control over it.
        case taskWaiting(taskId: String)
        /// A Duck a Member asked for, waiting on the Owner: Approve starts it, Decline tells the Member.
        case startApproval(requestId: String)
        /// A Member's own Duck waiting for the Owner: words only.
        case startWaiting(requestId: String)
        case join(requestId: String)
    }

    public var kind: Kind
    public var title: String
    public var line: String
    /// The amber triangle: it needs a decision from this person (a Member waiting on someone else does not).
    public var needsDecision: Bool
    public var id: String {
        switch kind {
        case .duck(let id): "duck:" + id
        case .taskApproval(let id), .taskBlocked(let id), .taskWaiting(let id): "task:" + id
        case .startApproval(let id), .startWaiting(let id): "start:" + id
        case .join(let id): "join:" + id
        }
    }
}

public enum PondDashboardNeedsYou {
    /// Ducks that need the person, then Ducks Members asked for, then Tasks, then people asking to join. Only what the
    /// host already says. A Member's Tasks and Ducks always wait for the Owner: the Owner decides, the Member reads
    /// "Waiting for Sibhi".
    public static func build(
        rows: [PondChatRow], tasks: [RoomTask], joins: [JoinRequest], role: PondRole, ownerName: String?,
        starts: [PondPendingStart] = []
    ) -> [PondDashboardNeedsYouItem] {
        var out: [PondDashboardNeedsYouItem] = []
        for r in rows where r.needsYou && !r.isFlock {
            let name = r.heading ?? r.title
            let line = r.failed ? (r.failureText.map { "Failed: \($0)" } ?? "Failed") : (r.statusLine ?? "Needs you")
            out.append(PondDashboardNeedsYouItem(kind: .duck(rowId: r.id), title: name, line: line, needsDecision: true))
        }
        for s in starts {
            let title = s.title.isEmpty ? "A new duck" : s.title
            if role == .owner, !s.mine {
                let who = s.name.isEmpty ? "A Member" : s.name
                out.append(PondDashboardNeedsYouItem(kind: .startApproval(requestId: s.requestId), title: title, line: "\(who) asked for this Duck", needsDecision: true))
            } else if s.mine {
                out.append(PondDashboardNeedsYouItem(
                    kind: .startWaiting(requestId: s.requestId), title: title, line: "Waiting for \(PondDashboardHeader.ownerWord(ownerName))", needsDecision: false))
            }
        }
        for t in tasks where t.state == .waiting && !t.proposed {
            guard let who = t.approvalName else { continue }
            if role == .owner {
                out.append(PondDashboardNeedsYouItem(kind: .taskApproval(taskId: t.id), title: t.title, line: "\(who) asked for this Task", needsDecision: true))
            } else {
                out.append(PondDashboardNeedsYouItem(
                    kind: .taskWaiting(taskId: t.id), title: t.title, line: "Waiting for \(PondDashboardHeader.ownerWord(ownerName))", needsDecision: false))
            }
        }
        if role == .owner {
            for t in tasks where t.state == .blocked {
                out.append(PondDashboardNeedsYouItem(kind: .taskBlocked(taskId: t.id), title: t.title, line: "Blocked", needsDecision: true))
            }
            for j in joins {
                out.append(PondDashboardNeedsYouItem(kind: .join(requestId: j.id), title: j.displayName, line: "Asked to join as a \(j.role.word.lowercased())", needsDecision: true))
            }
        }
        return out
    }
}

// MARK: Latest in the Room

/// The last few Room lines on the Dashboard: people's messages and the Ducks' reports, newest last, one line each.
public struct PondLatestLine: Sendable, Equatable, Identifiable {
    public var id: String
    public var author: String
    public var text: String
    public var at: Date
}

public enum PondLatest {
    public static let limit = 3

    /// Posts at the Room's level only (Duck-to-Duck traffic is not for the Dashboard), at most `limit`, oldest first so the
    /// last line is the newest. Blank text is skipped; a line is the post's first line.
    public static func build(_ posts: [RoomPost], limit: Int = PondLatest.limit) -> [PondLatestLine] {
        let lines: [PondLatestLine] = posts.sorted { $0.seq < $1.seq }.compactMap { p in
            guard p.level == .room, p.kind != .working else { return nil }
            let first = p.text.split(whereSeparator: \.isNewline).first.map(String.init)?.trimmingCharacters(in: .whitespaces) ?? ""
            guard !first.isEmpty else { return nil }
            return PondLatestLine(id: p.id, author: p.author.name, text: first, at: Date(timeIntervalSince1970: Double(p.at) / 1000))
        }
        return Array(lines.suffix(limit))
    }
}

// MARK: Blocks

/// Which blocks of the body draw: each only when it has something. A new Pond's empty Ducks block is the only guide.
public struct PondDashboardBlocks: Sendable, Equatable {
    public var needsYou: Bool
    public var ducks: Bool
    public var offDuty: Bool
    public var latest: Bool
    /// No Ducks at all: the brand duck and one sentence, and nothing else to press.
    public var emptyGuide: Bool

    public static func of(needsYou: Int, ducks: PondDuckSections, latest: Int) -> PondDashboardBlocks {
        PondDashboardBlocks(
            needsYou: needsYou > 0, ducks: !ducks.onDuty.isEmpty, offDuty: !ducks.offDuty.isEmpty, latest: latest > 0, emptyGuide: ducks.isEmpty)
    }

    /// The one sentence under the duck in an empty Ducks block, for the role.
    public static func emptySentence(role: PondRole) -> String {
        switch role {
        case .owner: "No ducks yet. Start one and it gets to work in this Pond."
        case .member: "No ducks here yet. Start one and it goes to the Owner to approve."
        case .viewer: "No ducks to see yet."
        }
    }
}
