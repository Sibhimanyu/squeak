import Foundation

/// Injectable time so polling is deterministic in tests.
public protocol BrokerClock: Sendable {
    func now() -> Date
    func sleep(for duration: Duration) async throws
}

public struct SystemBrokerClock: BrokerClock {
    public init() {}
    public func now() -> Date { Date() }
    public func sleep(for duration: Duration) async throws { try await Task.sleep(for: duration) }
}
