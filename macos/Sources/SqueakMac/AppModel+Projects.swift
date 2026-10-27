import SqueakMacCore
import SwiftUI

// Home's project drill-in. The grouping and ordering are SqueakMacCore's (`HomeProjects.page`);
// `projectFilter` itself is stored on AppModel (an extension cannot hold it) and cleared there
// whenever another sidebar item is chosen.
extension AppModel {
    func openProject(_ name: String) {
        query = ""
        projectFilter = name
    }

    func closeProject() { projectFilter = nil }

    var projectPage: ProjectPage? {
        projectFilter.flatMap { HomeProjects.page(named: $0, in: sessions, pinned: pinned) }
    }
}
