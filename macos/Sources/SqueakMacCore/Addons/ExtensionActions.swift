import Foundation

/// Settings › Extensions: which card has an action running and which card's last action failed. Per card, never one
/// flag for the page: pressing Remove on one card must not put a spinner on every other.
public struct ExtensionActionState: Equatable, Sendable {
    public private(set) var pending: Set<String> = []
    public private(set) var errors: [String: String] = [:]

    public init() {}

    public func isPending(_ id: String) -> Bool { pending.contains(id) }
    public func error(_ id: String) -> String? { errors[id] }

    /// Starts an action on a card. False when that card already has one running (a second press does nothing).
    public mutating func begin(_ id: String) -> Bool {
        guard !pending.contains(id) else { return false }
        pending.insert(id)
        errors[id] = nil
        return true
    }

    /// Ends the card's action; `error` is the plain-words reason shown on that card, nil on success.
    public mutating func finish(_ id: String, error: String? = nil) {
        pending.remove(id)
        errors[id] = error
    }

    /// How long a card's action may take before it says so.
    public static let deadline: Double = 15

    public static func timedOutMessage(_ name: String) -> String { "\(name) didn't answer in time. Try again." }
    public static func notDoneMessage(_ name: String, adding: Bool) -> String {
        "\(name) wasn't \(adding ? "added" : "removed"). Try again."
    }

    /// Runs `operation`; false when it did not finish within `seconds` (it is left to finish on its own).
    public static func finishes(within seconds: Double = deadline, _ operation: @escaping @Sendable () async -> Void) async -> Bool {
        let gate = Gate()
        return await withCheckedContinuation { (cont: CheckedContinuation<Bool, Never>) in
            Task { await operation(); if gate.take() { cont.resume(returning: true) } }
            Task { try? await Task.sleep(for: .seconds(seconds)); if gate.take() { cont.resume(returning: false) } }
        }
    }

    private final class Gate: @unchecked Sendable {
        private let lock = NSLock()
        private var taken = false
        func take() -> Bool { lock.lock(); defer { lock.unlock() }; if taken { return false }; taken = true; return true }
    }
}
