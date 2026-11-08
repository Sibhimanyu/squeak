import Foundation

/// Which of a chat's states are live and which have gone quiet. Not sections: the Mac lists chats newest first
/// and shows a mark (`ChatMark`), so this is only the classifier the marks and the "earlier" cut-off share.
public enum SessionSectionKind: String, CaseIterable, Sendable {
    case needsYou, done, working, error, idle
}

/// - Blocked and working sessions count only while alive; a dead one is idle.
/// - Finished and errored sessions stay recent for `recentWindow` (24h) after their last activity, then fall to
///   idle, so the list is not an archive.
/// - Everything else (idle, unknown, dead) is idle; `isEarlier` marks the ones a list may tuck away.
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
}
