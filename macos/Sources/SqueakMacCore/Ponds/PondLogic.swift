import Foundation

// DESIGN.md §8.10 and §9, Pond home and shared threads: what the views say, decided where CI can test it. The
// views only draw.

// MARK: Thread state and grouping

/// A thread's state as a pond home groups it.
public enum PondThreadState: Sendable, Equatable {
    case needsYou, working, finished, failed

    /// The host's word for the state (a Squeak chat's `awaiting_answer`, or `working`, `error`...). Unknown reads as
    /// finished: nothing is invented as waiting on a person.
    public init(raw: String) {
        switch NativeStatus.normalized(raw.lowercased()) {
        case "working", "running", "stopping": self = .working
        case "needs_you", "needsyou", "blocked", "waiting", "awaiting_answer", "awaiting_approval", "awaiting_plan": self = .needsYou
        case "error", "failed": self = .failed
        default: self = .finished
        }
    }

    public init(_ state: SessionState) {
        switch state {
        case .working: self = .working
        case .blocked: self = .needsYou
        case .error: self = .failed
        default: self = .finished
        }
    }

    /// A chat on this Mac: repeating a failing step reads as needing you.
    public init(_ s: HostSession) { self = s.isLoopingNow ? .needsYou : PondThreadState(s.state) }

    public var group: PondHomeGroup {
        switch self {
        case .needsYou: .needsYou
        case .working: .working
        case .finished, .failed: .done
        }
    }
}

public enum PondHomeGroup: String, Sendable, Equatable, CaseIterable {
    case needsYou, working, done

    /// The heading; "Needs you" is a name, the card still says what it waits on.
    public var title: String {
        switch self {
        case .needsYou: "Needs you"
        case .working: "Working"
        case .done: "Done"
        }
    }
}

/// One thread card on a pond's home, from a pond's thread or from a local chat.
public struct PondHomeThread: Sendable, Equatable, Identifiable {
    public var id: String
    public var title: String
    public var starter: String?
    public var starterName: String
    public var nest: String?
    public var agent: String?
    public var state: PondThreadState
    public var isPrivate: Bool
    public var updatedAt: Date?
    /// The local chat behind it, when this Mac runs it: opening it opens that chat.
    public var local: SessionKey?
    /// The thread's id in the pond; nil for a local thread not shared.
    public var pondThread: String?
}

public struct PondHomeSection: Sendable, Equatable, Identifiable {
    public var group: PondHomeGroup
    public var threads: [PondHomeThread]
    public var id: String { group.rawValue }
}

public enum PondHomeThreads {
    /// Needs you, Working, Done, in that order; a group with no threads is left out; newest first inside each, ties by title.
    public static func sections(_ threads: [PondHomeThread]) -> [PondHomeSection] {
        PondHomeGroup.allCases.compactMap { group in
            let list = threads.filter { $0.state.group == group }.sorted {
                let a = $0.updatedAt ?? .distantPast, b = $1.updatedAt ?? .distantPast
                return a != b ? a > b : $0.title.localizedCompare($1.title) == .orderedAscending
            }
            return list.isEmpty ? nil : PondHomeSection(group: group, threads: list)
        }
    }

    /// A pond's threads. A thread this Mac runs (`sessionId` matches a local chat) opens that chat; `localKey` finds it.
    /// A private thread is only on the list because this Mac's person started it (the host never sends the others).
    public static func fromPond(_ detail: PondDetail, localKey: (String) -> SessionKey?) -> [PondHomeThread] {
        detail.threads.map { t in
            PondHomeThread(
                id: t.id, title: t.title.isEmpty ? "Untitled thread" : t.title, starter: t.starter,
                starterName: t.starterName.isEmpty ? (detail.members.first { $0.id == t.starter }?.name ?? "") : t.starterName,
                nest: t.nest, agent: t.agent, state: PondThreadState(raw: t.state), isPrivate: t.isPrivate, updatedAt: t.updatedAt,
                local: t.starter == detail.meMember?.id ? t.sessionId.flatMap(localKey) : nil, pondThread: t.id)
        }
    }

    /// A project that is not in a pond yet: its local threads, started by you on this Mac.
    public static func fromLocal(_ facts: [PondThreadFact], agents: [SessionKey: String], person: String) -> [PondHomeThread] {
        facts.map { f in
            PondHomeThread(
                id: f.key.stringValue, title: f.title.isEmpty ? "Untitled thread" : f.title, starter: nil, starterName: person, nest: nil,
                agent: agents[f.key], state: PondThreadState(f.state), isPrivate: false, updatedAt: f.lastActivityAt, local: f.key, pondThread: nil)
        }
    }

    /// The count a pond shows beside its name in the sidebar and as a Needs you entry: threads waiting, and join
    /// requests only for an owner (nobody else can approve them).
    public static func needsYouCount(_ detail: PondDetail) -> Int {
        let threads = detail.threads.filter { PondThreadState(raw: $0.state) == .needsYou }.count
        return threads + (detail.myRole.canApproveJoins ? detail.joins.count : 0)
    }
}

// MARK: The flock

public enum PondFlock {
    /// You first, then who is online, then the rest, each by name.
    public static func ordered(_ members: [FlockMember], presence: [PondPresenceEntry]) -> [FlockMember] {
        let online = Set(presence.filter(\.online).map(\.member))
        func rank(_ m: FlockMember) -> Int { m.you ? 0 : (m.online || online.contains(m.id) ? 1 : 2) }
        return members.sorted { rank($0) != rank($1) ? rank($0) < rank($1) : $0.name.localizedCompare($1.name) == .orderedAscending }
    }

    public static func isOnline(_ m: FlockMember, presence: [PondPresenceEntry]) -> Bool {
        m.online || presence.contains { $0.member == m.id && $0.online }
    }

    /// The quiet line under a person: what they are doing, then their role and Nest.
    public static func line(for m: FlockMember, presence: [PondPresenceEntry], threads: [PondThread]) -> String {
        var parts: [String] = []
        let p = presence.first { $0.member == m.id }
        if p?.typingIn != nil {
            parts.append("Typing")
        } else if let id = p?.viewing, let title = threads.first(where: { $0.id == id })?.title, !title.isEmpty {
            parts.append("Viewing \(title)")
        } else {
            parts.append(isOnline(m, presence: presence) ? "Online" : (m.lastSeenAt.map { "Last seen \(PondMembers.ago($0, now: Date()))" } ?? ""))
        }
        parts = parts.filter { !$0.isEmpty }
        parts.append(m.role.word)
        if let machine = PondMembers.machine(m) { parts.append(machine) }
        return parts.joined(separator: " \u{00B7} ")
    }

    /// Others typing in a thread, for the composer's line ("Aarav is typing").
    public static func typingLine(in thread: String, members: [FlockMember], presence: [PondPresenceEntry], excluding me: String?) -> String? {
        let names = presence.filter { $0.isTyping(in: thread) && $0.member != me }
            .compactMap { p in members.first { $0.id == p.member }?.name }.filter { !$0.isEmpty }
        switch names.count {
        case 0: return nil
        case 1: return "\(names[0]) is typing"
        case 2: return "\(names[0]) and \(names[1]) are typing"
        default: return "\(names[0]), \(names[1]) and \(names.count - 2) more are typing"
        }
    }

    /// The people looking at this thread now, for its header.
    public static func viewers(of thread: String, members: [FlockMember], presence: [PondPresenceEntry], excluding me: String?) -> [FlockMember] {
        let ids = presence.filter { $0.viewing == thread && $0.online && $0.member != me }.map(\.member)
        return members.filter { ids.contains($0.id) }
    }
}

public enum PondRippleFeed {
    /// One sentence, never a member id: the host's text already names the actor; the actor's name is put in front only
    /// when the text does not start with it (an older host sends no name, and its text is shown as it is).
    static func sentence(of e: RippleEntry, me: String? = nil) -> String { PondRipples2.sentence(e, me: me) }

    /// The pond's own Ripples as panel Ripples: newest first, capped; a line with no time is left out.
    public static func build(_ entries: [RippleEntry], me: String? = nil, cap: Int = PondRipples.cap) -> [PondRipple] {
        entries.compactMap { e -> PondRipple? in
            guard let at = e.at, !e.text.isEmpty else { return nil }
            return PondRipple(id: "pond:\(e.id)", kind: .remote, sentence: sentence(of: e, me: me), at: at, threadKey: nil)
        }
        .sorted { $0.at != $1.at ? $0.at > $1.at : $0.id < $1.id }
        .prefix(max(0, cap)).map { $0 }
    }
}

// MARK: Holds

public enum PondHolds {
    /// A hold that has not run out.
    public static func live(_ holds: [PondHold], now: Date) -> [PondHold] {
        holds.filter { ($0.until ?? .distantFuture) > now }
    }

    /// The hold another member has on a question, if any.
    public static func other(_ requestId: String, holds: [PondHold], me: String?, now: Date) -> PondHold? {
        live(holds, now: now).first { $0.requestId == requestId && $0.by != me }
    }

    /// "Aarav is answering", shown while another member holds the question; nil when nobody else does.
    public static func line(_ requestId: String, holds: [PondHold], me: String?, now: Date) -> String? {
        guard let h = other(requestId, holds: holds, me: me, now: now) else { return nil }
        return "\(h.byName.isEmpty ? "Someone" : h.byName) is answering"
    }

    /// The words when an answer was refused because someone else holds the question.
    public static func refused(by name: String?) -> String {
        if let name, !name.isEmpty { return name.lowercased().contains("answering") ? name : "\(name) is answering" }
        return "Someone else is answering"
    }

    /// Holds last 30 s and are renewed while typing: renew once most of that has passed.
    public static let renewEvery: TimeInterval = 20
}

// MARK: Invites

public enum PondInviteText {
    /// An invite's life on the host (`INVITE_TTL`, 24 h).
    public static let lifetime: TimeInterval = 24 * 3600

    /// "Expires in 59 min", "Expires in 2 h"; "Expired" once past; nil when the host gave no expiry.
    public static func expiry(_ expiresAt: Date?, now: Date) -> String? {
        guard let expiresAt else { return nil }
        let left = expiresAt.timeIntervalSince(now)
        return left <= 0 ? "Expired" : "Expires in \(PondSentence.span(left))"
    }

    /// A pasted code, trimmed; the whole of it must be one run of characters (invite codes carry no spaces).
    public static func cleaned(_ pasted: String) -> String? {
        // A short code may be typed in any case, with a space or a dash or none (K7P-4QD): the host reads it either way.
        if let short = ShortCode.normalize(pasted) { return short }
        let t = pasted.trimmingCharacters(in: .whitespacesAndNewlines)
        return t.isEmpty || t.contains(where: \.isWhitespace) ? nil : t
    }

    /// A name is never typed: it is the signed-in account's (docs/ponds.md, "Names"), so a code is all joining needs.
    public static func canJoin(code: String) -> Bool { cleaned(code) != nil }
}

// MARK: A thread from someone else, as a transcript

public enum ThreadRow: Sendable, Equatable, Identifiable {
    case user(id: Int, by: String?, text: String, at: Date?)
    case agent(id: Int, text: String, at: Date?)
    /// The thinking and tool calls between two messages.
    case steps(id: Int, [ActivityStep])
    case question(id: Int, requestId: String, text: String, options: [String], resolved: Bool)
    case approval(id: Int, requestId: String, label: String, resolved: Bool)
    case changed(id: Int, files: Int, added: Int, removed: Int)

    public var id: Int {
        switch self {
        case .user(let i, _, _, _), .agent(let i, _, _), .steps(let i, _), .question(let i, _, _, _, _), .approval(let i, _, _, _), .changed(let i, _, _, _): i
        }
    }
}

public enum ThreadTimeline {
    /// The thread's events as transcript rows: messages, the steps between them as one row, questions and approvals
    /// (marked resolved once a `resolved` event names them), and what changed. `state` events set no row.
    public static func rows(_ events: [ThreadEvent]) -> [ThreadRow] {
        let ordered = events.sorted { $0.seq < $1.seq }
        let resolved = Set(ordered.compactMap { e -> String? in if case .resolved(let r) = e.kind { r } else { nil } })
        var rows: [ThreadRow] = []
        var steps: [ActivityStep] = []
        var stepsId = 0
        func flush() {
            if !steps.isEmpty { rows.append(.steps(id: stepsId, steps)); steps = [] }
        }
        for e in ordered {
            switch e.kind {
            case .thinking(let text):
                if steps.isEmpty { stepsId = e.seq }
                steps.append(ActivityStep(kind: "thinking", text: text, at: e.at))
            case .tool(let label, _):
                if steps.isEmpty { stepsId = e.seq }
                steps.append(ActivityStep(kind: "tool", text: label, at: e.at))
            case .user(let by, let text):
                flush(); rows.append(.user(id: e.seq, by: by, text: text, at: e.at))
            case .agent(let text):
                flush(); rows.append(.agent(id: e.seq, text: text, at: e.at))
            case .question(let r, let text, let options):
                flush(); rows.append(.question(id: e.seq, requestId: r, text: text, options: options, resolved: resolved.contains(r)))
            case .approval(let r, let label):
                flush(); rows.append(.approval(id: e.seq, requestId: r, label: label, resolved: resolved.contains(r)))
            case .changed(let files, let added, let removed, _):
                flush(); rows.append(.changed(id: e.seq, files: files, added: added, removed: removed))
            case .resolved, .state, .other: break
            }
        }
        flush()
        return rows
    }

    /// The thread's latest state word, from its newest `state` event.
    public static func latestState(_ events: [ThreadEvent]) -> PondThreadState? {
        events.sorted { $0.seq < $1.seq }.reversed().lazy.compactMap { e -> PondThreadState? in
            if case .state(let s) = e.kind { PondThreadState(raw: s) } else { nil }
        }.first
    }

    /// The newest question or approval nobody has resolved.
    public static func pending(_ events: [ThreadEvent]) -> ThreadRow? {
        rows(events).last {
            switch $0 {
            case .question(_, _, _, _, let resolved), .approval(_, _, _, let resolved): !resolved
            default: false
            }
        }
    }

    /// Merges a page into what is held: by `seq`, so a replay after a reconnect adds nothing twice.
    public static func merge(_ held: [ThreadEvent], _ page: [ThreadEvent]) -> [ThreadEvent] {
        var bySeq = Dictionary(held.map { ($0.seq, $0) }, uniquingKeysWith: { _, new in new })
        for e in page { bySeq[e.seq] = e }
        return bySeq.values.sorted { $0.seq < $1.seq }
    }

    /// Where to resume from: the newest seq held.
    public static func resumeSeq(_ held: [ThreadEvent]) -> Int { held.map(\.seq).max() ?? 0 }
}

/// What an open thread says about who may do what, from the viewer's side (docs/ponds.md: approving and stopping
/// belong to the starter, on the starter's own Mac, and are not commands on the wire).
public enum PondThreadRules {
    public static func approvalLine(starterName: String, isStarter: Bool) -> String {
        isStarter ? "Approve this on your own Mac" : "Waiting for \(starterName.isEmpty ? "the starter" : starterName) to approve"
    }

    /// The Private toggle is the starter's alone.
    public static func canTogglePrivate(starter: String, me: String?) -> Bool { me != nil && starter == me }

    public static func composerPlaceholder(role: PondRole, working: Bool) -> String {
        if !role.canMessage { return "You\u{2019}re a viewer: you can read but not send." }
        return working ? "Message, \u{21B5} queue \u{00B7} \u{2318}\u{21B5} steer" : "Message"
    }
}

// MARK: Starting a thread

/// What a pond home offers for "start a thread": an own thread runs on this Nest and needs the pond's Git remote (code
/// moves only through Git); a pond without one can only have chats shared into it.
public enum PondStartThread: Sendable, Equatable {
    case start
    case shareOnly(why: String)
    case none

    public static let noRemote = "This Mac doesn\u{2019}t have this pond\u{2019}s project and it has no Git remote, so threads can only be shared into it."

    /// The fixed line on a shared pond with no Git remote (the new-thread place line): a member's new threads run on the
    /// owner's Mac. Not a notice: it is always said the same way and never moves.
    public static func noRemoteSharedLine(ownerName: String?) -> String {
        let owner = ownerName?.trimmingCharacters(in: .whitespaces) ?? ""
        return "This pond has no Git remote, so new threads run on \(owner.isEmpty ? "the owner" : owner)\u{2019}s Mac"
    }

    /// The same, for a pond with a Git remote whose project this Mac does not hold.
    public static func noProjectSharedLine(ownerName: String?) -> String {
        let owner = ownerName?.trimmingCharacters(in: .whitespaces) ?? ""
        return "This Mac doesn\u{2019}t have this pond\u{2019}s project, so new threads run on \(owner.isEmpty ? "the owner" : owner)\u{2019}s Mac"
    }

    /// A pond shared with me that this Mac cannot start a thread in: Start still works, on the owner's Mac (a signed request).
    public static func runsOnOwnerMac(_ pond: PondSummary?) -> Bool {
        guard let pond, PondSharing.isSharedWithMe(pond), pond.role.canMessage else { return false }
        if case .shareOnly = offer(for: pond) { return true }
        return false
    }

    /// Where a new thread in this pond can run (docs/ponds.md, "The model"): a shared thread on the owner's Mac (any folder, only
    /// messages travel) or an own thread on this Mac (needs a Git remote, code moves through Git).
    public struct Place: Sendable, Equatable {
        public enum Kind: Sendable, Equatable { case shared, own }
        public var kind: Kind
        public var title: String
        public var detail: String
        public var enabled: Bool
    }

    public static func places(for pond: PondSummary) -> [Place] {
        guard pond.role.canMessage else { return [] }
        let remote = !(pond.gitRemote?.trimmingCharacters(in: .whitespaces).isEmpty ?? true)
        let owner = pond.ownerName?.trimmingCharacters(in: .whitespaces) ?? ""
        let mine = pond.role == .owner
        let ownerMac = mine ? "your Mac" : "\(owner.isEmpty ? "the owner" : owner)\u{2019}s Mac"
        var out: [Place] = []
        if !mine { out.append(Place(kind: .shared, title: "Shared thread", detail: "Runs on \(ownerMac), any folder", enabled: true)) }
        out.append(Place(kind: .own, title: "Own thread", detail: remote ? "Runs on your Mac" : (mine ? "Needs a Git remote" : noRemoteSharedLine(ownerName: pond.ownerName)), enabled: remote))
        return out
    }
    public static func offer(for pond: PondSummary) -> PondStartThread {
        guard pond.role.canMessage else { return .none }
        // The host decides (it knows which projects this Mac holds); an older host says nothing, so the remote decides.
        let remote = pond.gitRemote?.trimmingCharacters(in: .whitespaces) ?? ""
        // A pond someone shared that has no Git remote says so in the fixed place line; every other refusal keeps its words.
        let shared = pond.role != .owner && !pond.local
        let why = !shared ? noRemote : (remote.isEmpty ? noRemoteSharedLine(ownerName: pond.ownerName) : noProjectSharedLine(ownerName: pond.ownerName))
        if let here = pond.canStartHere { return here ? .start : .shareOnly(why: why) }
        return remote.isEmpty ? .shareOnly(why: why) : .start
    }

    /// The model a thread starts with: the first the picker lists, and its agent.
    public static func defaultModel(in models: [DaemonChatModel]) -> DaemonChatModel? { models.first }
}
