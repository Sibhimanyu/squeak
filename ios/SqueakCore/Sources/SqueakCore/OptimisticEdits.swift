import Foundation

/// Archive and rename shown on the phone the moment they are tapped, then settled by the Mac: a refusal rolls the
/// edit back, and the Mac's own view confirming it (the chat gone, the new title there) retires it. An edit the
/// Mac never confirmed is dropped after `ttl`, so a lost answer cannot hide a chat for good. Pure and in memory:
/// nothing here is sent anywhere, and the Mac still checks every command.
public struct OptimisticEdits: Equatable, Sendable {
    public static let ttl: TimeInterval = 120

    private var archived: [String: Date] = [:]
    private var titles: [String: (title: String, at: Date)] = [:]

    public init() {}

    public static func == (a: Self, b: Self) -> Bool {
        a.archived == b.archived && a.titles.mapValues(\.title) == b.titles.mapValues(\.title)
    }

    public var isEmpty: Bool { archived.isEmpty && titles.isEmpty }

    public mutating func archive(_ key: String, now: Date = Date()) { archived[key] = now }
    public mutating func rename(_ key: String, to title: String, now: Date = Date()) { titles[key] = (title, now) }

    /// The Mac refused (or could not be reached): put it back as it was.
    public mutating func rollback(_ key: String) { archived[key] = nil; titles[key] = nil }

    /// Retires what `view` already shows, and what is too old to trust.
    public mutating func reconcile(with view: PhoneSnapshot, now: Date = Date()) {
        let all = view.sessions + (view.recent ?? [])
        let present = Set(all.map(\.key))
        archived = archived.filter { key, at in present.contains(key) && now.timeIntervalSince(at) < Self.ttl }
        titles = titles.filter { key, held in
            guard now.timeIntervalSince(held.at) < Self.ttl, let session = all.first(where: { $0.key == key }) else { return false }
            return session.title != held.title
        }
    }

    /// `view` as the phone draws it with the edits in place. Order and ids are untouched (a rename keeps the row).
    /// An edit older than `ttl` is not applied even before the next `reconcile`, so a quiet Mac cannot keep a chat hidden.
    public func apply(to view: PhoneSnapshot, now: Date = Date()) -> PhoneSnapshot {
        guard !isEmpty else { return view }
        let live = archived.filter { now.timeIntervalSince($0.value) < Self.ttl }
        let liveTitles = titles.filter { now.timeIntervalSince($0.value.at) < Self.ttl }
        var out = view
        out.sessions = Self.edit(view.sessions, archived: live, titles: liveTitles)
        if let recent = view.recent { out.recent = Self.edit(recent, archived: live, titles: liveTitles) }
        return out
    }

    private static func edit(_ list: [PhoneSnapshot.Session], archived: [String: Date], titles: [String: (title: String, at: Date)]) -> [PhoneSnapshot.Session] {
        list.compactMap { session in
            if archived[session.key] != nil { return nil }
            guard let held = titles[session.key] else { return session }
            var renamed = session
            renamed.title = held.title
            return renamed
        }
    }
}
