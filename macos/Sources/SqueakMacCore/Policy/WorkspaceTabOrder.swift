import Foundation

/// Activity order belongs to the inbox. Workspace tabs keep their positions until explicitly moved.
public struct WorkspaceTabOrder: Codable, Equatable, Sendable {
    private var orders: [String: [String]] = [:]
    public init() {}

    public func ordered(workspace: String, available: [String]) -> [String] {
        let present = Set(available)
        var seen = Set<String>()
        return ((orders[workspace] ?? []) + available).filter { present.contains($0) && seen.insert($0).inserted }
    }

    public mutating func synchronize(workspace: String, available: [String]) {
        // Keep absent IDs in storage: a partial snapshot or reconnect must not erase their positions.
        // `ordered` hides them until they are available again.
        var seen = Set<String>()
        orders[workspace] = ((orders[workspace] ?? []) + available).filter { seen.insert($0).inserted }
    }

    @discardableResult
    public mutating func move(workspace: String, source: String, before target: String, available: [String]) -> Bool {
        let present = Set(available)
        guard source != target, present.contains(source), present.contains(target) else { return false }
        var seen = Set<String>()
        var order = ((orders[workspace] ?? []) + available).filter { seen.insert($0).inserted }
        order.removeAll { $0 == source }
        guard let index = order.firstIndex(of: target) else { return false }
        order.insert(source, at: index)
        orders[workspace] = order
        return true
    }
}
