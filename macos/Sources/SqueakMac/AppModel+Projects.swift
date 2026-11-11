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
    var sidebarTree: SidebarTree { SidebarTreeBuilder.build(sessions + startedChats.unlisted(listed: sessions, now: Date()), now: Date(), keeping: selected, isUnread: { isUnread($0) }) }
}
