import Foundation

// docs/ponds.md: the shapes the host's pond routes answer, pinned by the real answers in Fixtures/ponds (made by
// scripts/make-pond-fixtures.ts from the engine's own routes). Decoders stay tolerant of a missing key or a wrong
// type (it reads as nothing, never a failed screen, and a newer host may add fields) but each field has one shape. Words are DESIGN.md §9's: Pond, Flock, thread, Nest, Ripples.

/// A time the host may write as ISO text, or as unix seconds or milliseconds.
enum PondTime {
    static func decode<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ key: K) -> Date? {
        if let n = c.lenient(Double.self, key) { return date(n) }
        if let s = c.lenient(String.self, key) {
            if let n = Double(s) { return date(n) }
            return DaemonDate.parse(s)
        }
        return nil
    }

    static func date(_ n: Double) -> Date { Date(timeIntervalSince1970: n > 100_000_000_000 ? n / 1000 : n) }
}

/// A string the host may write as text or as a number.
private func flexString<K: CodingKey>(_ c: KeyedDecodingContainer<K>, _ key: K) -> String? {
    if let s = c.lenient(String.self, key) { return s }
    if let n = c.lenient(Double.self, key) { return n == n.rounded() ? String(Int(n)) : String(n) }
    return nil
}

public enum PondRole: String, Sendable, Equatable, Codable {
    case owner, member, viewer

    /// An unknown role reads as the least a person can do.
    init(raw: String?) { self = raw.flatMap(PondRole.init(rawValue:)) ?? .viewer }

    public var canMessage: Bool { self != .viewer }
    public var canInvite: Bool { self == .owner }
    public var canApproveJoins: Bool { self == .owner }
    public var canRemoveMembers: Bool { self == .owner }
    /// What the role picker says.
    public var word: String {
        switch self {
        case .owner: "Owner"
        case .member: "Member"
        case .viewer: "Viewer"
        }
    }
    public var summary: String {
        switch self {
        case .owner: "Runs the pond and approves who joins"
        case .member: "Starts threads, messages and answers"
        case .viewer: "Watches only"
        }
    }
}

/// A pond's state for the person looking at it (docs/ponds.md, the state contract). Surfaces draw the host's sentence for
/// it; this only names the state so a view can pick the right controls.
public enum PondStatus: String, Sendable, Equatable {
    case local, pending, active, declined, expired, revoked, removed

    /// An older host's `denied` is `declined`; an unknown word reads as `active`, so nothing is hidden.
    public init(raw: String, local: Bool = false) {
        switch raw {
        case "denied": self = .declined
        case "active" where local: self = .local
        default: self = PondStatus(rawValue: raw) ?? .active
        }
    }

    public var isTerminal: Bool { self == .declined || self == .expired || self == .revoked || self == .removed }
}

public struct PondSummary: Sendable, Equatable, Identifiable, Decodable {
    public var id: String
    public var name: String
    public var role: PondRole
    public var memberCount: Int
    public var threadCount: Int
    public var needsYou: Int
    public var gitRemote: String?
    /// The host's own tint hint, kept as written; the app derives its own from the id (`PondTint`).
    public var tint: String?
    /// The Squeak project on this Mac the pond was made from (local to the host; absent for a pond joined by invite).
    public var projectId: String?
    /// True until the first invite publishes it: the pond exists only on this Mac.
    public var local: Bool
    /// The host's word on whether this Mac can start a thread of its own in the pond (it holds the pond's project, or the
    /// pond has a Git remote). Absent from an older host.
    public var canStartHere: Bool?
    /// The host's word: `local`, `pending` (a join waiting on an owner), `active`, or a terminal `declined` / `expired` /
    /// `revoked` / `removed` (an older host says `denied`). Kept as written; `state` reads it.
    public var status: String
    /// For a pending join: what the invite offered, and when it was asked.
    public var requestedRole: PondRole?
    public var requestedAt: Date?
    /// The host's one plain sentence for the current state ("Waiting for Sibhi to approve you as a member."); nil from an older host.
    public var statusLine: String?
    public var ownerName: String?
    /// The relay could not be reached and this is the last good read (`asOf`); `offlineLine` is the host's sentence for it.
    public var offline: Bool
    public var asOf: Date?
    public var offlineLine: String?
    public var state: PondStatus { PondStatus(raw: status, local: local) }
    public var isWaiting: Bool { state == .pending }
    public var isDeclined: Bool { state == .declined }
    /// Declined, expired, revoked or removed: the row stays until the person presses Remove.
    public var isTerminal: Bool { state.isTerminal }

    enum CodingKeys: String, CodingKey {
        case status, requestedRole, requestedAt, statusLine, ownerName, offline, asOf, offlineLine
        case id, name, role, memberCount, threadCount, needsYou, gitRemote, tint, projectId, local, canStartHere
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = c.lenient(String.self, .name) ?? ""
        role = PondRole(raw: c.lenient(String.self, .role))
        memberCount = c.lenient(Int.self, .memberCount) ?? 0
        threadCount = c.lenient(Int.self, .threadCount) ?? 0
        needsYou = c.lenient(Int.self, .needsYou) ?? 0
        gitRemote = c.lenient(String.self, .gitRemote)
        tint = flexString(c, .tint)
        projectId = c.lenient(String.self, .projectId)
        status = c.lenient(String.self, .status) ?? "active"
        local = c.lenient(Bool.self, .local) ?? (status == "local")
        canStartHere = c.lenient(Bool.self, .canStartHere)
        requestedRole = c.lenient(String.self, .requestedRole).flatMap(PondRole.init(rawValue:))
        requestedAt = PondTime.decode(c, CodingKeys.requestedAt)
        statusLine = c.lenient(String.self, .statusLine).flatMap { $0.isEmpty ? nil : $0 }
        ownerName = c.lenient(String.self, .ownerName).flatMap { $0.isEmpty ? nil : $0 }
        offline = c.lenient(Bool.self, .offline) ?? false
        asOf = PondTime.decode(c, CodingKeys.asOf)
        offlineLine = c.lenient(String.self, .offlineLine).flatMap { $0.isEmpty ? nil : $0 }
    }

    public init(id: String, name: String, role: PondRole = .owner, memberCount: Int = 1, threadCount: Int = 0, needsYou: Int = 0, gitRemote: String? = nil, tint: String? = nil, projectId: String? = nil, local: Bool = false, canStartHere: Bool? = nil, status: String = "active", requestedRole: PondRole? = nil,
                statusLine: String? = nil, ownerName: String? = nil, offline: Bool = false, asOf: Date? = nil, offlineLine: String? = nil, requestedAt: Date? = nil) {
        self.statusLine = statusLine; self.ownerName = ownerName; self.offline = offline; self.asOf = asOf; self.offlineLine = offlineLine; self.requestedAt = requestedAt
        self.status = status; self.requestedRole = requestedRole
        self.canStartHere = canStartHere
        self.local = local
        self.projectId = projectId
        self.id = id; self.name = name; self.role = role; self.memberCount = memberCount
        self.threadCount = threadCount; self.needsYou = needsYou; self.gitRemote = gitRemote; self.tint = tint
    }
}

public struct FlockMember: Sendable, Equatable, Identifiable, Decodable {
    public var id: String
    public var name: String
    public var role: PondRole
    /// The machine this person's agents run on.
    public var nest: String?
    public var online: Bool
    public var you: Bool
    /// The machine's own name ("Aarav's MacBook"), and `mac` / `web`; the last time the person was seen. Absent from an older host.
    public var nestName: String?
    public var client: String?
    public var lastSeenAt: Date?

    enum CodingKeys: String, CodingKey { case id, name, role, nest, online, you, nestName, client, lastSeenAt }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = c.lenient(String.self, .name) ?? ""
        role = PondRole(raw: c.lenient(String.self, .role))
        nest = c.lenient(String.self, .nest)
        online = c.lenient(Bool.self, .online) ?? false
        you = c.lenient(Bool.self, .you) ?? false
        nestName = c.lenient(String.self, .nestName)
        client = c.lenient(String.self, .client)
        lastSeenAt = PondTime.decode(c, CodingKeys.lastSeenAt)
    }

    public init(id: String, name: String, role: PondRole = .member, nest: String? = nil, online: Bool = false, you: Bool = false,
                nestName: String? = nil, client: String? = nil, lastSeenAt: Date? = nil) {
        self.id = id; self.name = name; self.role = role; self.nest = nest; self.online = online; self.you = you
        self.nestName = nestName; self.client = client; self.lastSeenAt = lastSeenAt
    }

    /// The machine to name: its own name, else the Nest the host wrote; nil for a person on the web.
    public var machine: String? {
        if let n = nestName, !n.isEmpty { return n }
        if let n = nest, !n.isEmpty { return n }
        return nil
    }

    public var initial: String { String(name.trimmingCharacters(in: .whitespaces).first.map { String($0).uppercased() } ?? "?") }
    public var colourIndex: Int { PondPresence.colourIndex(for: name) }
}

/// Someone who took part in a thread (daemon 1a41f8d): who, and when they last did.
public struct PondParticipant: Sendable, Equatable, Decodable {
    public var memberId: String
    public var name: String
    public var lastAt: Date?

    enum CodingKeys: String, CodingKey { case memberId, name, lastAt }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        memberId = try c.decode(String.self, forKey: .memberId)
        name = c.lenient(String.self, .name) ?? ""
        lastAt = PondTime.decode(c, CodingKeys.lastAt)
    }

    public init(memberId: String, name: String = "", lastAt: Date? = nil) { self.memberId = memberId; self.name = name; self.lastAt = lastAt }
}

public struct PondThread: Sendable, Equatable, Identifiable, Decodable {
    public enum Mode: String, Sendable, Equatable { case own, shared }

    public var id: String
    public var title: String
    public var starter: String
    public var starterName: String
    public var nest: String?
    public var agent: String?
    public var model: String?
    /// The host's word for the state, kept as written; `PondThreadState` reads it.
    public var state: String
    public var isPrivate: Bool
    public var mode: Mode
    /// The host's chat behind the thread, on the starter's own Nest.
    public var sessionId: String?
    /// The chat's permission mode, written to the cloud so a guest can see why a message is refused ("bypassPermissions").
    public var permissionMode: String?
    public var updatedAt: Date?
    /// The starter's workspace (worktree) name and branch, and who has taken part; absent from an older daemon.
    public var workspace: String?
    public var branch: String?
    public var participants: [PondParticipant]
    /// False when the chat runs without asking: members cannot message it. Nil from an older host.
    public var asks: Bool?
    /// Whether the starter's Mac is up, the machine's name, and the host's sentence for where the thread is ("Working on
    /// Aarav's Mac"). Nil from an older host.
    public var starterOnline: Bool?
    public var nestName: String?
    public var stateLine: String?
    /// "approval" or "question" while the thread waits on a person; nil otherwise and from an older host.
    public var waitingOn: String?

    enum CodingKeys: String, CodingKey {
        case id, title, starter, starterName, nest, agent, model, state, mode, sessionId, permissionMode, updatedAt, workspace, branch, participants
        case asks, starterOnline, nestName, stateLine, waitingOn
    }
    private enum PrivateKey: String, CodingKey { case `private` }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = c.lenient(String.self, .title) ?? ""
        starter = c.lenient(String.self, .starter) ?? ""
        starterName = c.lenient(String.self, .starterName) ?? ""
        nest = c.lenient(String.self, .nest)
        agent = c.lenient(String.self, .agent)
        model = c.lenient(String.self, .model)
        state = c.lenient(String.self, .state) ?? ""
        mode = c.lenient(String.self, .mode).flatMap(Mode.init(rawValue:)) ?? .shared
        sessionId = c.lenient(String.self, .sessionId)
        permissionMode = c.lenient(String.self, .permissionMode)
        updatedAt = PondTime.decode(c, CodingKeys.updatedAt)
        workspace = c.lenient(String.self, .workspace)
        branch = c.lenient(String.self, .branch)
        participants = c.list(PondParticipant.self, .participants)
        asks = c.lenient(Bool.self, .asks)
        starterOnline = c.lenient(Bool.self, .starterOnline)
        nestName = c.lenient(String.self, .nestName)
        stateLine = c.lenient(String.self, .stateLine).flatMap { $0.isEmpty ? nil : $0 }
        waitingOn = c.lenient(String.self, .waitingOn).flatMap { $0.isEmpty ? nil : $0 }
        isPrivate = (try? decoder.container(keyedBy: PrivateKey.self).decodeIfPresent(Bool.self, forKey: .private)) ?? false
    }

    public init(
        id: String, title: String, starter: String = "", starterName: String = "", nest: String? = nil, agent: String? = nil, model: String? = nil,
        state: String = "idle", isPrivate: Bool = false, mode: Mode = .shared, sessionId: String? = nil, permissionMode: String? = nil,
        updatedAt: Date? = nil, workspace: String? = nil, branch: String? = nil, participants: [PondParticipant] = [],
        asks: Bool? = nil, starterOnline: Bool? = nil, nestName: String? = nil, stateLine: String? = nil
    ) {
        self.asks = asks; self.starterOnline = starterOnline; self.nestName = nestName; self.stateLine = stateLine
        self.workspace = workspace; self.branch = branch; self.participants = participants
        self.permissionMode = permissionMode
        self.id = id; self.title = title; self.starter = starter; self.starterName = starterName; self.nest = nest
        self.agent = agent; self.model = model; self.state = state; self.isPrivate = isPrivate; self.mode = mode
        self.sessionId = sessionId; self.updatedAt = updatedAt
    }
}

/// One line of a pond's Ripples.
public struct RippleEntry: Sendable, Equatable, Identifiable, Decodable {
    public var id: String
    public var at: Date?
    public var actor: String
    /// The actor's name from the flock (the host derives it); empty once they left. The raw `actor` is a member id and is never drawn.
    public var actorName: String
    public var text: String

    enum CodingKeys: String, CodingKey { case id, at, actor, actorName, text }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = flexString(c, .id) ?? UUID().uuidString
        at = PondTime.decode(c, CodingKeys.at)
        actor = c.lenient(String.self, .actor) ?? ""
        actorName = c.lenient(String.self, .actorName) ?? ""
        text = c.lenient(String.self, .text) ?? ""
    }

    public init(id: String, at: Date?, actor: String = "", actorName: String = "", text: String) { self.id = id; self.at = at; self.actor = actor; self.actorName = actorName; self.text = text }
}

/// Someone answering a question: others see "Aarav is answering" until `until`.
public struct PondHold: Sendable, Equatable, Decodable {
    public var requestId: String
    public var by: String
    public var byName: String
    public var until: Date?

    enum CodingKeys: String, CodingKey { case requestId, by, byName, heldBy, heldByName, until }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        requestId = try c.decode(String.self, forKey: .requestId)
        by = c.lenient(String.self, .heldBy) ?? c.lenient(String.self, .by) ?? ""
        byName = c.lenient(String.self, .heldByName) ?? c.lenient(String.self, .byName) ?? ""
        until = PondTime.decode(c, CodingKeys.until)
    }

    public init(requestId: String, by: String, byName: String, until: Date?) {
        self.requestId = requestId; self.by = by; self.byName = byName; self.until = until
    }
}

/// A request to join, waiting for an owner's Mac to approve it (`joins` of `GET /ponds/<id>`).
public struct JoinRequest: Sendable, Equatable, Identifiable, Decodable {
    public var id: String
    public var name: String
    /// The role the invite offered; the owner decides.
    public var role: PondRole
    /// The requester's machine; nil for a web guest.
    public var nest: String?
    public var isWeb: Bool
    /// The sign-in provider's verified email and name for a web guest; nil from an older daemon.
    public var verifiedEmail: String?
    public var verifiedName: String?
    /// The owner's decision on this request while the host runs it ("working") or after it failed ("failed", with a sentence); nil from an older daemon.
    public var decisionState: String?
    public var decisionApprove: Bool?
    public var decisionError: String?
    /// When it was asked; nil from an older host.
    public var requestedAt: Date?

    /// "Approving…" while the host works, its sentence when it failed, nothing otherwise.
    public var decisionLine: String? {
        switch decisionState {
        case "working": return decisionApprove == false ? "Declining\u{2026}" : "Approving\u{2026}"
        case "failed": return decisionError ?? "That didn\u{2019}t go through. Try again."
        default: return nil
        }
    }
    public var decisionFailed: Bool { decisionState == "failed" }
    public var isDeciding: Bool { decisionState == "working" }

    /// What to call the requester: the verified name when there is one.
    public var displayName: String {
        if let n = verifiedName, !n.isEmpty { return n }
        return name.isEmpty ? "Someone" : name
    }

    /// "Priya, priya@gmail.com, verified, wants to join"
    public var accessibilityLabel: String {
        verifiedEmail.map { "\(displayName), \($0), verified, wants to join" } ?? "\(displayName) wants to join"
    }

    enum CodingKeys: String, CodingKey { case requestId, name, role, nest, client, verifiedEmail, verifiedName, decision, requestedAt }
    enum DecisionKeys: String, CodingKey { case state, approve, error, line }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .requestId)
        name = c.lenient(String.self, .name) ?? ""
        role = PondRole(raw: c.lenient(String.self, .role))
        nest = c.lenient(String.self, .nest)
        isWeb = c.lenient(String.self, .client) == "web"
        verifiedEmail = (try? c.decodeIfPresent(String.self, forKey: .verifiedEmail)).flatMap { $0 }.flatMap { $0.isEmpty ? nil : $0 }
        verifiedName = (try? c.decodeIfPresent(String.self, forKey: .verifiedName)).flatMap { $0 }
        if let d = try? c.nestedContainer(keyedBy: DecisionKeys.self, forKey: .decision) {
            decisionState = d.lenient(String.self, .state)
            decisionApprove = d.lenient(Bool.self, .approve)
            decisionError = d.lenient(String.self, .line) ?? d.lenient(String.self, .error)
        }
        requestedAt = PondTime.decode(c, CodingKeys.requestedAt)
    }

    public init(id: String, name: String, role: PondRole = .member, nest: String? = nil, isWeb: Bool = false,
                verifiedEmail: String? = nil, verifiedName: String? = nil,
                decisionState: String? = nil, decisionApprove: Bool? = nil, decisionError: String? = nil, requestedAt: Date? = nil) {
        self.requestedAt = requestedAt
        self.id = id; self.name = name; self.role = role; self.nest = nest; self.isWeb = isWeb
        self.verifiedEmail = verifiedEmail; self.verifiedName = verifiedName
        self.decisionState = decisionState; self.decisionApprove = decisionApprove; self.decisionError = decisionError
    }
}

/// Who is here right now: online, which thread they look at, and the thread they are typing in (the host writes the
/// thread id, not a flag).
public struct PondPresenceEntry: Sendable, Equatable, Decodable {
    public var member: String
    public var online: Bool
    public var viewing: String?
    public var typingIn: String?

    enum CodingKeys: String, CodingKey { case memberId, online, viewing, typing }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        member = try c.decode(String.self, forKey: .memberId)
        online = c.lenient(Bool.self, .online) ?? true
        viewing = c.lenient(String.self, .viewing)
        typingIn = c.lenient(String.self, .typing)
    }

    public init(member: String, online: Bool = true, viewing: String? = nil, typingIn: String? = nil) {
        self.member = member; self.online = online; self.viewing = viewing; self.typingIn = typingIn
    }

    public func isTyping(in thread: String) -> Bool { typingIn == thread }
}

/// `me` of `GET /ponds/<id>`: this Mac's person.
public struct PondMe: Sendable, Equatable, Decodable {
    public var id: String
    public var name: String
    public var role: PondRole
    public var nest: String?

    enum CodingKeys: String, CodingKey { case id, name, role, nest }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = c.lenient(String.self, .name) ?? ""
        role = PondRole(raw: c.lenient(String.self, .role))
        nest = c.lenient(String.self, .nest)
    }

    public init(id: String, name: String = "", role: PondRole = .member, nest: String? = nil) {
        self.id = id; self.name = name; self.role = role; self.nest = nest
    }
}

/// `GET /ponds/<id>`: everything a pond's home draws.
public struct PondDetail: Sendable, Equatable, Decodable {
    public var pond: PondSummary
    public var members: [FlockMember]
    public var threads: [PondThread]
    public var ripples: [RippleEntry]
    public var presence: [PondPresenceEntry]
    public var holds: [PondHold]
    public var joins: [JoinRequest]
    public var me: PondMe?
    /// The owner's invites with their states; empty for anyone else and from an older host.
    public var invites: [PondInviteEntry]

    enum CodingKeys: String, CodingKey { case pond, members, threads, ripples, presence, holds, joins, me, invites, offline, asOf, offlineLine }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        pond = try c.decode(PondSummary.self, forKey: .pond)
        members = c.list(FlockMember.self, .members)
        threads = c.list(PondThread.self, .threads)
        ripples = c.list(RippleEntry.self, .ripples)
        presence = c.list(PondPresenceEntry.self, .presence)
        holds = c.list(PondHold.self, .holds)
        joins = c.list(JoinRequest.self, .joins)
        me = c.lenient(PondMe.self, .me)
        invites = c.list(PondInviteEntry.self, .invites)
        // The contract puts `offline` on the pond; a host may also write it beside it.
        if c.lenient(Bool.self, .offline) == true { pond.offline = true }
        if pond.asOf == nil { pond.asOf = PondTime.decode(c, CodingKeys.asOf) }
        if pond.offlineLine == nil { pond.offlineLine = c.lenient(String.self, .offlineLine) }
    }

    public init(
        pond: PondSummary, members: [FlockMember] = [], threads: [PondThread] = [], ripples: [RippleEntry] = [],
        presence: [PondPresenceEntry] = [], holds: [PondHold] = [], joins: [JoinRequest] = [], me: PondMe? = nil, invites: [PondInviteEntry] = []
    ) {
        self.invites = invites
        self.pond = pond; self.members = members; self.threads = threads; self.ripples = ripples
        self.presence = presence; self.holds = holds; self.joins = joins; self.me = me
    }

    /// This Mac's person: the member the host marks `you`, else the one `me` names.
    public var meMember: FlockMember? { members.first { $0.you } ?? members.first { $0.id == me?.id } }
    public var myRole: PondRole { me?.role ?? meMember?.role ?? pond.role }
}

extension KeyedDecodingContainer {
    /// An array whose bad elements are skipped; a missing or wrong-typed key reads as empty.
    func list<T: Decodable>(_ type: T.Type, _ key: Key) -> [T] {
        (try? decodeIfPresent([Failable<T>].self, forKey: key))?.compactMap(\.value) ?? []
    }
}

/// `POST /ponds/<id>/invites`.
public struct PondInvite: Sendable, Equatable, Decodable {
    /// The invite's id (to revoke it); nil from an older host.
    public var id: String?
    public var code: String
    public var expiresAt: Date?
    /// `https://<host>/join#<code>`, only when the host has an invite link base; the code stays in the fragment.
    public var link: String?

    enum CodingKeys: String, CodingKey { case id, code, expiresAt, link }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = flexString(c, .id)
        code = try c.decode(String.self, forKey: .code)
        expiresAt = PondTime.decode(c, CodingKeys.expiresAt)
        link = c.lenient(String.self, .link)
    }

    public init(code: String, expiresAt: Date?, link: String? = nil, id: String? = nil) { self.id = id; self.code = code; self.expiresAt = expiresAt; self.link = link }

    /// What a person copies: the link when the host made one, else the code.
    public var shareable: String { link ?? code }
}

/// `POST /ponds/join`: the request is written and an owner's Mac must approve it.
public struct PondJoinResult: Sendable, Equatable, Decodable {
    public var pondId: String
    public var status: String

    enum CodingKeys: String, CodingKey { case pondId, status }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        pondId = try c.decode(String.self, forKey: .pondId)
        status = c.lenient(String.self, .status) ?? "pending"
    }

    public var isPending: Bool { status != "approved" }
}

// MARK: Thread events

/// A normalized thread event (`{ seq, at, type, ... }`). Unknown types are kept, never dropped, so a newer host's
/// event does not break a thread.
public struct ThreadEvent: Sendable, Equatable, Identifiable, Decodable {
    public enum Kind: Sendable, Equatable {
        case user(by: String?, text: String)
        case agent(text: String)
        case thinking(text: String)
        case tool(label: String, state: String?)
        case question(requestId: String, text: String, options: [String])
        case approval(requestId: String, label: String)
        case resolved(requestId: String)
        case state(String)
        case changed(files: Int, added: Int, removed: Int, paths: [String])
        case other(String)
    }

    public var seq: Int
    public var at: Date?
    public var kind: Kind
    public var id: Int { seq }

    enum CodingKeys: String, CodingKey {
        case seq, at, type, by, text, label, state, requestId, options, files, added, removed, paths
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        seq = try c.decode(Int.self, forKey: .seq)
        at = PondTime.decode(c, CodingKeys.at)
        let type = c.lenient(String.self, .type) ?? ""
        let text = c.lenient(String.self, .text) ?? ""
        switch type {
        case "user": kind = .user(by: c.lenient(String.self, .by), text: text)
        case "agent": kind = .agent(text: text)
        case "thinking": kind = .thinking(text: text)
        case "tool": kind = .tool(label: c.lenient(String.self, .label) ?? text, state: c.lenient(String.self, .state))
        case "question":
            struct Option: Decodable { var label: String? }
            let strings = c.lenient([String].self, .options)
            let objects = (c.lenient([Option].self, .options) ?? []).compactMap(\.label)
            kind = .question(requestId: c.lenient(String.self, .requestId) ?? "", text: text, options: strings ?? objects)
        case "approval": kind = .approval(requestId: c.lenient(String.self, .requestId) ?? "", label: c.lenient(String.self, .label) ?? text)
        case "resolved": kind = .resolved(requestId: c.lenient(String.self, .requestId) ?? "")
        case "state": kind = .state(c.lenient(String.self, .state) ?? "")
        case "changed":
            kind = .changed(
                files: c.lenient(Int.self, .files) ?? 0, added: c.lenient(Int.self, .added) ?? 0, removed: c.lenient(Int.self, .removed) ?? 0,
                paths: c.lenient([String].self, .paths) ?? [])
        default: kind = .other(type)
        }
    }

    public init(seq: Int, at: Date? = nil, kind: Kind) { self.seq = seq; self.at = at; self.kind = kind }
}

public struct ThreadEventPage: Sendable, Equatable, Decodable {
    public var events: [ThreadEvent]
    public var lastSeq: Int

    enum CodingKeys: String, CodingKey { case events, lastSeq }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        events = c.list(ThreadEvent.self, .events)
        lastSeq = c.lenient(Int.self, .lastSeq) ?? events.map(\.seq).max() ?? 0
    }

    public init(events: [ThreadEvent], lastSeq: Int) { self.events = events; self.lastSeq = lastSeq }
}


/// One invite in the owner's list (`invites` of `GET /ponds/<id>`).
public struct PondInviteEntry: Sendable, Equatable, Identifiable, Decodable {
    public enum State: String, Sendable, Equatable { case pending, accepted, declined, expired, revoked }

    public var id: String
    public var role: PondRole
    public var state: State
    public var createdAt: Date?
    public var expiresAt: Date?
    /// The name of the person who used it (accepted or declined).
    public var usedBy: String?
    /// Kept by the host for a pending invite so the owner can copy it again.
    public var link: String?
    public var code: String?

    enum CodingKeys: String, CodingKey { case id, role, state, createdAt, expiresAt, usedBy, link, code }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = flexString(c, .id) ?? UUID().uuidString
        role = PondRole(raw: c.lenient(String.self, .role))
        state = c.lenient(String.self, .state).flatMap(State.init(rawValue:)) ?? .pending
        createdAt = PondTime.decode(c, CodingKeys.createdAt)
        expiresAt = PondTime.decode(c, CodingKeys.expiresAt)
        usedBy = c.lenient(String.self, .usedBy).flatMap { $0.isEmpty ? nil : $0 }
        link = c.lenient(String.self, .link)
        code = c.lenient(String.self, .code)
    }

    public init(id: String, role: PondRole = .member, state: State = .pending, createdAt: Date? = nil, expiresAt: Date? = nil, usedBy: String? = nil, link: String? = nil, code: String? = nil) {
        self.id = id; self.role = role; self.state = state; self.createdAt = createdAt; self.expiresAt = expiresAt
        self.usedBy = usedBy; self.link = link; self.code = code
    }

    /// What a person copies: the link when the host kept one, else the code; nil when it kept neither.
    public var shareable: String? { link ?? code }
}

/// The answer to a member's message (`POST .../messages`): queued behind the starter's Mac, sent, or refused with the
/// host's reason sentence. An older host answers `{ queued }` only.
public struct PondSendResult: Sendable, Equatable, Decodable {
    public enum State: String, Sendable, Equatable { case queued, sent, refused }

    public var state: State
    public var line: String?

    enum CodingKeys: String, CodingKey { case state, line, queued }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        if let s = c.lenient(String.self, .state).flatMap(State.init(rawValue:)) {
            state = s
        } else {
            state = c.lenient(Bool.self, .queued) == true ? .queued : .sent
        }
        line = c.lenient(String.self, .line).flatMap { $0.isEmpty ? nil : $0 }
    }

    public init(state: State, line: String? = nil) { self.state = state; self.line = line }
}
