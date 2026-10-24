import Foundation

/// One page of a chat's history, oldest first.
public struct TranscriptPage: Sendable, Equatable {
    public var messages: [ChatMessage]
    /// Where the messages before these start (pass it as `before`); nil when nothing precedes them.
    public var nextBefore: String?
    public var complete: Bool { nextBefore == nil }

    public init(messages: [ChatMessage], nextBefore: String?) {
        self.messages = messages
        self.nextBefore = nextBefore
    }
}

public protocol HostAdapter: Sendable {
    var id: String { get }
    func discover() async throws -> [HostSession]
    func transcript(for session: HostSession, limit: Int) async throws -> [ChatMessage]
    /// `limit` messages strictly before the cursor `before` (nil: the newest). A host that cannot page
    /// answers with what `transcript` gives and no cursor.
    func transcriptPage(for session: HostSession, limit: Int, before: String?) async throws -> TranscriptPage
    func activity(for session: HostSession) async throws -> [ActivityStep]
    func send(_ text: String, to session: HostSession, clientId: UUID) async -> SendResult
    /// Same, saying how to meet an agent that is mid-turn. An adapter that cannot steer ignores `mode`
    /// and queues, and says so in the result's `note` when steering was asked for.
    func send(_ text: String, to session: HostSession, clientId: UUID, mode: SendMode) async -> SendResult
    /// Same, naming the turn the text answers, so a host that checks refuses it once the chat has moved on.
    /// An adapter with no such check ignores `answersTurn`.
    func send(_ text: String, to session: HostSession, clientId: UUID, mode: SendMode, answersTurn: String?) async -> SendResult
    func openInHostURL(for session: HostSession) -> URL?
    func health() async -> AdapterHealth
}

public extension HostAdapter {
    func send(_ text: String, to session: HostSession, clientId: UUID, mode: SendMode) async -> SendResult {
        await send(text, to: session, clientId: clientId)
    }

    func transcriptPage(for session: HostSession, limit: Int, before: String?) async throws -> TranscriptPage {
        // Cannot page: the newest window is all there is, and nothing is "before" it.
        guard before == nil else { return TranscriptPage(messages: [], nextBefore: nil) }
        return TranscriptPage(messages: try await transcript(for: session, limit: limit), nextBefore: nil)
    }

    func send(_ text: String, to session: HostSession, clientId: UUID, mode: SendMode, answersTurn: String?) async -> SendResult {
        await send(text, to: session, clientId: clientId, mode: mode)
    }
}
