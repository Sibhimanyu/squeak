import Foundation

// The chat timeline's wire shapes: the events the session host writes (src/native/timeline.ts) and a pond relays.
// Every stored event has a per-chat `seq`; a reducer (`TurnTimeline`) applies them in order and never reads anything else.

/// Who wrote a prompt. Absent on the host's own person ("You"); a pond member carries their name and initial.
public struct TimelineAuthor: Hashable, Sendable, Codable {
    public var id: String
    public var name: String
    public var initial: String

    public init(id: String, name: String, initial: String? = nil) {
        self.id = id
        self.name = name
        self.initial = initial ?? String(name.trimmingCharacters(in: .whitespaces).first.map { String($0).uppercased() } ?? "?")
    }
}

public enum TimelineStepKind: String, Sendable, Codable, Hashable {
    case thinking, tool, note, waiting, retrying, steer, error, progress
    /// A kind a newer host sent: kept (so it never disappears) but drawn as a plain note.
    case other
}

public enum TimelineStepStatus: String, Sendable, Codable, Hashable { case running, done, failed }

public enum TimelineOutcome: String, Sendable, Codable, Hashable { case done, stopped, failed }

/// The ephemeral text of the message being written, from `offset` on. It has no `seq` and is never stored.
public struct ReplyDelta: Equatable, Sendable {
    public var turnId: String
    public var blockKey: String
    public var offset: Int
    public var text: String

    public init(turnId: String, blockKey: String, offset: Int, text: String) {
        self.turnId = turnId; self.blockKey = blockKey; self.offset = offset; self.text = text
    }
}

public struct TimelineStepEvent: Equatable, Sendable {
    public var turnId: String
    public var stepId: String
    public var kind: TimelineStepKind
    public var label: String
    public var detail: [String: NativeJSON]
    public var status: TimelineStepStatus
    public var author: TimelineAuthor?

    public init(
        turnId: String, stepId: String, kind: TimelineStepKind, label: String, detail: [String: NativeJSON] = [:],
        status: TimelineStepStatus, author: TimelineAuthor? = nil
    ) {
        self.turnId = turnId; self.stepId = stepId; self.kind = kind; self.label = label; self.detail = detail
        self.status = status; self.author = author
    }
}

public struct TimelineEvent: Equatable, Sendable, Decodable {
    public enum Body: Equatable, Sendable {
        case turnStarted(
            turnId: String, promptMessageId: String, clientNonce: String?, text: String, author: TimelineAuthor?,
            queuedId: String?, auto: Bool)
        case promptQueued(queuedId: String, text: String, author: TimelineAuthor?, clientNonce: String?)
        case promptDequeued(queuedId: String)
        /// `step.added` and `step.updated` are one thing to a reader: the step with this id, as it is now.
        case step(TimelineStepEvent)
        case replyDone(turnId: String, messageId: String, blockKey: String?, text: String)
        case turnEnded(turnId: String, outcome: TimelineOutcome, error: String?, replyMessageId: String?)
        /// A type a newer host wrote: it takes its place in the order and changes nothing.
        case unknown(String)
    }

    public var seq: Int
    public var at: Date?
    public var body: Body

    public init(seq: Int, at: Date? = nil, body: Body) { self.seq = seq; self.at = at; self.body = body }

    enum CodingKeys: String, CodingKey {
        case seq, type, at, turnId, promptMessageId, clientNonce, text, author, queuedId, auto, stepId, kind, label, detail
        case status, messageId, blockKey, outcome, error, replyMessageId
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        seq = try c.decode(Int.self, forKey: .seq)
        at = c.lenient(String.self, .at).flatMap { DaemonDate.parse($0) }
        let type = c.lenient(String.self, .type) ?? ""
        func s(_ k: CodingKeys) -> String { c.lenient(String.self, k) ?? "" }
        let author = c.lenient(TimelineAuthor.self, .author)
        switch type {
        case "turn.started":
            body = .turnStarted(
                turnId: s(.turnId), promptMessageId: s(.promptMessageId), clientNonce: c.lenient(String.self, .clientNonce),
                text: s(.text), author: author, queuedId: c.lenient(String.self, .queuedId), auto: c.lenient(Bool.self, .auto) ?? false)
        case "prompt.queued":
            body = .promptQueued(queuedId: s(.queuedId), text: s(.text), author: author, clientNonce: c.lenient(String.self, .clientNonce))
        case "prompt.dequeued":
            body = .promptDequeued(queuedId: s(.queuedId))
        case "step.added", "step.updated":
            let kind = c.lenient(String.self, .kind).flatMap(TimelineStepKind.init(rawValue:)) ?? .other
            let status = c.lenient(String.self, .status).flatMap(TimelineStepStatus.init(rawValue:)) ?? .done
            body = .step(
                TimelineStepEvent(
                    turnId: s(.turnId), stepId: s(.stepId), kind: kind, label: s(.label),
                    detail: c.lenient([String: NativeJSON].self, .detail) ?? [:], status: status, author: author))
        case "reply.done":
            body = .replyDone(turnId: s(.turnId), messageId: s(.messageId), blockKey: c.lenient(String.self, .blockKey), text: s(.text))
        case "turn.ended":
            body = .turnEnded(
                turnId: s(.turnId), outcome: c.lenient(String.self, .outcome).flatMap(TimelineOutcome.init(rawValue:)) ?? .done,
                error: c.lenient(String.self, .error), replyMessageId: c.lenient(String.self, .replyMessageId))
        default:
            body = .unknown(type)
        }
    }

    /// The ephemeral delta frame, which has no `seq`: nil for anything else.
    public static func replyDelta(from data: Data) -> ReplyDelta? {
        struct Wire: Decodable {
            var type: String?
            var turnId: String?
            var blockKey: String?
            var offset: Int?
            var text: String?
        }
        guard let w = try? JSONDecoder().decode(Wire.self, from: data), w.type == "reply.delta",
              let turn = w.turnId, let key = w.blockKey, let offset = w.offset, let text = w.text else { return nil }
        return ReplyDelta(turnId: turn, blockKey: key, offset: offset, text: text)
    }
}

/// A page of the host's log (`GET /native/sessions/<id>/timeline`).
public struct TimelinePage: Equatable, Sendable, Decodable {
    public var events: [TimelineEvent]
    public var lastSeq: Int
    public var hasEarlier: Bool

    enum CodingKeys: String, CodingKey { case events, lastSeq, hasEarlier }

    public init(events: [TimelineEvent], lastSeq: Int, hasEarlier: Bool) {
        self.events = events; self.lastSeq = lastSeq; self.hasEarlier = hasEarlier
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        // One event that does not decode (no seq) is dropped; the rest of the page stands.
        events = (try? c.decode([Failable<TimelineEvent>].self, forKey: .events))?.compactMap(\.value) ?? []
        lastSeq = c.lenient(Int.self, .lastSeq) ?? events.last?.seq ?? 0
        hasEarlier = c.lenient(Bool.self, .hasEarlier) ?? false
    }
}
