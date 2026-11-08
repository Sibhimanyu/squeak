import Foundation

/// At most `limit` operations at once; the rest wait their turn in order.
public actor ConcurrencyLimiter {
    private let limit: Int
    private var running = 0
    private var waiting: [CheckedContinuation<Void, Never>] = []

    public init(limit: Int) { self.limit = max(1, limit) }

    public func run<T: Sendable>(_ work: @Sendable () async -> T) async -> T {
        if running >= limit {
            await withCheckedContinuation { waiting.append($0) }
        } else {
            running += 1
        }
        let value = await work()
        release()
        return value
    }

    private func release() {
        if waiting.isEmpty { running -= 1 } else { waiting.removeFirst().resume() }
    }
}

/// Callers asking for the same key while one load is under way share it.
public actor InFlight<Value: Sendable> {
    private var tasks: [String: Task<Value, Never>] = [:]

    public init() {}

    public func value(for key: String, _ work: @escaping @Sendable () async -> Value) async -> Value {
        if let task = tasks[key] { return await task.value }
        let task = Task { await work() }
        tasks[key] = task
        let value = await task.value
        tasks[key] = nil
        return value
    }
}
