import Foundation

/// What a chat's banner says when session names are on: the thread and its pond as the title, and the agent's own
/// words (or the question, or what it wants to run) as one plain line. Nil when there is nothing better than the
/// generic text, so the caller falls back to it.
public enum NotificationText {
    public static let lineLimit = 120

    public struct Content: Equatable, Sendable {
        public var title: String
        public var body: String
    }

    /// `lastAgentText`: the chat's newest assistant message, raw markdown. `pond`: the project's name.
    public static func content(_ event: NotificationEvent, lastAgentText: String?, pond: String?) -> Content? {
        let body: String?
        switch event.kind {
        case .finished:
            body = line(lastAgentText)
        case .question:
            body = line(event.detail) ?? line(lastAgentText)
        case .plan:
            body = line(lastAgentText)
        case .blocked:
            body = event.body.hasSuffix("is waiting for your approval") ? "Wants to run a command" : nil
        case .error:
            body = nil
        }
        guard let body else { return nil }
        let name = (event.label ?? "").trimmingCharacters(in: .whitespaces)
        let pondName = (pond ?? "").trimmingCharacters(in: .whitespaces)
        let title = [name, pondName].filter { !$0.isEmpty }.joined(separator: " · ")
        return Content(title: title.isEmpty ? event.kind.stateTitle : title, body: body)
    }

    /// One plain line: markdown stripped, whitespace folded, cut at a word with an ellipsis. Nil when empty.
    public static func line(_ text: String?) -> String? {
        guard let text else { return nil }
        let flat = NotificationContextPolicy.excerpt(text, limit: lineLimit)
        return flat.isEmpty ? nil : flat
    }
}
