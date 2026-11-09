import Foundation
import SqueakCore

/// The project overview is a live inbox; the chats inside a project can still hold their order.
enum ProjectInbox {
    static func isUnread(_ session: PhoneSnapshot.Session, seen: [String: Double]) -> Bool {
        guard session.state == "finished", let activity = Age.date(session.lastActivityAt) else { return false }
        guard let opened = seen[session.key] else { return true }
        return activity.timeIntervalSince1970 > opened + 1
    }

    static func ordered(_ projects: [Presentation.Project], seen: [String: Double], starting: Set<String> = []) -> [Presentation.Project] {
        let entries = projects.map { project in
            (project: project,
             pending: project.sessions.contains { $0.state == "working" || starting.contains($0.key) || isUnread($0, seen: seen) },
             activity: project.sessions.compactMap { Age.date($0.lastActivityAt) }.max() ?? .distantPast)
        }
        return entries.sorted {
            if $0.pending != $1.pending { return $0.pending }
            if $0.activity != $1.activity { return $0.activity > $1.activity }
            return $0.project.name < $1.project.name
        }.map(\.project)
    }
}
