import Foundation
import SqueakCore

/// Lazy paging of a chat's earlier messages, decided apart from the views so CI can test it.
enum EarlierPaging {
    enum Load: Equatable { case idle, loading, failed }

    /// What sits above the first message of a chat.
    enum Row: Equatable {
        case none
        /// More to load: asks for it when it comes on screen.
        case sentinel
        case loading
        /// "Start of chat": the oldest message is held.
        case start
        /// "Couldn't load earlier messages. Try again."
        case failed
    }

    /// Only a Conductor chat the Mac can read, over a streaming channel (the page comes back in a live document).
    static func available(session: PhoneSnapshot.Session, streamed: Bool, demo: Bool) -> Bool {
        !demo && streamed && session.conductorSessionId != nil
    }

    static func row(available: Bool, state: ChatHistoryState?, load: Load) -> Row {
        // A chat with no history held (a terminal agent, or one not read yet) has nothing to load above it.
        guard available, let state, !state.entries.isEmpty else { return .none }
        switch load {
        case .loading: return .loading
        case .failed: return .failed
        case .idle: return state.complete ? .start : .sentinel
        }
    }

    /// Whether to ask the Mac now. One request per chat at a time; after a failure only a deliberate try
    /// (a tap, a pull) goes again, so a bad link is not hammered by the sentinel.
    static func shouldFetch(available: Bool, state: ChatHistoryState?, load: Load, manual: Bool) -> Bool {
        guard available, let state, !state.entries.isEmpty, !state.complete, load != .loading else { return false }
        return load == .idle || manual
    }

    /// Whether an answer still belongs to what was asked: the same chat, and the cursor sent.
    static func matches(_ page: HistoryPage, key: String, before: String?) -> Bool {
        page.key == key && page.before == before
    }
}

/// Keeping the reader's place when older messages land above: the message that was first stays where it was.
enum PrependAnchor {
    /// The row to scroll back to, or nil to leave the scroll alone: only when older rows just arrived, the reader
    /// is not following the bottom, and the old first row is still there below new ones.
    static func target(oldTop: String?, newTop: String?, ids: [String], prepended: Bool, following: Bool) -> String? {
        guard prepended, !following, let oldTop, newTop != oldTop, ids.contains(oldTop) else { return nil }
        return oldTop
    }

    /// The id the chat is anchored on: its first message row (the "Start of chat" and spinner rows are not in `rows`).
    static func topID(_ rows: [ChatTimeline.Row]) -> String? {
        rows.first { if case .empty = $0 { false } else { true } }?.id
    }
}

/// What the outbox keeps of sends that did not settle. A failure settled long ago goes; a send nobody could
/// confirm is settled by the chat's own history once that proves or disproves it.
enum OutboxPolicy {
    /// How long past a send the history must reach, with no sign of it, to say it never arrived.
    static let disproveAfter: TimeInterval = 10 * 60

    static func prune(_ sends: [ChatSend], history: [LiveTurn.HistoryEntry]?, now: Date = Date()) -> [ChatSend] {
        sends.compactMap { send in
            guard send.status.failed else { return send }
            if now.timeIntervalSince(send.origin) > ChatTimeline.failedKeep { return nil }
            guard case .notConfirmed = send.status else { return send }
            var copy = send
            if ChatTimeline.arrived(send, in: history) || ChatTimeline.arrivedByTime(send, in: history) {
                copy.status = .sent
            } else if let history, let oldest = history.first?.date, let newest = history.last?.date,
                      oldest <= send.origin, newest >= send.origin.addingTimeInterval(disproveAfter) {
                // The history covers that moment and goes on well past it without the message: it never arrived.
                copy.status = .refused("it never reached the chat.")
            }
            return copy
        }
    }
}
