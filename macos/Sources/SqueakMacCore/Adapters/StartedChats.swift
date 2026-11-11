import Foundation

/// Chats Squeak just started and has not yet seen in the session list. The host lists a chat the moment it exists,
/// but the list reaches the window a poll later (and the first message's turn can hold the start call for seconds),
/// so selecting the new chat must not read as "Squeak no longer lists this chat". Until the list shows it, the
/// row the host answered with stands in, for a short grace; after that only a chat that really vanished is stale.
public struct StartedChats: Sendable {
    public static let grace: TimeInterval = 120

    private var entries: [SessionKey: (session: HostSession, at: Date)] = [:]

    public init() {}

    public mutating func add(_ session: HostSession, at: Date) { entries[session.key] = (session, at) }

    /// The listed row, else a recently started chat's own row, else nil (really gone).
    public func resolve(_ key: SessionKey, listed: [HostSession], now: Date) -> HostSession? {
        if let s = listed.first(where: { $0.key == key }) { return s }
        guard let e = entries[key], now.timeIntervalSince(e.at) < Self.grace else { return nil }
        return e.session
    }

    /// Started chats the list does not show yet: they stand in the sidebar tree (breadcrumb, tab strip) like any chat.
    public func unlisted(listed: [HostSession], now: Date) -> [HostSession] {
        let keys = Set(listed.map(\.key))
        return entries.values.filter { !keys.contains($0.session.key) && now.timeIntervalSince($0.at) < Self.grace }.map(\.session)
    }

    /// Drops chats the list now shows, and those past the grace.
    public mutating func prune(listed: [HostSession], now: Date) {
        let keys = Set(listed.map(\.key))
        entries = entries.filter { !keys.contains($0.key) && now.timeIntervalSince($0.value.at) < Self.grace }
    }

    /// What the detail says for a selected chat that is not listed. Squeak's own chats were never Conductor's.
    public static func staleNote(for key: SessionKey) -> String {
        key.hostSessionId.hasPrefix(NativeAdapter.keyPrefix)
            ? "Squeak no longer lists this chat. It may have been deleted."
            : "Squeak no longer lists this chat. It may have been archived in Conductor."
    }
}
