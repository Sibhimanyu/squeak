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

    /// What opening a target does.
    public struct Plan: Sendable, Equatable {
        /// The duck's host session id, or nil when no chat is known for it (the view says "Couldn't open <name>").
        public var sessionId: String?
        /// The duck is off duty: put it back on duty as it opens.
        public var putOnDuty: Bool
    }

    /// `onDuty` is the room's own word for the duck (nil when the room does not list it: nothing to put back).
    public static func plan(_ target: PondOpenTarget, known: some Collection<String>, onDuty: (String) -> Bool?) -> Plan {
        guard let id = sessionId(for: target.duck, among: known) else { return Plan(sessionId: nil, putOnDuty: false) }
        return Plan(sessionId: id, putOnDuty: onDuty(id) == false)
    }

    /// The line shown when nothing could be opened.
    public static func failureNote(name: String?) -> String {
        let n = (name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return n.isEmpty ? "Couldn\u{2019}t open that duck" : "Couldn\u{2019}t open \(n)"
    }
}
