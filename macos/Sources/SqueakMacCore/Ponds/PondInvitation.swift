import Foundation

/// An invitation for this Mac's account, as the daemon reads it from the relay's one invite record (`GET /native/ponds/invitations`).
/// `pending` waits for Join or Decline; `joined` is already a Member in the cloud and draws as Connecting until the Owner's Mac
/// lets this device in. The list normally holds only those two; an answer's fresh view can also say declined, withdrawn or expired.
public struct PondInvitation: Sendable, Equatable, Identifiable, Decodable {
    public enum State: String, Sendable, Equatable { case pending, joined, declined, withdrawn, expired }

    public var id: String
    public var pondId: String
    public var pondName: String
    public var inviter: String
    public var role: PondRole
    public var state: State
    public var expiresAt: Date?
    /// The account is already a Member of the Pond in the cloud.
    public var youAreMember: Bool

    /// Said when the daemon names no inviter (it never sends a blank, and never "Someone").
    public static let unnamedInviter = "A teammate"

    enum CodingKeys: String, CodingKey { case id, pondId, pondName, inviter, role, state, expiresAt, youAreMember }

    public init(id: String, pondId: String, pondName: String, inviter: String, role: PondRole = .member, state: State = .pending, expiresAt: Date? = nil, youAreMember: Bool = false) {
        self.id = id; self.pondId = pondId; self.pondName = pondName; self.inviter = inviter
        self.role = role; self.state = state; self.expiresAt = expiresAt; self.youAreMember = youAreMember
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        pondId = try c.decode(String.self, forKey: .pondId)
        pondName = (try? c.decode(String.self, forKey: .pondName)).flatMap { $0.isEmpty ? nil : $0 } ?? "A pond"
        inviter = (try? c.decode(String.self, forKey: .inviter)).flatMap { $0.isEmpty ? nil : $0 } ?? Self.unnamedInviter
        role = (try? c.decode(String.self, forKey: .role)).flatMap(PondRole.init(rawValue:)) ?? .member
        state = (try? c.decode(String.self, forKey: .state)).flatMap(State.init(rawValue:)) ?? .pending
        let ms = try? c.decode(Double.self, forKey: .expiresAt)
        expiresAt = ms.flatMap { $0 > 0 ? Date(timeIntervalSince1970: $0 / 1000) : nil }
        youAreMember = (try? c.decode(Bool.self, forKey: .youAreMember)) ?? false
    }

    /// Still on the list: waiting for an answer, or joined and opening.
    public var isListed: Bool { state == .pending || state == .joined }
}

/// The daemon's answer to `GET /native/ponds/invitations`. `stale`: it could not read the cloud just now and this is the last good list.
public struct PondInvitationList: Sendable, Equatable, Decodable {
    public var invitations: [PondInvitation]
    public var stale: Bool

    enum CodingKeys: String, CodingKey { case invitations, stale }

    public init(invitations: [PondInvitation], stale: Bool = false) { self.invitations = invitations; self.stale = stale }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        invitations = try c.decode([Failable<PondInvitation>].self, forKey: .invitations).compactMap(\.value)
        stale = (try? c.decode(Bool.self, forKey: .stale)) ?? false
    }
}

/// A refused Join or Decline: the daemon's plain sentence and, when it sent one, the fresh view of the invitation.
public struct PondInvitationRefusal: Error, Sendable, Equatable {
    public var sentence: String
    public var invitation: PondInvitation?
    public init(sentence: String, invitation: PondInvitation? = nil) { self.sentence = sentence; self.invitation = invitation }
}

public enum PondInvitations {
    /// The invitations that wait on the person's answer.
    public static func toAnswer(_ list: [PondInvitation]) -> [PondInvitation] { list.filter { $0.state == .pending } }

    /// The quiet line under the list when the daemon could not read the cloud: the text, then the action beside it.
    public static let staleText = "Couldn't refresh \u{00B7} "
    public static let staleAction = "Try again"
    public static let staleLine = staleText + staleAction

    /// The list after the daemon answered one invitation: its fresh view replaces the row (or joins the list when the row was
    /// not there); a view that is no longer pending or joined drops it. The order of the rest is kept.
    public static func applying(_ view: PondInvitation, to list: [PondInvitation]) -> [PondInvitation] {
        var out = list
        if let at = out.firstIndex(where: { $0.id == view.id }) {
            if view.isListed { out[at] = view } else { out.remove(at: at) }
        } else if view.isListed { out.append(view) }
        return out
    }

    public static func line(_ i: PondInvitation) -> String { "\(i.inviter) invited you to \(i.pondName) as a \(i.role.word.lowercased())." }

    /// One notification per invite, ever: `seen` holds the ids already announced (the caller keeps it between launches).
    /// Returns the notes to post and the new seen set. Answered or gone invites stay in `seen` so a re-read never repeats one.
    public static func notes(list: [PondInvitation], seen: Set<String>) -> (notes: [PondNote], seen: Set<String>) {
        var seen = seen
        var out: [PondNote] = []
        for i in toAnswer(list) where seen.insert(i.id).inserted {
            out.append(PondNote(id: "pond-invite-\(i.id)", kind: .invited, title: "\(i.inviter) invited you to \(i.pondName)", body: "Join or decline in Squeak.", pondId: i.pondId))
        }
        return (out, seen)
    }
}
