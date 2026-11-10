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

    enum CodingKeys: String, CodingKey { case id, name, role, memberCount, threadCount, needsYou, gitRemote, tint, projectId }

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
    }

    public init(id: String, name: String, role: PondRole = .owner, memberCount: Int = 1, threadCount: Int = 0, needsYou: Int = 0, gitRemote: String? = nil, tint: String? = nil, projectId: String? = nil) {
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

    enum CodingKeys: String, CodingKey { case id, name, role, nest, online, you }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = c.lenient(String.self, .name) ?? ""
        role = PondRole(raw: c.lenient(String.self, .role))
        nest = c.lenient(String.self, .nest)
        online = c.lenient(Bool.self, .online) ?? false
        you = c.lenient(Bool.self, .you) ?? false
    }

    public init(id: String, name: String, role: PondRole = .member, nest: String? = nil, online: Bool = false, you: Bool = false) {
        self.id = id; self.name = name; self.role = role; self.nest = nest; self.online = online; self.you = you
    }

    public var initial: String { String(name.trimmingCharacters(in: .whitespaces).first.map { String($0).uppercased() } ?? "?") }
    public var colourIndex: Int { PondPresence.colourIndex(for: name) }
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

    enum CodingKeys: String, CodingKey { case id, title, starter, starterName, nest, agent, model, state, mode, sessionId, permissionMode, updatedAt }
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
        isPrivate = (try? decoder.container(keyedBy: PrivateKey.self).decodeIfPresent(Bool.self, forKey: .private)) ?? false
    }

    public init(
        id: String, title: String, starter: String = "", starterName: String = "", nest: String? = nil, agent: String? = nil, model: String? = nil,
        state: String = "idle", isPrivate: Bool = false, mode: Mode = .shared, sessionId: String? = nil, permissionMode: String? = nil,
        updatedAt: Date? = nil
    ) {
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
    public var text: String

    enum CodingKeys: String, CodingKey { case id, at, actor, text }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = flexString(c, .id) ?? UUID().uuidString
        at = PondTime.decode(c, CodingKeys.at)
        actor = c.lenient(String.self, .actor) ?? ""
        text = c.lenient(String.self, .text) ?? ""
    }

    public init(id: String, at: Date?, actor: String = "", text: String) { self.id = id; self.at = at; self.actor = actor; self.text = text }
}

/// Someone answering a question: others see "Aarav is answering" until `until`.
public struct PondHold: Sendable, Equatable, Decodable {
    public var requestId: String
    public var by: String
    public var byName: String
    public var until: Date?

    enum CodingKeys: String, CodingKey { case requestId, by, byName, until }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        requestId = try c.decode(String.self, forKey: .requestId)
        by = c.lenient(String.self, .by) ?? ""
        byName = c.lenient(String.self, .byName) ?? ""
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

    /// What to call the requester: the verified name when there is one.
    public var displayName: String {
        if let n = verifiedName, !n.isEmpty { return n }
        return name.isEmpty ? "Someone" : name
    }

    /// "Priya, priya@gmail.com, verified, wants to join"
    public var accessibilityLabel: String {
        verifiedEmail.map { "\(displayName), \($0), verified, wants to join" } ?? "\(displayName) wants to join"
    }

    enum CodingKeys: String, CodingKey { case requestId, name, role, nest, client, verifiedEmail, verifiedName }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .requestId)
        name = c.lenient(String.self, .name) ?? ""
        role = PondRole(raw: c.lenient(String.self, .role))
        nest = c.lenient(String.self, .nest)
        isWeb = c.lenient(String.self, .client) == "web"
        verifiedEmail = (try? c.decodeIfPresent(String.self, forKey: .verifiedEmail)).flatMap { $0 }.flatMap { $0.isEmpty ? nil : $0 }
        verifiedName = (try? c.decodeIfPresent(String.self, forKey: .verifiedName)).flatMap { $0 }
    }

    public init(id: String, name: String, role: PondRole = .member, nest: String? = nil, isWeb: Bool = false,
                verifiedEmail: String? = nil, verifiedName: String? = nil) {
        self.id = id; self.name = name; self.role = role; self.nest = nest; self.isWeb = isWeb
        self.verifiedEmail = verifiedEmail; self.verifiedName = verifiedName
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

    enum CodingKeys: String, CodingKey { case pond, members, threads, ripples, presence, holds, joins, me }

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
    }

    public init(
        pond: PondSummary, members: [FlockMember] = [], threads: [PondThread] = [], ripples: [RippleEntry] = [],
        presence: [PondPresenceEntry] = [], holds: [PondHold] = [], joins: [JoinRequest] = [], me: PondMe? = nil
    ) {
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
    public var code: String
    public var expiresAt: Date?
    /// `https://<host>/join#<code>`, only when the host has an invite link base; the code stays in the fragment.
    public var link: String?

    enum CodingKeys: String, CodingKey { case code, expiresAt, link }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        code = try c.decode(String.self, forKey: .code)
        expiresAt = PondTime.decode(c, CodingKeys.expiresAt)
        link = c.lenient(String.self, .link)
    }

    public init(code: String, expiresAt: Date?, link: String? = nil) { self.code = code; self.expiresAt = expiresAt; self.link = link }

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
