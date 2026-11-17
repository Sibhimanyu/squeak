import Foundation
import os

/// Intervals for the moments the person feels (a tab switch, opening a pond, the Dashboard or Settings, a poll applied, a
/// transcript page applied), so a regression shows in Instruments' Points of Interest and `log stream --signpost`
/// instead of as "it feels jittery". Cheap when nobody is recording. Each interval times the synchronous main-actor work of
/// the action (what blocks the next frame); the redraw it triggers shows under SwiftUI's own signposts in the same trace.
public enum Signposts {
    public static let subsystem = "com.squeak.mac"
    public static let poster = OSSignposter(subsystem: subsystem, category: .pointsOfInterest)

    public enum Name {
        public static let tabSwitch: StaticString = "tab.switch"
        public static let pondOpen: StaticString = "pond.open"
        public static let dashboardOpen: StaticString = "dashboard.open"
        public static let settingsOpen: StaticString = "settings.open"
        public static let pollApply: StaticString = "poll.apply"
        public static let transcriptApply: StaticString = "transcript.apply"
    }

    /// Runs `body` inside an interval called `name`.
    @discardableResult
    public static func interval<T>(_ name: StaticString, _ body: () throws -> T) rethrows -> T {
        let id = poster.makeSignpostID()
        let state = poster.beginInterval(name, id: id)
        defer { poster.endInterval(name, state) }
        return try body()
    }

    /// For async work: begin now, end with `end(_:)`.
    public static func begin(_ name: StaticString) -> OSSignpostIntervalState {
        poster.beginInterval(name, id: poster.makeSignpostID())
    }
    public static func end(_ name: StaticString, _ state: OSSignpostIntervalState) { poster.endInterval(name, state) }
}
