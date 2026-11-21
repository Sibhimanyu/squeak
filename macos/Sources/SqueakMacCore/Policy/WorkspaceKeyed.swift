import Foundation

/// A selection (or any small state) kept once per workspace, with the current workspace named. Reading uses the
/// current workspace; switching away and back finds what was there. A workspace with nothing stored reads as
/// `Value()`-like empty via `fallback`. Pure: the dock store owns one per kind of selection.
public struct WorkspaceKeyed<Value: Equatable & Sendable>: Equatable, Sendable {
    public private(set) var values: [String: Value] = [:]
    public private(set) var active: String?
    private let fallback: Value
    /// Slot for writes made before any workspace is known, so they are not lost.
    private static var noWorkspace: String { "\u{0}none" }

    public init(fallback: Value) { self.fallback = fallback }

    /// The current workspace's value (the fallback with no workspace or nothing stored).
    public var current: Value {
        get { values[active ?? Self.noWorkspace] ?? fallback }
        set {
            let k = active ?? Self.noWorkspace
            if newValue == fallback { values[k] = nil } else { values[k] = newValue }
        }
    }

    /// What a workspace has stored, nil when nothing.
    public func stored(_ workspace: String) -> Value? { values[workspace] }

    /// Makes `workspace` current. Returns whether it changed.
    @discardableResult
    public mutating func switchTo(_ workspace: String?) -> Bool {
        guard workspace != active else { return false }
        active = workspace
        return true
    }

    /// Forgets every workspace not in `existing` (the current one stays current, but its value goes too).
    public mutating func prune(keeping existing: Set<String>) {
        values = values.filter { existing.contains($0.key) || $0.key == Self.noWorkspace }
    }

    /// Rewrites every stored value (for dropping sessions that vanished); values that become the fallback go.
    public mutating func transformAll(_ change: (Value) -> Value) {
        for (k, v) in values { let n = change(v); values[k] = n == fallback ? nil : n }
    }
}
