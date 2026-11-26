import Foundation

/// A Duck being started, from Start until the host confirms. The page it was started on stays put the whole time (it
/// never navigates, never closes), the composer stays open, and a message typed and sent meanwhile is held here and
/// delivered, in order, once the host confirms. A failure keeps the page, the held messages and a Try again.
public struct DuckStart: Equatable, Sendable {
    public enum Phase: Equatable, Sendable { case idle, starting, failed(String) }

    public static let startingLine = "Starting\u{2026}"
    public static let retryLabel = "Try again"

    public private(set) var phase: Phase = .idle
    public private(set) var held: [String] = []
    /// Whether messages can be held for this start: it needs a target to deliver them to once confirmed (a chat, or a
    /// Pond thread). Starts that confirm with no target (the owner's Mac, a Conductor workspace) keep the old locked box.
    public private(set) var holds = false

    public init() {}

    public var isStarting: Bool { phase == .starting }

    /// "Starting…" while the host has not confirmed; nil otherwise.
    public var statusLine: String? { isStarting ? Self.startingLine : nil }

    /// The one sentence a failure shows.
    public var failure: String? { if case .failed(let why) = phase { why } else { nil } }

    public var canRetry: Bool { failure != nil }

    /// The composer takes typing and Enter: always, except while starting something that cannot hold a message.
    public var inputOpen: Bool { !isStarting || holds }

    public mutating func begin(holds: Bool) {
        phase = .starting
        self.holds = holds
    }

    /// Holds a message sent while starting. False (nothing held) when not starting, nothing can hold it, or it is empty.
    @discardableResult
    public mutating func hold(_ text: String) -> Bool {
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard isStarting, holds, !t.isEmpty else { return false }
        held.append(t)
        return true
    }

    /// The host confirmed: the held messages to deliver now, in the order they were sent.
    public mutating func confirm() -> [String] {
        let out = held
        held = []
        phase = .idle
        holds = false
        return out
    }

    /// The host did not start it: the page stays, the held messages stay for the retry.
    public mutating func fail(_ why: String) { phase = .failed(why) }
}

/// Where a Pond thread the host just started opens: its Duck's page, never the Pond page it was started from.
public enum StartedThreadOpen {
    /// The Duck's chat when this Mac already lists it, else the Pond's page for the thread. Both are a Duck's page.
    public static func destination(thread: PondThread, pond: String, pondId: String, local: SessionKey?) -> WorkbenchLocation {
        if let local { return .chat(local) }
        return .pondThread(pond: pond, pondId: pondId, threadId: thread.id)
    }

    /// The local chat for a started thread: the catalog's key whose host id is the thread's `sessionId`.
    public static func localKey(of thread: PondThread, among keys: [SessionKey]) -> SessionKey? {
        guard let id = thread.sessionId else { return nil }
        return keys.first { PondOpenResolver.hostId(of: $0) == id }
    }
}
