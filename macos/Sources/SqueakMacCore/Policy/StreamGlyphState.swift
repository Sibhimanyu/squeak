import Foundation

/// What a stream's dot-grid glyph says (DESIGN.md §3.3: state colours; the duck's yellow is never a state). Derived here,
/// from the daemon's and host's data only: the surfaces draw it and decide nothing.
public enum StreamGlyphState: Equatable, Sendable {
    case idle, working, waiting, failed, unread

    /// Waiting on you wins, then anything working (a duckling running counts), then a failed last turn, then a
    /// finished turn not yet opened; else idle. `ducklingsRunning` is the count of background helpers still running.
    public static func of(marks: [ChatMark?], ducklingsRunning: Int = 0) -> StreamGlyphState {
        let kinds = Set(marks.compactMap { $0?.kind })
        if kinds.contains(.waiting) { return .waiting }
        if kinds.contains(.working) || ducklingsRunning > 0 { return .working }
        if kinds.contains(.failed) { return .failed }
        if kinds.contains(.unread) { return .unread }
        return .idle
    }

    /// A stream's chats on this Mac, marks as the sidebar shows them.
    public static func of(chats: [HostSession], mark: (HostSession) -> ChatMark?) -> StreamGlyphState {
        of(marks: chats.map(mark), ducklingsRunning: chats.reduce(0) { $0 + $1.backgroundRunning })
    }

    /// A pond card's threads: this Mac's by their mark, another Mac's by the state its host reported.
    public static func of(rows: [PondChatRow]) -> StreamGlyphState {
        let marks: [ChatMark?] = rows.map { row in
            if let m = row.mark { return m }
            guard row.local == nil else { return nil }
            switch row.state {
            case .needsYou: return ChatMark(.waiting)
            case .working: return ChatMark(.working)
            case .failed: return ChatMark(.failed)
            case .finished: return nil
            }
        }
        return of(marks: marks, ducklingsRunning: rows.reduce(0) { $0 + $1.ducklingsRunning })
    }

    /// The word VoiceOver and tooltips add after the stream's name; nil when there is nothing to say.
    public var words: String? {
        switch self {
        case .idle: nil
        case .working: "working"
        case .waiting: "waiting on you"
        case .failed: "failed"
        case .unread: "finished, not opened yet"
        }
    }

    /// "Hong Kong, working".
    public func label(for name: String) -> String { [name, words].compactMap { $0 }.joined(separator: ", ") }
}
