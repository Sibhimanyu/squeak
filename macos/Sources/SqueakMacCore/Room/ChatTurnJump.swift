import Foundation

/// A tap in the Room that opens a Duck's chat at one turn (`PondOpenTarget.turn`). The chat draws its turns under its own row
/// keys (a turn made on this Mac keeps the key it had while it was only a press), so the turn the Room names, the host's bare
/// turn id, is looked up among them. When the turn is not loaded (an older page) nothing is found and the chat just opens.
public enum ChatTurnJump {
    public struct Row: Equatable, Sendable {
        public var id: String
        public var turnId: String?
        public init(id: String, turnId: String?) { self.id = id; self.turnId = turnId }
    }

    public static func rowId(turnId: String, among rows: [Row]) -> String? {
        rows.first { $0.turnId == turnId }?.id ?? rows.first { $0.id == turnId }?.id
    }

    /// A request to scroll one chat to one turn. `token` makes the same turn asked twice a new request.
    public struct Request: Equatable, Sendable {
        public var chat: String
        public var turnId: String
        public var token: Int
        public init(chat: String, turnId: String, token: Int) { self.chat = chat; self.turnId = turnId; self.token = token }
    }

    /// The request a Room tap makes: only a turn target asks for a place; a plain chat target keeps the chat where it was.
    public static func request(for target: PondOpenTarget, chat: String, previous: Request?) -> Request? {
        guard case .turn(_, let turnId) = target else { return nil }
        return Request(chat: chat, turnId: turnId, token: (previous?.token ?? 0) + 1)
    }
}
