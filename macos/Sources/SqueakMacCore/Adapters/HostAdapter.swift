import Foundation

public protocol HostAdapter: Sendable {
    var id: String { get }
    func discover() async throws -> [HostSession]
    func transcript(for session: HostSession, limit: Int) async throws -> [ChatMessage]
    func activity(for session: HostSession) async throws -> [ActivityStep]
    func send(_ text: String, to session: HostSession, clientId: UUID) async -> SendResult
    func openInHostURL(for session: HostSession) -> URL?
    func health() async -> AdapterHealth
}
