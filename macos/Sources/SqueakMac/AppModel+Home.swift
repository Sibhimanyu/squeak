import SqueakMacCore
import SwiftUI

// The connection line the sidebar footer shows, in the daemon's own words; nothing here decides.
extension AppModel {
    var homeLoaded: Bool { hasLoaded || health != nil }

    /// Honest: "Connected" only when it is; the daemon's own words otherwise.
    var homeConnectionText: String {
        guard homeLoaded else { return "Connecting…" }
        return isConnected ? "Connected" : connectionTitle
    }

    var homeConnectionColor: Color {
        guard homeLoaded else { return Theme.idle }
        return isConnected ? Theme.working : Theme.offline
    }
}
