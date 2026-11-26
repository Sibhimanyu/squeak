import Foundation

/// An invitation for this Mac's account, as the daemon reads it from the relay's one invite record (`GET /native/ponds/invitations`).
/// `pending` waits for Join or Decline; `joined` is already a Member in the cloud and draws as Connecting until the Owner's Mac
/// lets this device in.
public struct PondInvitation: Sendable, Equatable, Identifiable, Decodable {
    public enum State: String, Sendable, Equatable { case pending, joined }

    public var id: String
    public var pondId: String
    public var pondName: String
    public var inviter: String
    public var role: PondRole
    public var state: State
    public var expiresAt: Date?

    enum CodingKeys: String, CodingKey { case id, pondId, pondName, inviter, role, state, expiresAt }

    public init(id: String, pondId: String, pondName: String, inviter: String, role: PondRole = .member, state: State = .pending, expiresAt: Date? = nil) {
        self.id = id; self.pondId = pondId; self.pondName = pondName; self.inviter = inviter
        self.role = role; self.state = state; self.expiresAt = expiresAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        pondId = try c.decode(String.self, forKey: .pondId)
        pondName = (try? c.decode(String.self, forKey: .pondName)).flatMap { $0.isEmpty ? nil : $0 } ?? "A pond"
        inviter = (try? c.decode(String.self, forKey: .inviter)).flatMap { $0.isEmpty ? nil : $0 } ?? "Someone"
        role = (try? c.decode(String.self, forKey: .role)).flatMap(PondRole.init(rawValue:)) ?? .member
        state = (try? c.decode(String.self, forKey: .state)).flatMap(State.init(rawValue:)) ?? .pending
        let ms = try? c.decode(Double.self, forKey: .expiresAt)
        expiresAt = ms.flatMap { $0 > 0 ? Date(timeIntervalSince1970: $0 / 1000) : nil }
    }
}

public enum PondInvitations {
    /// The invitations that wait on the person's answer.
    public static func toAnswer(_ list: [PondInvitation]) -> [PondInvitation] { list.filter { $0.state == .pending } }

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
