import Foundation

/// Conductor's `markSessionOptimisticallyWorking`: the chat reads "working" the instant Send is pressed, before
/// the host has said anything, and a status that was already on its way cannot take that back.
///
/// Why the glyph used to come late: the live row, the Stop button and the composer's Return/⌘Return routing read
/// the catalog's `state`, which only moves when the host's `working` status has been polled or streamed and
/// the catalog refreshed (a hop and a read after the send); in between, only the "last message is mine" rule drew a
/// bare glyph, and any `idle` already in flight (the previous turn's end, a poll that began before the send)
/// switched it off again. Here the send itself starts the state, and only an `idle`/`error` that the host
/// reports *after our own message* (by seq on a Squeak chat, by having seen `working` first elsewhere) ends it.
public struct OptimisticWork: Equatable, Sendable {
    /// A send that no host has answered for this long stops counting (the host never started a turn).
    public static let cap: TimeInterval = 180

    public private(set) var sentAt: Date?
    /// The newest message seq known when the send began (Squeak chats); our own message is the next user row above it.
    public private(set) var baselineSeq: Int?
    /// The host has shown our own message (seq above the baseline).
    public private(set) var sawOwnMessage = false
    /// The host has said `working` since the send.
    public private(set) var sawWorking = false

    public init() {}

    public var isStarted: Bool { sentAt != nil }

    /// Send was pressed: the chat is working now. A second send while one is in flight keeps the first's start.
    public mutating func begin(at now: Date, baselineSeq: Int? = nil) {
        guard sentAt == nil else { return }
        self = OptimisticWork()
        sentAt = now
        self.baselineSeq = baselineSeq
    }

    /// The send did not go: revert at once.
    public mutating func failed() { self = OptimisticWork() }

    /// A message row reached the Mac from the host's stream.
    public mutating func observe(message seq: Int, role: MessageRole) {
        guard sentAt != nil, role == .user, let base = baselineSeq, seq > base else { return }
        sawOwnMessage = true
    }

    /// A status from the host. `working` is recorded; a non-working one ends the optimism only when it is provably
    /// newer than the send: our own message has been seen (an ordered stream: everything after it is about our
    /// turn), or `working` was seen first (so this is that turn's end).
    public mutating func observe(status: SessionState) {
        guard sentAt != nil else { return }
        switch status {
        case .working:
            sawWorking = true
        case .blocked:
            break
        case .idle, .finished, .error, .unknown:
            if sawOwnMessage || sawWorking { self = OptimisticWork() }
        }
    }

    /// A chat with no seq to compare (Conductor, terminal): the agent's reply to the send has landed and the host is not
    /// working, so the turn was a short one the Mac never saw `working` for.
    public mutating func observeReply(host: SessionState) {
        guard sentAt != nil, host != .working, host != .blocked else { return }
        self = OptimisticWork()
    }

    /// The state to draw. A blocked chat is never overridden (it waits on the person); an old `idle`/`finished`
    /// does not override a send newer than it.
    public func resolve(host: SessionState, now: Date) -> SessionState {
        guard let sentAt, now.timeIntervalSince(sentAt) < Self.cap else { return host }
        switch host {
        case .blocked: return host
        case .error: return sawOwnMessage || sawWorking ? host : .working
        default: return .working
        }
    }

    public func isActive(host: SessionState, now: Date) -> Bool {
        resolve(host: host, now: now) == .working && host != .working
    }
}

/// What a message you sent looks like in the transcript, by where it has got to: visual only, no words.
public enum SentBubble {
    public enum Look: Equatable, Sendable {
        /// Not taken in yet: the bubble at reduced opacity, no text beside it.
        case sending
        /// The agent has it (the host's transcript shows it): full opacity.
        case taken
        /// It did not go: a danger outline and an inline Retry; the words are back in the draft.
        case failed
    }

    public static let sendingOpacity: Double = 0.55

    public static func look(_ message: ChatMessage) -> Look {
        switch message.state {
        case .pending, .accepted, .uncertain: .sending
        case .refused, .notSent: .failed
        case .draft, .confirmed, nil: .taken
        }
    }

    public static func opacity(_ look: Look) -> Double { look == .sending ? sendingOpacity : 1 }
}
