import Foundation

// docs/adr/0006-pond-policy.md: who may do what in a Pond is the daemon's one decision, and it sends every surface its
// answer in the pond view: `me.can` (action to `true` or the sentence refusing it), `policy` (the Owner's two settings and
// per-person overrides), and `policy` + `can` on each member. Surfaces compare no roles: they ask `PondCan`. The one place
// the old role logic survives is `PondCan.roleDefault`, for a daemon that does not send `can` yet.

/// A thing a person may be allowed to do in a Pond (the daemon's action names).
public enum PondAction: String, Sendable, CaseIterable {
    case postRoom = "post-room", makeTask = "make-task", startDuck = "start-duck"
    case messageDuck = "message-duck", answerQuestion = "answer-question", requestDiff = "request-diff"
    case invite, removeMember = "remove-member", changeRole = "change-role", renamePond = "rename-pond", deletePond = "delete-pond"
    case approveStart = "approve-start", setPolicy = "set-policy", approveEdit = "approve-edit", stop
}

/// The daemon's verdict on one action: allowed, or refused with its sentence (nil when it gave none).
public enum PondVerdict: Sendable, Equatable {
    case allowed
    case refused(String?)
}

/// `me.can` / `members[].can` as the daemon wrote it: action name to `true` or a refusal sentence. An entry of any other
/// shape is skipped (it reads as unknown, never as a failed pond).
public struct PondVerdicts: Sendable, Equatable, Decodable {
    public var map: [String: PondVerdict]

    public init(map: [String: PondVerdict]) { self.map = map }

    public init(from decoder: Decoder) throws {
        struct Entry: Decodable {
            let verdict: PondVerdict?
            init(from decoder: Decoder) throws {
                let c = try decoder.singleValueContainer()
                if let b = try? c.decode(Bool.self) { verdict = b ? .allowed : .refused(nil) }
                else if let s = try? c.decode(String.self) {
                    let t = s.trimmingCharacters(in: .whitespacesAndNewlines)
                    verdict = .refused(t.isEmpty ? nil : t)
                } else { verdict = nil }
            }
        }
        let raw = (try? decoder.singleValueContainer().decode([String: Entry].self)) ?? [:]
        map = raw.compactMapValues(\.verdict)
    }
}

/// What a person may do in a pond: the daemon's `can` when it sent one, else (an older daemon) what the role used to mean.
/// Every view and plan asks this; none compares a role.
public struct PondCan: Sendable, Equatable {
    public var verdicts: PondVerdicts?
    /// Only read for an older daemon, in `roleDefault`.
    private var role: PondRole

    public init(_ verdicts: PondVerdicts? = nil, role: PondRole) { self.verdicts = verdicts; self.role = role }
    public init(role: PondRole) { self.init(nil, role: role) }

    /// Nothing known: the old role logic, for a daemon that sends no `can`.
    private func roleDefault(_ action: PondAction) -> Bool {
        switch action {
        case .postRoom, .makeTask, .startDuck, .messageDuck, .answerQuestion: role != .viewer
        case .requestDiff: true
        case .invite, .removeMember, .changeRole, .renamePond, .deletePond, .approveStart, .approveEdit, .stop: role == .owner
        // The route is new: an older daemon cannot save a policy, so nothing is offered.
        case .setPolicy: false
        }
    }

    public func verdict(_ action: PondAction) -> PondVerdict {
        if let v = verdicts?.map[action.rawValue] { return v }
        return roleDefault(action) ? .allowed : .refused(nil)
    }

    public func allows(_ action: PondAction) -> Bool { verdict(action) == .allowed }

    /// The daemon's sentence for a refusal; nil when allowed, or refused without one (the caller words it).
    public func reason(_ action: PondAction) -> String? {
        if case .refused(let why) = verdict(action) { return why }
        return nil
    }
}

// MARK: The policy

/// How Members reach Ducks: only in the Room (default), or directly too.
public enum ReachDucks: String, Sendable, Equatable, CaseIterable {
    case room, direct
    public var title: String { self == .room ? "In the Room" : "Directly" }
}

/// How Members start Ducks: from the Room (default), asking the Owner first, or freely.
public enum StartDucks: String, Sendable, Equatable, CaseIterable {
    case room, membersApproval = "members-approval", members
    public var title: String {
        switch self {
        case .room: "From the Room"
        case .membersApproval: "Ask the Owner first"
        case .members: "Freely"
        }
    }
    /// A Duck a Member asks for waits for the Owner.
    public var waitsForOwner: Bool { self == .membersApproval }
}

/// One person's own settings, either of which may be absent (the Pond's applies).
public struct PondPolicyOverride: Sendable, Equatable, Decodable {
    public var reachDucks: ReachDucks?
    public var startDucks: StartDucks?

    public init(reachDucks: ReachDucks? = nil, startDucks: StartDucks? = nil) { self.reachDucks = reachDucks; self.startDucks = startDucks }

    enum CodingKeys: String, CodingKey { case reachDucks, startDucks }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        reachDucks = c.lenient(String.self, .reachDucks).flatMap(ReachDucks.init(rawValue:))
        startDucks = c.lenient(String.self, .startDucks).flatMap(StartDucks.init(rawValue:))
    }
}

/// The pond view's `policy`: the Owner's two settings and per-person overrides. Room first by default.
public struct PondPolicy: Sendable, Equatable, Decodable {
    public var reachDucks: ReachDucks
    public var startDucks: StartDucks
    public var overrides: [String: PondPolicyOverride]

    public static let standard = PondPolicy(reachDucks: .room, startDucks: .room)

    public init(reachDucks: ReachDucks = .room, startDucks: StartDucks = .room, overrides: [String: PondPolicyOverride] = [:]) {
        self.reachDucks = reachDucks; self.startDucks = startDucks; self.overrides = overrides
    }

    enum CodingKeys: String, CodingKey { case reachDucks, startDucks, overrides }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        reachDucks = c.lenient(String.self, .reachDucks).flatMap(ReachDucks.init(rawValue:)) ?? .room
        startDucks = c.lenient(String.self, .startDucks).flatMap(StartDucks.init(rawValue:)) ?? .room
        struct Entry: Decodable { let value: PondPolicyOverride?; init(from d: Decoder) throws { value = try? PondPolicyOverride(from: d) } }
        let raw = (try? c.decodeIfPresent([String: Entry].self, forKey: .overrides)) ?? nil
        overrides = (raw ?? [:]).compactMapValues(\.value).filter { $0.value.reachDucks != nil || $0.value.startDucks != nil }
    }
}

/// `me.policy` and `members[].policy`: what applies to one person, and which of the two is their own override.
public struct PondEffectivePolicy: Sendable, Equatable, Decodable {
    public var reachDucks: ReachDucks
    public var startDucks: StartDucks
    public var customReach: Bool
    public var customStart: Bool

    public init(reachDucks: ReachDucks = .room, startDucks: StartDucks = .room, customReach: Bool = false, customStart: Bool = false) {
        self.reachDucks = reachDucks; self.startDucks = startDucks; self.customReach = customReach; self.customStart = customStart
    }

    enum CodingKeys: String, CodingKey { case reachDucks, startDucks, custom }
    enum CustomKeys: String, CodingKey { case reachDucks, startDucks }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        reachDucks = c.lenient(String.self, .reachDucks).flatMap(ReachDucks.init(rawValue:)) ?? .room
        startDucks = c.lenient(String.self, .startDucks).flatMap(StartDucks.init(rawValue:)) ?? .room
        if let k = try? c.nestedContainer(keyedBy: CustomKeys.self, forKey: .custom) {
            customReach = k.lenient(Bool.self, .reachDucks) ?? false
            customStart = k.lenient(Bool.self, .startDucks) ?? false
        } else { customReach = false; customStart = false }
    }

    public var isCustom: Bool { customReach || customStart }
}

// MARK: Permissions (Pond settings) and the per-person menu (People)

/// What the Permissions section and the People menu offer and say, and the body each change sends. Pure.
public enum PondPermissions {
    public static let heading = "Permissions"
    public static let intro = "Who can reach and start Ducks in this Pond. Approving edits and Stop always stay with you."
    public static let reachLabel = "Members reach Ducks"
    public static let reachCaption = "In the Room (default): Members talk in the Room and the right Duck picks it up. Directly: they can also message a Duck."
    public static let startLabel = "Members start Ducks"
    public static let startCaption = "From the Room (default): a Member says what they need in the Room and a Duck is started. Ask the Owner first: they ask and you approve. Freely: they start one themselves."

    public static let reachChoices: [ReachDucks] = [.room, .direct]
    public static let startChoices: [StartDucks] = [.room, .membersApproval, .members]

    /// A picker row: the default is named in its title.
    public static func title(_ v: ReachDucks) -> String { v == .room ? "In the Room (default)" : v.title }
    public static func title(_ v: StartDucks) -> String { v == .room ? "From the Room (default)" : v.title }

    /// The per-person menu: "Same as the Pond" clears the override.
    public static let sameAsPond = "Same as the Pond"
    public static let reachMenuTitle = "Reach Ducks"
    public static let startMenuTitle = "Start Ducks"
    public static func personTitle(_ v: ReachDucks) -> String { v.title }
    public static func personTitle(_ v: StartDucks) -> String { v == .membersApproval ? "Ask first" : v.title }

    /// The line under a person's name when they have a custom setting; nil for the Pond's own.
    public static func customLine(_ p: PondEffectivePolicy?) -> String? {
        guard let p, p.isCustom else { return nil }
        var parts: [String] = []
        if p.customReach { parts.append(p.reachDucks == .direct ? "Can message Ducks directly" : "Reaches Ducks in the Room") }
        if p.customStart {
            switch p.startDucks {
            case .room: parts.append("Starts Ducks from the Room")
            case .membersApproval: parts.append("Starts Ducks after you approve")
            case .members: parts.append("Starts Ducks freely")
            }
        }
        return parts.joined(separator: " \u{00B7} ")
    }

    /// The Owner's Permissions section is offered only when the daemon says they may set the policy.
    public static func offered(_ can: PondCan) -> Bool { can.allows(.setPolicy) }

    /// What a person's menu offers: role changes and the two overrides, only for the Owner on someone else.
    public struct PersonMenu: Sendable, Equatable {
        public var roles: [PondRole]
        public var offersPolicy: Bool
    }

    public static func personMenu(owner: PondCan, you: Bool, connecting: Bool, currentRole: PondRole) -> PersonMenu? {
        guard !you, !connecting else { return nil }
        let roles = owner.allows(.changeRole) ? [PondRole.member, .viewer] : []
        let policy = owner.allows(.setPolicy)
        guard !roles.isEmpty || policy else { return nil }
        // An Owner row is fixed; the daemon refuses a role change on them and a policy has no effect.
        guard currentRole != .owner else { return nil }
        return PersonMenu(roles: roles, offersPolicy: policy)
    }

    /// `POST /native/ponds/<id>/policy` bodies.
    public static func body(reach: ReachDucks? = nil, start: StartDucks? = nil) -> NativeJSON {
        var o: [String: NativeJSON] = [:]
        if let reach { o["reachDucks"] = .string(reach.rawValue) }
        if let start { o["startDucks"] = .string(start.rawValue) }
        return .object(o)
    }

    /// One person's override: a value sets it, `nil` ("Same as the Pond") removes it. A field left out stays as it is.
    public static func overrideBody(member: String, reach: PondOverrideChange<ReachDucks> = .keep, start: PondOverrideChange<StartDucks> = .keep) -> NativeJSON {
        var one: [String: NativeJSON] = [:]
        if case .set(let v) = reach { one["reachDucks"] = v.map { .string($0.rawValue) } ?? .null }
        if case .set(let v) = start { one["startDucks"] = v.map { .string($0.rawValue) } ?? .null }
        return .object(["overrides": .object([member: .object(one)])])
    }
}

/// What a per-person menu choice does to one of their two settings.
public enum PondOverrideChange<V: Sendable & Equatable>: Sendable, Equatable {
    case keep
    /// A value, or nil for "Same as the Pond".
    case set(V?)
}
