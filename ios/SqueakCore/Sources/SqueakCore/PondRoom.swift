import Foundation

/// A pond's Room as the Mac reduces it for this phone (src/remote/pond-room.ts): written sealed into `live` only while
/// this phone's presence names the pond's Room (`room`), deleted when it leaves. Every row, state word, routing line
/// and switch is the Mac's: the phone draws them and decides nothing.
public struct PondRoomDoc: Codable, Equatable, Sendable {
    public enum Tone: String, Codable, Equatable, Sendable { case working, done, needs, failed }
    public enum TaskState: String, Codable, Equatable, Sendable { case waiting, working, blocked, done }

    /// One row of the Room: a message, a Duck's state line (collapsed, a tap shows its detail) or a Task card.
    public enum Item: Codable, Equatable, Sendable, Identifiable {
        case message(Message)
        case duck(DuckLine)
        case task(TaskCard)

        public var id: String {
            switch self {
            case .message(let m): return m.id
            case .duck(let d): return d.id
            case .task(let t): return t.id
            }
        }

        public var at: Int64 {
            switch self {
            case .message(let m): return m.at
            case .duck(let d): return d.at
            case .task(let t): return t.at
            }
        }

        private enum CodingKeys: String, CodingKey { case t }
        public init(from decoder: Decoder) throws {
            let kind = try decoder.container(keyedBy: CodingKeys.self).decode(String.self, forKey: .t)
            switch kind {
            case "message": self = .message(try Message(from: decoder))
            case "duck": self = .duck(try DuckLine(from: decoder))
            case "task": self = .task(try TaskCard(from: decoder))
            default: throw DecodingError.dataCorruptedError(forKey: .t, in: try decoder.container(keyedBy: CodingKeys.self), debugDescription: "row kind")
            }
        }

        public func encode(to encoder: Encoder) throws {
            switch self {
            case .message(let m): try m.encode(to: encoder)
            case .duck(let d): try d.encode(to: encoder)
            case .task(let t): try t.encode(to: encoder)
            }
        }
    }

    public struct Message: Codable, Equatable, Sendable, Identifiable {
        public var t: String = "message"
        public let id: String
        /// A person's name or a Duck's ("You" when this phone's person said it).
        public let who: String
        /// A Duck, not a person.
        public var duck: Bool? = nil
        /// This phone's person said it: drawn on the right.
        public let mine: Bool
        public let text: String
        /// Milliseconds since 1970.
        public let at: Int64
        /// "Make task" is offered on it.
        public var canTask: Bool? = nil

        public init(id: String, who: String, duck: Bool? = nil, mine: Bool, text: String, at: Int64, canTask: Bool? = nil) {
            self.id = id; self.who = who; self.duck = duck; self.mine = mine; self.text = text; self.at = at; self.canTask = canTask
        }
    }

    public struct DuckLine: Codable, Equatable, Sendable, Identifiable {
        public var t: String = "duck"
        public let id: String
        public let who: String
        public let tone: Tone
        /// The collapsed line.
        public let line: String
        /// What a tap shows beneath it; absent when the line says it all.
        public var detail: String? = nil
        public let at: Int64

        public init(id: String, who: String, tone: Tone, line: String, detail: String? = nil, at: Int64) {
            self.id = id; self.who = who; self.tone = tone; self.line = line; self.detail = detail; self.at = at
        }
    }

    public struct TaskCard: Codable, Equatable, Sendable, Identifiable {
        public var t: String = "task"
        public let id: String
        public let taskId: String
        public let title: String
        public let state: TaskState
        /// "Suggested" for a Task only proposed, else the state's word.
        public let stateLabel: String
        /// "→ given to Pixel (related to the icon work)".
        public var routing: String? = nil
        public var result: String? = nil
        /// The Owner may drop it.
        public var canDrop: Bool? = nil
        public let at: Int64

        public init(id: String, taskId: String, title: String, state: TaskState, stateLabel: String, routing: String? = nil,
                    result: String? = nil, canDrop: Bool? = nil, at: Int64) {
            self.id = id; self.taskId = taskId; self.title = title; self.state = state; self.stateLabel = stateLabel
            self.routing = routing; self.result = result; self.canDrop = canDrop; self.at = at
        }
    }

    public let v: Int
    public let pond: String
    /// This person may post, and the Mac's calm reason when not.
    public let canPost: Bool
    public var reason: String? = nil
    /// This person may make and drop Tasks.
    public let canTask: Bool
    /// A Member's page only: the sentence shown while the Owner's Mac is not running.
    public var offline: String? = nil
    public let items: [Item]
    public var seq: Int64? = nil

    public init(v: Int = 1, pond: String, canPost: Bool, reason: String? = nil, canTask: Bool, offline: String? = nil,
                items: [Item], seq: Int64? = nil) {
        self.v = v; self.pond = pond; self.canPost = canPost; self.reason = reason; self.canTask = canTask
        self.offline = offline; self.items = items; self.seq = seq
    }

    /// The `live` document id: the Mac's `pondRoomDoc` (the pond id hashed like a session key, under `room:`).
    public static func doc(for pondId: String) -> String { LiveTurn.handle(for: "room:" + pondId) + "-r" }

    /// The longest message the Mac takes.
    public static let maxText = 500
    /// The phrase the Mac's Task rules read as "make the last message a task" (docs/ponds.md, Tasks).
    public static let makeTaskPhrase = "Make it a task"
}

/// What the person has sent that the Room has not shown back yet, drawn after the Mac's rows so a message never
/// vanishes between "Send" and its arrival. Pure, so the reconcile tests without a phone.
public struct PondRoomPending: Equatable, Sendable, Identifiable {
    public let id: String
    public let text: String
    public var failed: String?
    /// When it was sent (ms); a message only reconciles with a row at or after this.
    public let at: Int64
    public init(id: String, text: String, failed: String? = nil, at: Int64) { self.id = id; self.text = text; self.failed = failed; self.at = at }
}

public enum PondRoomFeed {
    /// The pending rows still to draw: a sent one goes once the Mac shows a row of mine with the same words. A Member's
    /// message waits for the Owner's Mac, so it stays until that row arrives. A failed one stays until dismissed.
    public static func remaining(_ pending: [PondRoomPending], in doc: PondRoomDoc?) -> [PondRoomPending] {
        guard let doc else { return pending }
        var mine = doc.items.compactMap { item -> (String, Int64)? in
            if case .message(let m) = item, m.mine { return (m.text.trimmingCharacters(in: .whitespacesAndNewlines), m.at) }
            return nil
        }
        return pending.filter { p in
            guard p.failed == nil else { return true }
            let text = p.text.trimmingCharacters(in: .whitespacesAndNewlines)
            // Slack for clock difference between the phone and the Mac.
            if let i = mine.firstIndex(where: { $0.0 == text && $0.1 >= p.at - 120_000 }) {
                mine.remove(at: i)
                return false
            }
            return true
        }
    }
}
