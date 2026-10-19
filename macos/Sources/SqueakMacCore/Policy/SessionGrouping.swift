import Foundation

/// DESIGN.md 8.2: rows are grouped and ordered by attention: needs you, then done, then working,
/// then error, then idle.
public enum SessionSectionKind: String, CaseIterable, Sendable {
    case needsYou, done, working, error, idle

    public var title: String {
        switch self {
        case .needsYou: "Needs you"
        case .done: "Done"
        case .working: "Working"
        case .error: "Error"
        case .idle: "Idle"
        }
    }
}

public struct SessionSection: Equatable, Sendable, Identifiable {
    public var kind: SessionSectionKind
    /// Pinned first, then the existing SessionOrdering order (newest first).
    public var sessions: [HostSession]
    public var id: String { kind.rawValue }
}

/// Sections in attention order; empty ones are omitted.
/// - Blocked and working sessions count only while alive; a dead one is idle.
/// - Finished and errored sessions stay in Done / Error for `recentWindow` (24h) after their last
///   activity, then fall to Idle, so the list is not an archive.
/// - Everything else (idle, unknown, dead) is Idle; `isEarlier` marks the ones a list may tuck away.
public enum SessionGrouping {
    public static let recentWindow: TimeInterval = 24 * 3600

    public static func kind(of s: HostSession, now: Date) -> SessionSectionKind {
        switch s.state {
        case .blocked where s.alive != false: return .needsYou
        case .working where s.alive != false: return .working
        case .finished where isRecent(s, now: now): return .done
        case .error where isRecent(s, now: now): return .error
        default: return .idle
        }
    }

    /// An idle session with no activity in the last 24h: lists collapse these behind "Show earlier".
    public static func isEarlier(_ s: HostSession, now: Date) -> Bool {
        kind(of: s, now: now) == .idle && !isRecent(s, now: now)
    }

    static func isRecent(_ s: HostSession, now: Date) -> Bool {
        guard let t = s.lastActivityAt else { return false }
        return now.timeIntervalSince(t) <= recentWindow
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
