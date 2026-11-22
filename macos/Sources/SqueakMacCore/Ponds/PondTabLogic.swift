import Foundation

// The Pond tab in ducks mode (DESIGN.md "Pond tab"): who is on duty right now, what is worth reading in Recent, and which
// chat a duck's click opens. Pure; the view only draws.

/// The ducks to show under "On duty now": working or needing the person, each with its branch label.
public enum PondOnDuty {
    public struct Row: Equatable, Sendable, Identifiable {
        public var key: SessionKey
        public var title: String
        /// "main" or the branch; nil on a remote pond (no code there) or when the host did not say.
        public var branch: String?
        public var needsYou: Bool
        public var id: SessionKey { key }
    }

    public static let cap = 6

    /// Needs-you ducks first, then working ones, newest first inside each. Off-duty ducks and idle or finished ones are left out.
    public static func rows(
        _ ducks: [DuckRow], title: (HostSession) -> String, looping: (HostSession) -> Bool = { _ in false },
        offDuty: (HostSession) -> Bool = { _ in false }, showsBranch: Bool = true, cap: Int = PondOnDuty.cap
    ) -> [Row] {
        let picked: [(Row, Date)] = ducks.compactMap { d in
            let s = d.session
            guard !offDuty(s) else { return nil }
            let needs = s.state == .blocked || looping(s)
            guard needs || s.state == .working else { return nil }
            return (Row(key: s.key, title: title(s), branch: showsBranch ? d.label : nil, needsYou: needs), s.lastActivityAt ?? .distantPast)
        }
        return picked.sorted { a, b in
            if a.0.needsYou != b.0.needsYou { return a.0.needsYou }
            return a.1 != b.1 ? a.1 > b.1 : a.0.title.localizedCompare(b.0.title) == .orderedAscending
        }.prefix(max(0, cap)).map(\.0)
    }
}

/// Recent keeps what a person acts on: a duck finished or failed, a question for you, someone joined. The housekeeping
/// ("You withdrew an invite", "made the pond", "archived a private thread") is not shown.
public enum PondRecent {
    static let remoteWords = ["joined", "finished", "needs you", "waiting on you", "asked you", "has a question", "question for you"]

    public static func isActionable(_ r: PondRipple) -> Bool {
        switch r.kind {
        case .finished, .failed, .needsYou: return true
        case .started, .prOpened, .prMerged, .filesChanged: return false
        case .remote:
            let t = r.sentence.lowercased()
            return remoteWords.contains { t.contains($0) }
        }
    }

    public static func actionable(_ list: [PondRipple], cap: Int = PondGlance.recentCap) -> [PondRipple] {
        Array(list.filter(isActionable).prefix(max(0, cap)))
    }
}

/// The chat a click on a duck opens. A duck's tab is its current chat, so a click on one of its older chats lands there
/// (otherwise the strip collapses the clicked chat into the current one and nothing looks selected).
public enum DuckOpen {
    public static func target(_ s: HostSession, ducksMode: Bool, pool: [HostSession]) -> HostSession {
        guard ducksMode, s.source == .squeak, s.duckId != nil else { return s }
        return DuckList.current(s, in: pool)
    }
}
