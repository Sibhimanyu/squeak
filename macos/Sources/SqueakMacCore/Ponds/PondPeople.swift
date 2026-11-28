import Foundation

// docs/spec.md "People and remote": one way in (an email), the invite as one record in the cloud, one People sheet.
// Surfaces decide nothing: the host computes `GET /native/ponds/<id>/people` and this only words and arranges it. The Invite
// sheet's tokens and refusals, the People sheet's rows and the Dashboard's avatars are all pure so CI can test them.

// MARK: Shapes

/// One invite as the relay holds it (epoch milliseconds; `settledAt` is 0 while pending, and an expired invite's is its `expiresAt`).
public struct PondInviteRecord: Sendable, Equatable, Identifiable, Decodable {
    public enum State: String, Sendable, Equatable { case pending, joined, declined, expired, withdrawn }

    public var id: String
    public var email: String
    public var role: PondRole
    public var state: State
    public var invitedBy: String
    public var createdAt: Int
    public var expiresAt: Int
    public var settledAt: Int
    /// The account's name when that address has a Squeak account; nil otherwise.
    public var name: String?
    /// The account, once known.
    public var userId: String?
    /// The relay could not deliver the email after its retries: the Owner can Resend.
    public var emailFailed: Bool

    enum CodingKeys: String, CodingKey { case id, email, role, state, invitedBy, createdAt, expiresAt, settledAt, name, userId, emailFailed }

    public init(id: String, email: String, role: PondRole, state: State, invitedBy: String, createdAt: Int, expiresAt: Int, settledAt: Int,
                name: String? = nil, userId: String? = nil, emailFailed: Bool = false) {
        self.id = id; self.email = email; self.role = role; self.state = state; self.invitedBy = invitedBy
        self.createdAt = createdAt; self.expiresAt = expiresAt; self.settledAt = settledAt; self.name = name; self.userId = userId
        self.emailFailed = emailFailed
    }

    /// A record with an unknown state does not decode (the list skips it) so nothing is ever drawn wrongly.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        email = try c.decode(String.self, forKey: .email)
        guard let s = State(rawValue: try c.decode(String.self, forKey: .state)) else {
            throw DecodingError.dataCorruptedError(forKey: .state, in: c, debugDescription: "unknown invite state")
        }
        state = s
        role = PondRole(raw: c.lenient(String.self, .role))
        invitedBy = c.lenient(String.self, .invitedBy) ?? ""
        createdAt = c.lenient(Int.self, .createdAt) ?? 0
        expiresAt = c.lenient(Int.self, .expiresAt) ?? 0
        settledAt = c.lenient(Int.self, .settledAt) ?? 0
        name = c.lenient(String.self, .name).flatMap { $0.isEmpty ? nil : $0 }
        userId = c.lenient(String.self, .userId).flatMap { $0.isEmpty ? nil : $0 }
        emailFailed = c.lenient(Bool.self, .emailFailed) ?? false
    }
}

/// One member as the People route reports them.
public struct PondPerson: Sendable, Equatable, Identifiable, Decodable {
    public var id: String
    public var name: String
    public var email: String
    public var role: PondRole
    public var online: Bool
    /// Epoch milliseconds.
    public var lastSeenAt: Int?
    public var you: Bool
    /// Joined in the cloud, but the Owner's Mac has not sealed the key to them yet (the id then looks like `acct:<userId>`).
    public var connecting: Bool

    enum CodingKeys: String, CodingKey { case id, name, email, role, online, lastSeenAt, you, connecting }

    public init(id: String, name: String, email: String, role: PondRole, online: Bool, lastSeenAt: Int?, you: Bool, connecting: Bool = false) {
        self.id = id; self.name = name; self.email = email; self.role = role; self.online = online; self.lastSeenAt = lastSeenAt; self.you = you
        self.connecting = connecting
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        email = c.lenient(String.self, .email) ?? ""
        let n = c.lenient(String.self, .name) ?? ""
        name = n.isEmpty ? email : n
        role = PondRole(raw: c.lenient(String.self, .role))
        online = c.lenient(Bool.self, .online) ?? false
        lastSeenAt = c.lenient(Int.self, .lastSeenAt)
        you = c.lenient(Bool.self, .you) ?? false
        connecting = c.lenient(Bool.self, .connecting) ?? false
    }
}

/// `GET /native/ponds/<id>/people`.
public struct PondPeople: Sendable, Equatable, Decodable {
    public var cap: Int
    public var members: [PondPerson]
    public var invites: [PondInviteRecord]

    enum CodingKeys: String, CodingKey { case cap, members, invites }

    public init(cap: Int = 10, members: [PondPerson], invites: [PondInviteRecord]) { self.cap = cap; self.members = members; self.invites = invites }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        cap = c.lenient(Int.self, .cap) ?? 10
        members = c.list(PondPerson.self, .members)
        invites = c.list(PondInviteRecord.self, .invites)
    }

    public var me: PondPerson? { members.first(where: \.you) }
    public var pending: [PondInviteRecord] { invites.filter { $0.state == .pending } }
    /// Places used: people plus pending invitations (finished invites do not count).
    public var used: Int { members.count + pending.count }
}

/// One address's answer to `POST /native/ponds/<id>/invites`.
public struct PondInviteOutcome: Sendable, Equatable, Decodable {
    public var email: String
    public var ok: Bool
    public var invite: PondInviteRecord?
    /// The plain sentence for a refusal.
    public var message: String?
    /// What became of the address; nil from a host that does not say (then `ok` decides).
    public var status: Status?

    public enum Status: String, Sendable, Equatable {
        case invited, alreadyMember = "already-member", alreadyInvited = "already-invited", refused
    }

    enum CodingKeys: String, CodingKey { case email, ok, invite, message, status }

    public init(email: String, ok: Bool, invite: PondInviteRecord?, message: String?, status: Status? = nil) {
        self.email = email; self.ok = ok; self.invite = invite; self.message = message; self.status = status
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        email = try c.decode(String.self, forKey: .email)
        ok = c.lenient(Bool.self, .ok) ?? false
        invite = c.lenient(PondInviteRecord.self, .invite)
        message = c.lenient(String.self, .message)
        status = c.lenient(String.self, .status).flatMap(Status.init(rawValue:))
    }
}

public struct PondInviteResults: Sendable, Equatable, Decodable {
    public var results: [PondInviteOutcome]
    enum CodingKeys: String, CodingKey { case results }
    public init(results: [PondInviteOutcome]) { self.results = results }
    public init(from decoder: Decoder) throws {
        results = try decoder.container(keyedBy: CodingKeys.self).list(PondInviteOutcome.self, .results)
    }
}

// MARK: Addresses

public enum EmailAddress {
    /// A simple strict address: one @, a dotted host, no spaces or quotes; at most 254 characters.
    public static func isValid(_ value: String) -> Bool {
        let v = value.trimmingCharacters(in: .whitespaces)
        guard v.count <= 254, let at = v.lastIndex(of: "@") else { return false }
        let local = v[v.startIndex..<at]
        let host = v[v.index(after: at)...]
        guard (1...64).contains(local.count), !local.contains("@"), !host.isEmpty else { return false }
        let localOK = local.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || ".!#$%&'*+/=?^_`{|}~-".contains($0)) }
        let labels = host.split(separator: ".", omittingEmptySubsequences: false)
        guard localOK, labels.count >= 2 else { return false }
        return labels.allSatisfy { label in
            (1...63).contains(label.count) && label.first != "-" && label.last != "-"
                && label.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-") }
        }
    }

    public static func normalized(_ value: String) -> String { value.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
}

// MARK: Invite sheet

public struct InviteSheetPlan: Sendable, Equatable {
    public struct Token: Sendable, Equatable, Identifiable {
        public var address: String
        public var valid: Bool
        /// The host's sentence when it refused this address.
        public var refusal: String?
        public var id: String { address }
    }

    public static let roles: [PondRole] = [.member, .viewer]
    public static let separators = CharacterSet(charactersIn: ", ;\n\t\r")
    public static let subtitle = "They get an email, and an invitation in Squeak if they already have an account."
    /// Said once, on a Pond that is not shared yet: sending the first invite shares it (the daemon does that step).
    public static let shareNote = "Inviting someone shares this Pond. Your Ducks stay private until you share them."
    public static func note(for sharing: PondSharingState) -> String? { sharing == .shared ? nil : shareNote }
    public static let placeholder = "Add another address"
    public static let firstPlaceholder = "name@company.com"

    public private(set) var tokens: [Token] = []
    public var role: PondRole = .member
    public private(set) var sentCount = 0
    /// Places taken before this send (people and pending invites) and the Pond's cap.
    public private(set) var used: Int
    public private(set) var cap: Int

    public init(used: Int = 0, cap: Int = 10) { self.used = used; self.cap = cap }

    /// The People route answered after the sheet opened: the places move, the tokens stay.
    public mutating func setPlaces(used: Int, cap: Int) { self.used = used; self.cap = cap }

    public static func headline(pond: String) -> String { "Invite to \(pond)" }

    public static func roleBlurb(_ r: PondRole) -> String {
        switch r {
        case .viewer: "Reads the Room and every duck that is not Private. Posts nothing."
        default: "Posts in the Room, messages and starts ducks. New ducks wait for your approval."
        }
    }

    /// Splits typed or pasted text into pieces.
    public static func pieces(_ text: String) -> [String] {
        text.components(separatedBy: separators).map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
    }

    /// Adds every piece: lower-cased, no duplicates; text that is not an address stays as a flagged token so it can be fixed.
    public mutating func add(_ text: String) {
        for piece in Self.pieces(text) {
            let a = EmailAddress.normalized(piece)
            if tokens.contains(where: { $0.address == a }) { continue }
            tokens.append(Token(address: a, valid: EmailAddress.isValid(a), refusal: nil))
        }
    }

    public mutating func remove(_ address: String) { tokens.removeAll { $0.address == address } }

    /// Valid addresses the host has not refused: what Send sends.
    public var sendable: [String] { tokens.filter { $0.valid && $0.refusal == nil }.map(\.address) }
    public var placesLeft: Int { max(cap - used, 0) }
    public var overCap: Bool { sendable.count > placesLeft }
    public var canSend: Bool { !sendable.isEmpty && !overCap }
    public var isDone: Bool { sentCount > 0 && tokens.isEmpty }

    public var sendTitle: String { sendable.count > 1 ? "Send \(sendable.count) invites" : "Send invite" }

    public var placesLine: String {
        let base = "\(used) of \(cap) places used"
        return sendable.isEmpty ? base : "\(base), \(sendable.count) more with these"
    }

    public var capLine: String? {
        guard overCap else { return nil }
        return "Only \(placesLeft) \(placesLeft == 1 ? "place is" : "places are") left. Remove an address to send."
    }

    public var invalidLine: String? {
        tokens.first(where: { !$0.valid }).map { "\u{201C}\($0.address)\u{201D} doesn\u{2019}t look like an email address." }
    }

    /// The first refusal, inline under the tokens: "asha@greenroom.app: Already a Member." (with the way on when others can still go).
    public var refusalLine: String? {
        guard let t = tokens.first(where: { $0.refusal != nil }), let why = t.refusal else { return nil }
        let line = "\(t.address): \(why)"
        return sendable.isEmpty ? line : line + " Remove it to send the rest."
    }

    /// The one line under the field: the host's refusal first, then what is not an address, then the cap.
    public var problemLine: String? { refusalLine ?? invalidLine ?? capLine }

    /// What came back: sent addresses leave the field; refused ones stay with their sentence.
    public mutating func apply(_ results: [PondInviteOutcome]) {
        let byEmail = Dictionary(results.map { (EmailAddress.normalized($0.email), $0) }, uniquingKeysWith: { a, _ in a })
        var kept: [Token] = []
        for var t in tokens {
            guard let r = byEmail[t.address] else { kept.append(t); continue }
            if r.ok { sentCount += 1; continue }
            t.refusal = (r.message?.isEmpty == false ? r.message : nil) ?? "Couldn\u{2019}t invite this address."
            kept.append(t)
        }
        tokens = kept
    }

    /// A token edited or re-added clears its old refusal.
    public mutating func clearRefusals() { tokens = tokens.map { var t = $0; t.refusal = nil; return t } }
}

/// The Invite sheet once Invite is pressed: the field and role are locked and each address is a row, "Inviting\u{2026}" while the
/// call runs, then "Invited \u{2713}" or the reason. Idle until `begin`; `done` when the answer is in (a refused address keeps its row).
public struct InviteSheetRows: Sendable, Equatable {
    public enum Phase: Sendable, Equatable { case idle, inviting, done }
    public enum Outcome: Sendable, Equatable { case inviting, invited, refused(String) }

    public struct Row: Sendable, Equatable, Identifiable {
        public var address: String
        public var outcome: Outcome
        public var id: String { address }
        public var text: String {
            switch outcome {
            case .inviting: "Inviting\u{2026}"
            case .invited: "Invited \u{2713}"
            case .refused(let why): why
            }
        }
        public var failed: Bool { if case .refused = outcome { true } else { false } }
    }

    public private(set) var phase: Phase = .idle
    public private(set) var rows: [Row] = []

    public init() {}

    /// Field and role are read-only from Invite until the call fails.
    public var locked: Bool { phase != .idle }
    public var showsDone: Bool { phase == .done }
    public var invitedCount: Int { rows.filter { $0.outcome == .invited }.count }

    public static func reason(for r: PondInviteOutcome?) -> String? {
        guard let r else { return "Couldn\u{2019}t invite this address." }
        let said = r.message.flatMap { $0.isEmpty ? nil : $0 }
        switch r.status {
        case .alreadyMember: return said ?? "Already a Member."
        case .alreadyInvited: return said ?? "Already invited."
        case .refused: return said ?? "Couldn\u{2019}t invite this address."
        case .invited: return nil
        case nil: return r.ok ? nil : (said ?? "Couldn\u{2019}t invite this address.")
        }
    }

    public mutating func begin(_ addresses: [String]) {
        phase = .inviting
        rows = addresses.map { Row(address: $0, outcome: .inviting) }
    }

    /// The answer: one outcome per row, matched by address; an address the host left out is a refusal.
    public mutating func finish(_ results: [PondInviteOutcome]) {
        let by = Dictionary(results.map { (EmailAddress.normalized($0.email), $0) }, uniquingKeysWith: { a, _ in a })
        rows = rows.map { row in
            var r = row
            let result = by[EmailAddress.normalized(row.address)]
            r.outcome = Self.reason(for: result).map(Outcome.refused) ?? .invited
            return r
        }
        phase = .done
    }

    /// Nothing could be asked: the sheet unlocks with its addresses as they were.
    public mutating func fail() { phase = .idle; rows = [] }
}

// MARK: People sheet

public struct PeopleSheetPlan: Sendable, Equatable {
    public enum InviteAction: Sendable, Equatable { case resend, withdraw, inviteAgain }

    public struct MemberRow: Sendable, Equatable, Identifiable {
        public var id: String
        public var name: String
        public var email: String
        public var you: Bool
        /// "online" or "last seen 2 h ago"; nil when there is no reading.
        public var seen: String?
        public var role: PondRole
        /// Roles the Owner may change this person to (including the current one); empty draws the role as fixed text.
        public var roleChoices: [PondRole]
        public var canRemove: Bool
        public var connecting: Bool
    }

    public struct InviteRow: Sendable, Equatable, Identifiable {
        public var id: String
        public var email: String
        /// The account's name when the invite carries one, else the address.
        public var title: String
        /// The address beneath the name; nil when the address is the title.
        public var subtitle: String?
        public var role: PondRole
        public var state: PondInviteRecord.State
        /// "Invited · 3 days ago", "Declined · 2 h ago", "Expired", "Withdrawn · 1 d ago".
        public var stateText: String
        /// "Member · Invited · 3 days ago".
        public var line: String
        public var actions: [InviteAction]
        /// The invitation's email could not be delivered: the row says so with Resend in place of its status line.
        public var emailFailed: Bool
    }

    public var members: [MemberRow]
    public var invites: [InviteRow]
    public var subtitle: String
    public var canInvite: Bool
    public var cap: Int

    public static let emailFailedText = "Email not delivered"
    public static let finishedFootnote = "Finished invites clear after 7 days."
    public static let finishedKeep: TimeInterval = 7 * 86400
    public static func title(pond: String) -> String { "People in \(pond)" }

    public static func make(_ people: PondPeople, now: Date) -> PeopleSheetPlan {
        let isOwner = people.me?.role == .owner
        let ordered = people.members.filter(\.you) + people.members.filter { !$0.you }
        let members = ordered.map { m -> MemberRow in
            // A person still connecting has no member id the host's routes know: no role menu and no Remove yet.
            let fixed = m.role == .owner || m.you || m.connecting
            return MemberRow(
                id: m.id, name: m.name, email: m.email, you: m.you, seen: m.connecting ? "Connecting\u{2026}" : seen(m, now: now), role: m.role,
                roleChoices: isOwner && !fixed ? [.member, .viewer] : [], canRemove: isOwner && !fixed, connecting: m.connecting)
        }
        var invites: [InviteRow] = []
        if isOwner {
            let shown = people.invites.filter { i in
                switch i.state {
                case .joined: false
                case .pending: true
                default: now.timeIntervalSince(Date(timeIntervalSince1970: Double(i.settledAt) / 1000)) <= finishedKeep
                }
            }
            let sorted = shown.sorted { a, b in
                if (a.state == .pending) != (b.state == .pending) { return a.state == .pending }
                let x = a.state == .pending ? a.createdAt : a.settledAt, y = b.state == .pending ? b.createdAt : b.settledAt
                return x != y ? x > y : a.id < b.id
            }
            invites = sorted.map { row($0, now: now) }
        }
        let n = people.members.count, p = people.pending.count
        var parts = ["\(n) \(n == 1 ? "person" : "people")"]
        if p > 0 { parts.append("\(p) pending invite\(p == 1 ? "" : "s")") }
        return PeopleSheetPlan(
            members: members, invites: invites,
            subtitle: "\(people.used) of \(people.cap) places used: " + parts.joined(separator: " and "),
            canInvite: isOwner && people.used < people.cap, cap: people.cap)
    }

    static func seen(_ m: PondPerson, now: Date) -> String? {
        if m.online { return "online" }
        guard let at = m.lastSeenAt else { return nil }
        return "last seen \(ago(Date(timeIntervalSince1970: Double(at) / 1000), now: now))"
    }

    static func ago(_ date: Date, now: Date) -> String {
        let s = now.timeIntervalSince(date)
        return s < 60 ? "just now" : "\(PondSentence.span(s)) ago"
    }

    static func row(_ i: PondInviteRecord, now: Date) -> InviteRow {
        let settled = Date(timeIntervalSince1970: Double(i.settledAt) / 1000)
        var text: String
        let actions: [InviteAction]
        switch i.state {
        case .pending:
            let s = now.timeIntervalSince(Date(timeIntervalSince1970: Double(i.createdAt) / 1000))
            let days = Int(s / 86400)
            text = "Invited \u{00B7} " + (days >= 1 ? "\(days) day\(days == 1 ? "" : "s") ago" : ago(Date(timeIntervalSince1970: Double(i.createdAt) / 1000), now: now))
            actions = [.resend, .withdraw]
            if i.emailFailed { text = Self.emailFailedText }
        case .declined: text = "Declined \u{00B7} \(ago(settled, now: now))"; actions = [.inviteAgain]
        case .expired: text = "Expired"; actions = [.inviteAgain]
        case .withdrawn: text = "Withdrawn \u{00B7} \(ago(settled, now: now))"; actions = [.inviteAgain]
        case .joined: text = "Joined"; actions = []
        }
        let named = i.name.flatMap { $0.isEmpty ? nil : $0 }
        return InviteRow(id: i.id, email: i.email, title: named ?? i.email, subtitle: named == nil ? nil : i.email, role: i.role, state: i.state, stateText: text, line: "\(i.role.word) \u{00B7} \(text)", actions: actions, emailFailed: i.emailFailed && i.state == .pending)
    }
}
