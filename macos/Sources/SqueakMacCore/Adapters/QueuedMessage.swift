import Foundation

/// A message waiting in a Conductor chat's queue (the daemon's `GET /control/session/<id>/queue`).
public struct QueuedMessage: Sendable, Equatable, Identifiable, Decodable {
    public let id: String
    public let text: String
    public let isSteer: Bool
    public let position: Int

    public init(id: String, text: String, isSteer: Bool = false, position: Int = 0) {
        self.id = id
        self.text = text
        self.isSteer = isSteer
        self.position = position
    }

    private enum CodingKeys: String, CodingKey { case id, text, mode, position }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        text = (try? c.decode(String.self, forKey: .text)) ?? ""
        isSteer = (try? c.decode(String.self, forKey: .mode)) == "steer"
        position = (try? c.decode(Int.self, forKey: .position)) ?? 0
    }
}

struct DaemonQueueBody: Decodable {
    let items: [QueuedMessage]
}

/// What happened to a steer or delete on a queued message. Never retried.
public enum QueueChangeResult: Sendable, Equatable {
    case done
    /// The message already went to the agent (or is gone): refresh the list.
    case alreadySent
    case failed(reason: String)
}
