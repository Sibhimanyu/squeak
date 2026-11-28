import Foundation

/// Turns what was clicked in a pond into the chat to open. A click names a duck by its host session id, but some rows
/// carry a turn id (`<sessionId>:<turnId>`), and a host id can itself contain ':', so an exact match wins and only then
/// are trailing `:part`s peeled off, longest known id first.
public enum PondOpenResolver {
    /// The known id the clicked id names, or nil.
    public static func sessionId(for clicked: String, among known: some Collection<String>) -> String? {
        let set = known as? Set<String> ?? Set(known)
        var candidate = clicked
        while !candidate.isEmpty {
            if set.contains(candidate) { return candidate }
            guard let colon = candidate.lastIndex(of: ":") else { return nil }
            candidate = String(candidate[..<colon])
        }
        return nil
    }

    /// The id the host and the pond speak for a chat. A Squeak chat's app key carries `squeak-native:` before the host's own id
    /// (`PondThread.sessionId`, the duck roster's `currentSessionId`); comparing the two raw never matched, so a duck the pond
    /// listed opened the pond's thread page instead of its chat tab.
    public static func hostId(of key: SessionKey) -> String {
        let id = key.hostSessionId
        return id.hasPrefix(NativeAdapter.keyPrefix) ? String(id.dropFirst(NativeAdapter.keyPrefix.count)) : id
    }

    /// What opening a target does.
    public struct Plan: Sendable, Equatable {
        /// The duck's host session id, or nil when no chat is known for it (the view says "Couldn't open <name>").
        public var sessionId: String?
        /// The duck is closed: reopen it as it opens.
        public var reopen: Bool
    }

    /// `open` is the room's own word for the duck (nil when the room does not list it: nothing to put back).
    public static func plan(_ target: PondOpenTarget, known: some Collection<String>, open: (String) -> Bool?) -> Plan {
        guard let id = sessionId(for: target.duck, among: known) else { return Plan(sessionId: nil, reopen: false) }
        return Plan(sessionId: id, reopen: open(id) == false)
    }

    /// The line shown when nothing could be opened.
    public static func failureNote(name: String?) -> String {
        let n = (name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return n.isEmpty ? "Couldn\u{2019}t open that duck" : "Couldn\u{2019}t open \(n)"
    }
}
