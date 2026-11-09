import Foundation

/// DESIGN.md §8.10, the line under a finished turn: how long it took, when it ended, and the text a Copy takes.
/// Decided apart from the view so CI can test which message carries it and what it says.
public struct TurnFooter: Equatable, Sendable {
    /// From the person's message to the agent's last one; nil when either time is unknown.
    public var elapsed: TimeInterval?
    /// When the agent's last message of the turn was written.
    public var at: Date?
    /// Every agent message of the turn, in order, as one text (the "Copy whole turn" action).
    public var turnText: String

    /// "1m 19s · 4:03 PM", "4:03 PM" when the elapsed time is unknown, "" when neither is.
    public func line(timeFormat: (Date) -> String) -> String {
        [elapsed.map { ElapsedFormat.short($0) }, at.map(timeFormat)].compactMap { $0 }.joined(separator: " · ")
    }
}

public enum TurnFooters {
    /// The footer of each turn, keyed by the id of the turn's last agent message. The turn still being worked on has none,
    /// since its end is not known yet; a person's message that no agent text follows has none either.
    public static func make(_ messages: [ChatMessage], working: Bool) -> [String: TurnFooter] {
        var out: [String: TurnFooter] = [:]
        var start: Date?
        var texts: [String] = []
        var last: ChatMessage?

        func close(open: Bool) {
            defer { texts = []; last = nil }
            guard let last, !(open && working) else { return }
            var elapsed: TimeInterval?
            if let start, let end = last.at, end > start { elapsed = end.timeIntervalSince(start) }
            out[last.id] = TurnFooter(elapsed: elapsed, at: last.at, turnText: texts.joined(separator: "\n\n"))
        }

        for m in messages {
            switch m.role {
            case .user:
                close(open: false)
                start = m.at
            default:
                guard !m.text.isEmpty else { continue }
                texts.append(m.text)
                last = m
            }
        }
        close(open: true)
        return out
    }
}
