import Foundation

/// Renaming a thread where its title is shown (no alert). One thread edits at a time; the reducer holds who, and the
/// one-line reason the last Return was refused. The views draw it, the model does the host call.
public struct InlineRename<Key: Hashable & Sendable>: Equatable, Sendable {
    public private(set) var editing: Key?
    public private(set) var problem: String?

    public enum Outcome: Equatable, Sendable {
        /// Refused: keep editing and show the words.
        case invalid(String)
        /// Same name as now: editing ends, nothing is sent.
        case unchanged
        /// Editing ends and this name is saved.
        case save(String)
    }

    public init() {}

    /// Starts editing `key` (replacing any other), only when the thread can be renamed.
    public mutating func start(_ key: Key, canRename: Bool) {
        guard canRename else { return }
        editing = key
        problem = nil
    }

    public mutating func cancel() { editing = nil; problem = nil }

    public func isEditing(_ key: Key) -> Bool { editing == key }

    /// Return was pressed with `typed`, while `current` is the title shown now.
    public mutating func commit(_ typed: String, current: String) -> Outcome {
        guard editing != nil else { return .unchanged }
        switch ThreadTitle.check(typed) {
        case .failure(let p):
            problem = p.words
            return .invalid(p.words)
        case .success(let title):
            editing = nil
            problem = nil
            return title == current ? .unchanged : .save(title)
        }
    }

    /// Typing clears a shown refusal.
    public mutating func edited() { problem = nil }
}
