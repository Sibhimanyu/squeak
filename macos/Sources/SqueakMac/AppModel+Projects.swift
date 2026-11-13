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
            SidebarTreeBuilder.build(sessions + startedChats.unlisted(listed: sessions, now: now), now: now, keeping: selected, mains: mainPlaces, isUnread: { isUnread($0) })
        }
    }

    /// Every git pond's Main place (its own folder and the branch it is on); a plain-folder pond has none.
    var mainPlaces: [MainPlace] { native.projects.compactMap { MainPlace(project: $0) } }

    /// The Main place of a pond, by its directory key.
    func mainPlace(key: String) -> MainPlace? {
        guard let projectId = PondsModel.shared.entry(key)?.projectId else { return nil }
        return mainPlaces.first { $0.projectId == projectId }
    }

    /// Every non-archived chat, earlier ones too: the pond page's threads and counts (the sidebar keeps the active set).
    var pondPageTree: SidebarTree {
        _ = derivedRevision
        let now = Date()
        return derived.fullTree.value(bucket: TimeBucket.of(now)) {
            SidebarTreeBuilder.build(sessions + startedChats.unlisted(listed: sessions, now: now), now: now, keeping: selected, mains: mainPlaces, includeEarlier: true, isUnread: { isUnread($0) })
        }
    }

    /// The fleet's chats laid out under the directory's ponds (`SidebarSections`); Other holds what no pond has.
    var pondSections: SidebarSections {
        SidebarSections.split(sidebarTree, directory: PondsModel.shared.directory ?? PondDirectory(), mains: mainPlaces)
    }

    /// A pond's streams and chats as the tree draws them, by directory key.
    func pondProject(_ key: String) -> SidebarProject {
        let sections = SidebarSections.split(pondPageTree, directory: PondsModel.shared.directory ?? PondDirectory(), mains: mainPlaces)
        return SidebarProject(name: PondsModel.shared.name(key: key), workspaces: sections.workspaces(of: key))
    }

    /// A pond's archived chats, newest archived first.
    func archivedThreads(in key: String) -> [HostSession] {
        ThreadArchive.archived(allSessions).filter { PondsModel.shared.key(of: $0) == key }
    }

    /// The chat holding this pond's Main right now (working or waiting), or nil.
    func busyMainChat(_ main: MainPlace) -> HostSession? { main.busyChat(in: sessions.map { withHostBackground($0) }) }
}

extension AppModel {
    /// Whether the sidebar lists any pond: a project Squeak runs chats in, or a Conductor one the add-on shows.
    var hasPonds: Bool {
        !(PondsModel.shared.directory?.ponds.isEmpty ?? true)
    }
}
