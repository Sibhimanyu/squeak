import Foundation

/// How the sidebar orders ponds: by recent activity (the caller's order) or by the person's own saved order.
public enum PondOrderMode: String, Sendable, Equatable, Codable { case recent, manual }

/// The saved pond order (`GET/PUT /native/pond-order`). Keys are native project ids or Conductor repo names.
public struct PondOrderState: Sendable, Equatable, Codable {
    public var mode: PondOrderMode
    public var order: [String]
    public init(mode: PondOrderMode = .recent, order: [String] = []) { self.mode = mode; self.order = order }
}

/// Pure ordering for the Ponds list, so CI pins it.
public enum PondOrder {
    /// `keys` arrive newest first. Recent keeps them; manual lists the saved order first (keys no longer present are
    /// skipped, a key is never listed twice) and puts ponds not in it at the top, newest first among themselves.
    public static func apply(keys: [String], state: PondOrderState) -> [String] {
        guard state.mode == .manual else { return keys }
        let present = Set(keys)
        var seen = Set<String>()
        let saved = state.order.filter { present.contains($0) && seen.insert($0).inserted }
        let fresh = keys.filter { !seen.contains($0) }
        return fresh + saved
    }

    /// The order to save after dragging `moving` so it sits before `before` (nil = after the last shown pond).
    /// `all` is the whole current display order (hidden ponds included); `shown` is what the list draws, in order.
    /// Ponds that are not shown keep their place relative to their neighbours.
    public static func moved(all: [String], shown: [String], moving: String, before: String?) -> [String] {
        guard all.contains(moving), moving != before else { return all }
        var rest = all.filter { $0 != moving }
        if let before, let i = rest.firstIndex(of: before) {
            rest.insert(moving, at: i)
        } else if let last = shown.last(where: { $0 != moving }), let i = rest.firstIndex(of: last) {
            rest.insert(moving, at: i + 1)
        } else {
            rest.append(moving)
        }
        return rest
    }
}
