import Foundation

public enum NotificationKind: String, Codable, Sendable, Hashable {
    /// Waiting on a tool approval, or on the human in a way the source cannot name.
    case blocked
    /// Asking a question (AskUserQuestion), with or without options.
    case question
    /// Has a plan for the human to review (ExitPlanMode).
    case plan
    case finished, error
}

/// What to tell the user. The body names the session and the event; `detail`
/// carries what the agent is asking, shown only when session names are on.
public struct NotificationEvent: Sendable, Hashable {
    public var key: SessionKey
    public var kind: NotificationKind
    public var title: String
    public var body: String
    /// The agent's question, for a `.question`. Session content: shown only by opt-in.
    public var detail: String?
    /// Stable identity of this one event, set when the detector is told the time. Nil in tests that
    /// do not care; a notification without one carries no event context.
    public var id: String?
    public var at: Date?

    public init(
        key: SessionKey, kind: NotificationKind, title: String, body: String, detail: String? = nil,
        id: String? = nil, at: Date? = nil
    ) {
        self.key = key; self.kind = kind; self.title = title; self.body = body; self.detail = detail
        self.id = id; self.at = at
    }

    /// `<session>|<kind>|<epoch ms>`: no session text, only opaque ids and the time.
    public static func eventId(key: SessionKey, kind: NotificationKind, at: Date) -> String {
        "\(key.stringValue)|\(kind.rawValue)|\(Int((at.timeIntervalSince1970 * 1000).rounded()))"
    }
}

public enum NotificationPolicy {
    /// Transition detector between two polls. `previous == nil` is the first load:
    /// nothing is announced. A session not in `previous` has no observed
    /// transition, so it is not announced either. A chat that was already
    /// waiting is announced again when it asks something new: a second
    /// question is as much news as the first.
    public static func detect(previous: [HostSession]?, current: [HostSession], at: Date? = nil) -> [NotificationEvent] {
        guard let previous else { return [] }
        func stamped(_ e: NotificationEvent) -> NotificationEvent {
            guard let at else { return e }
            var e = e
            e.at = at
            e.id = NotificationEvent.eventId(key: e.key, kind: e.kind, at: at)
            return e
        }
        let before = Dictionary(previous.map { ($0.key, $0) }, uniquingKeysWith: { _, b in b })
        var out: [NotificationEvent] = []
        for s in current {
            guard let old = before[s.key] else { continue }
            if s.state == .blocked {
                let newAsk = s.pendingQuestion != nil && s.pendingQuestion != old.pendingQuestion
                guard old.state != .blocked || newAsk else { continue }
                out.append(stamped(blocked(s)))
                continue
            }
            guard old.state != s.state else { continue }
            switch s.state {
            case .finished where s.key.provider == "conductor":
                out.append(stamped(event(s, .finished, "finished")))
            case .error:
                out.append(stamped(event(s, .error, "hit an error")))
            default:
                break
            }
        }
        return out
    }

    private static func blocked(_ s: HostSession) -> NotificationEvent {
        if let ask = s.pendingQuestion {
            if ask == PendingQuestion.planDetail { return event(s, .plan, "has a plan for you to review") }
            return event(s, .question, "is asking you something", detail: ask)
        }
        if s.awaitingApproval == true { return event(s, .blocked, "needs your approval") }
        return event(s, .blocked, "is waiting for you")
    }

    private static func event(
        _ s: HostSession, _ kind: NotificationKind, _ phrase: String, detail: String? = nil
    ) -> NotificationEvent {
        NotificationEvent(key: s.key, kind: kind, title: "Squeak", body: "\(s.label) \(phrase)", detail: detail)
    }
}
