import Foundation

public enum SessionSectionKind: String, CaseIterable, Sendable {
    case needsYou, working, recent, earlier

    public var title: String {
        switch self {
        case .needsYou: "Needs you"
        case .working: "Working"
        case .recent: "Recent"
        case .earlier: "Earlier"
        }
    }
}

public struct SessionSection: Equatable, Sendable, Identifiable {
    public var kind: SessionSectionKind
    /// Pinned first, then the existing SessionOrdering order (newest first).
    public var sessions: [HostSession]
    public var id: String { kind.rawValue }
}

/// The brief's sections: Needs you, Working, Recent (finished or idle within 24h), Earlier.
/// Empty sections are omitted. Dead (`alive == false`) working/blocked sessions fall to Recent/Earlier.
public enum SessionGrouping {
    public static let recentWindow: TimeInterval = 24 * 3600

    public static func kind(of s: HostSession, now: Date) -> SessionSectionKind {
        switch s.state {
        case .blocked where s.alive != false: return .needsYou
        case .working where s.alive != false: return .working
        default:
            if let t = s.lastActivityAt, now.timeIntervalSince(t) <= recentWindow { return .recent }
            return .earlier
        }
    }

    public static func group(_ sessions: [HostSession], pinned: Set<SessionKey> = [], now: Date = Date()) -> [SessionSection] {
        var buckets: [SessionSectionKind: [HostSession]] = [:]
        for s in sessions { buckets[kind(of: s, now: now), default: []].append(s) }
        return SessionSectionKind.allCases.compactMap { k in
            guard let list = buckets[k], !list.isEmpty else { return nil }
            let sorted = list.sorted(by: SessionOrdering.before)
            let ordered = sorted.filter { pinned.contains($0.key) } + sorted.filter { !pinned.contains($0.key) }
            return SessionSection(kind: k, sessions: ordered)
        }
    }
}
