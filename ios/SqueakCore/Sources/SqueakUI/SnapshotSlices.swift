import Foundation
import Observation
import SqueakCore

/// The view's parts, so a screen redraws only for what it shows. `AppModel.snapshot` stays the whole view for the
/// screens that read it whole; Home reads `HomeSlice`, a chat reads its own `SessionBox`, and the parts that tick
/// alone (macControls, workSteps) have their own properties.

/// What Home draws from the Mac's view.
struct HomeSlice: Equatable, Sendable {
    /// There is a view at all.
    var present = false
    /// Active chats, in the Mac's order.
    var sessions: [PhoneSnapshot.Session] = []
    /// Chats no longer active and not among the active ones, newest first.
    var recent: [PhoneSnapshot.Session] = []
    var recentMore = false
    var films: [PhoneFilm] = []
    /// The Mac's ponds (empty from an older Mac or while its host is down).
    var ponds: [PhoneSnapshot.Pond] = []
    /// The Mac can start chats when it sent workspaces.
    var workspaces: [PhoneSnapshot.Workspace]?

    static let empty = HomeSlice()

    init() {}

    init(_ view: PhoneSnapshot) {
        present = true
        sessions = view.sessions
        let active = Set(view.sessions.map(\.key))
        recent = Presentation.newestFirst((view.recent ?? []).filter { !active.contains($0.key) })
        recentMore = view.recentMore == true
        films = view.films ?? []
        ponds = view.ponds ?? []
        workspaces = view.workspaces
    }
}

/// Every part of a view that has its own observers, computed off the main actor.
struct SnapshotSlices: Equatable, Sendable {
    var home: HomeSlice
    /// Active and recent chats by key (an active one wins, as `PhoneSnapshot.session` does).
    var sessions: [String: PhoneSnapshot.Session]
    var macControls: PhoneSnapshot.MacControls?
    var workSteps: Bool?

    static let empty = SnapshotSlices(home: .empty, sessions: [:], macControls: nil, workSteps: nil)

    init(home: HomeSlice, sessions: [String: PhoneSnapshot.Session], macControls: PhoneSnapshot.MacControls?, workSteps: Bool?) {
        self.home = home; self.sessions = sessions; self.macControls = macControls; self.workSteps = workSteps
    }

    init(_ view: PhoneSnapshot?) {
        guard let view else { self = .empty; return }
        var byKey: [String: PhoneSnapshot.Session] = [:]
        for session in view.recent ?? [] { byKey[session.key] = session }
        for session in view.sessions { byKey[session.key] = session }
        self.init(home: HomeSlice(view), sessions: byKey, macControls: view.macControls, workSteps: view.workSteps)
    }
}

/// What a new view changes against the one on screen: only these are published.
struct SnapshotPlan: Sendable {
    /// Nil when the view went away.
    var view: PhoneSnapshot?
    var slices: SnapshotSlices
    /// The whole view differs (what `snapshot` readers see).
    var wholeChanged: Bool
    var homeChanged: Bool
    var changedSessions: [String: PhoneSnapshot.Session]
    var removedSessions: [String]
    var controlsChanged: Bool
    var workStepsChanged: Bool

    var changedAnything: Bool { wholeChanged || homeChanged || !changedSessions.isEmpty || !removedSessions.isEmpty || controlsChanged || workStepsChanged }

    /// Pure and `nonisolated`: it runs in a detached task, never on the main actor.
    static func make(view: PhoneSnapshot?, previousView: PhoneSnapshot?, previous: SnapshotSlices?) -> SnapshotPlan {
        let slices = SnapshotSlices(view)
        let old = previous ?? .empty
        var changed: [String: PhoneSnapshot.Session] = [:]
        for (key, session) in slices.sessions where old.sessions[key] != session { changed[key] = session }
        let removed = old.sessions.keys.filter { slices.sessions[$0] == nil }
        return SnapshotPlan(
            view: view, slices: slices, wholeChanged: view != previousView,
            homeChanged: slices.home != old.home, changedSessions: changed, removedSessions: removed,
            controlsChanged: slices.macControls != old.macControls, workStepsChanged: slices.workSteps != old.workSteps)
    }
}

/// One chat's current view. A screen that reads `session` is invalidated only when this chat changes.
@MainActor @Observable
final class SessionBox {
    private(set) var session: PhoneSnapshot.Session?
    init(_ session: PhoneSnapshot.Session?) { self.session = session }
    func set(_ next: PhoneSnapshot.Session?) { if session != next { session = next } }
}

/// The chats by key. Reading a key tracks that chat's box, and only the arrival of a chat nobody had yet.
@MainActor @Observable
final class SessionStore {
    @ObservationIgnored private var boxes: [String: SessionBox] = [:]
    /// Bumped when a key gets its first box, for readers of a key that had none.
    private(set) var membership = 0

    func session(_ key: String) -> PhoneSnapshot.Session? {
        if let box = boxes[key] { return box.session }
        _ = membership
        return nil
    }

    func apply(changed: [String: PhoneSnapshot.Session], removed: [String]) {
        var added = false
        for (key, session) in changed {
            if let box = boxes[key] { box.set(session) } else { boxes[key] = SessionBox(session); added = true }
        }
        for key in removed { boxes[key]?.set(nil) }
        if added { membership += 1 }
    }

    func reset() {
        for box in boxes.values { box.set(nil) }
    }
}

/// Home's lists, derived once per input change rather than in every body.
struct HomeLists: Equatable {
    /// Active chats not hidden on this phone.
    var visible: [PhoneSnapshot.Session]
    /// Chats with an unread reply, newest first.
    var unread: [PhoneSnapshot.Session]
    /// Every project: active chats and older ones (not hidden here) together, newest activity first.
    var projects: [Presentation.Project]

    /// The agent has answered since you last looked at this chat. See `AppModel.isUnread`.
    static func isUnread(_ session: PhoneSnapshot.Session, seen: [String: Double]) -> Bool {
        guard let seenAt = seen[session.key], !session.needsYou, session.state != "working",
              session.message != nil || session.detail != nil,
              let at = Age.date(session.lastActivityAt) else { return false }
        return at.timeIntervalSince1970 > seenAt + 1
    }

    static func isHidden(_ session: PhoneSnapshot.Session, hidden: [String: Double]) -> Bool {
        guard let at = hidden[session.key] else { return false }
        return (Age.date(session.lastActivityAt)?.timeIntervalSince1970 ?? 0) <= at
    }

    static func make(home: HomeSlice, hidden: [String: Double], seen: [String: Double]) -> HomeLists {
        let visible = home.sessions.filter { !isHidden($0, hidden: hidden) }
        let unread = (visible + home.recent).filter { isUnread($0, seen: seen) }.sorted {
            (Age.date($0.lastActivityAt) ?? .distantPast) > (Age.date($1.lastActivityAt) ?? .distantPast)
        }
        let active = Set(visible.map(\.key))
        var taken = active
        let quiet = (home.recent + unread).filter { !isHidden($0, hidden: hidden) && taken.insert($0.key).inserted }
        return HomeLists(visible: visible, unread: unread, projects: Presentation.projects(visible + quiet, ponds: home.ponds))
    }
}

/// Elements with their position in the whole run as a stable id, for a window that grows at the end.
struct StableIndexed<Element>: Identifiable {
    let id: Int
    let offset: Int
    let element: Element

    static func make(_ items: [Element], first: Int) -> [StableIndexed<Element>] {
        items.enumerated().map { StableIndexed(id: first + $0.offset, offset: $0.offset, element: $0.element) }
    }
}
