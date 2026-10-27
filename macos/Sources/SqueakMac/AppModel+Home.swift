import SqueakMacCore
import SwiftUI

// Home and Needs you in the window (the iPhone's flow). Every number and word comes from `/state`
// through SqueakMacCore (HomeProjects.swift); nothing here decides.
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

    var homeProjects: [HomeProject] { HomeProjects.build(sessions) }

    var homeSearch: HomeSearch.Split {
        HomeSearch.split(searchHits, sessions: sessions)
    }

    var macStatusItems: [MacStatusStrip.Item] {
        MacStatusStrip.items(awake: awake, power: power, connected: isConnected || !homeLoaded)
    }

    /// Blocked chats, newest first (the Needs you page).
    var needsYouSessions: [HostSession] {
        let now = Date()
        return sessions.filter { SessionGrouping.kind(of: $0, now: now) == .needsYou }.sorted(by: HomeProjects.before)
    }
}
