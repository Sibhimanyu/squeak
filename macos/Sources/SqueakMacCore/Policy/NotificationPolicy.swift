import Foundation

public enum NotificationKind: String, Sendable, Hashable {
    case blocked, finished, error
}

/// What to tell the user. The body names the session and the event; it never
/// carries message content.
public struct NotificationEvent: Sendable, Hashable {
    public var key: SessionKey
    public var kind: NotificationKind
    public var title: String
    public var body: String
}

public enum NotificationPolicy {
    /// Transition detector between two polls. `previous == nil` is the first load:
    /// nothing is announced. A session not in `previous` has no observed
    /// transition, so it is not announced either.
    public static func detect(previous: [HostSession]?, current: [HostSession]) -> [NotificationEvent] {
        guard let previous else { return [] }
        let before = Dictionary(previous.map { ($0.key, $0.state) }, uniquingKeysWith: { _, b in b })
        var out: [NotificationEvent] = []
        for s in current {
            guard let old = before[s.key], old != s.state else { continue }
            switch s.state {
            case .blocked:
                out.append(event(s, .blocked, "needs your approval"))
            case .finished where s.key.provider == "conductor":
                out.append(event(s, .finished, "finished"))
            case .error:
                out.append(event(s, .error, "hit an error"))
            default:
                break
            }
        }
        return out
    }

    private static func event(_ s: HostSession, _ kind: NotificationKind, _ phrase: String) -> NotificationEvent {
        NotificationEvent(key: s.key, kind: kind, title: "Squeak", body: "\(s.label) \(phrase)")
    }
}
