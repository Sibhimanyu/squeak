import Foundation

public protocol HostAdapter: Sendable {
    var id: String { get }
    func discover() async throws -> [HostSession]
    func transcript(for session: HostSession, limit: Int) async throws -> [ChatMessage]
    func activity(for session: HostSession) async throws -> [ActivityStep]
    func send(_ text: String, to session: HostSession, clientId: UUID) async -> SendResult
    /// Same, saying how to meet an agent that is mid-turn. An adapter that cannot steer ignores `mode`
    /// and queues, and says so in the result's `note` when steering was asked for.
    func send(_ text: String, to session: HostSession, clientId: UUID, mode: SendMode) async -> SendResult
    func openInHostURL(for session: HostSession) -> URL?
    func health() async -> AdapterHealth
}

public extension HostAdapter {
    func send(_ text: String, to session: HostSession, clientId: UUID, mode: SendMode) async -> SendResult {
        await send(text, to: session, clientId: clientId)
    }
}
