import SqueakMacCore
import SwiftUI

// The workbench sidebar's tree. The grouping and ordering are SqueakMacCore's (`SidebarTreeBuilder`);
// `projectFilter` itself is stored on AppModel (an extension cannot hold it) and cleared there
// whenever another sidebar item is chosen.
extension AppModel {
    func openProject(_ name: String) {
        query = ""
        projectFilter = name
    }

    func closeProject() { projectFilter = nil }

    /// Projects, workspaces and chats, newest first, no groups. The open chat stays on the tree even when earlier.
    /// Built once per change of its inputs (sessions, optimistic work, started chats, selection, read log) and per 30 s
    /// of the clock, never per read: the sidebar, tabs, Home and the ponds all read it.
    var sidebarTree: SidebarTree {
        _ = derivedRevision
        let now = Date()
        return derived.tree.value(bucket: TimeBucket.of(now)) {
            SidebarTreeBuilder.build(sessions + startedChats.unlisted(listed: sessions, now: now), now: now, keeping: selected, isUnread: { isUnread($0) })
        }
    }
}

extension AppModel {
    /// Whether the sidebar lists any pond: a project Squeak runs chats in, or a Conductor one the add-on shows.
    var hasPonds: Bool {
        !native.projects.isEmpty || !SidebarSections.split(sidebarTree, nativeNames: native.projects.map(\.name)).projects.isEmpty
    }
}
