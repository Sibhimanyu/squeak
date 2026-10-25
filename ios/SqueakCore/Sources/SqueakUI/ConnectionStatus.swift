import Foundation
import SqueakCore

/// What the iPhone can honestly say about its link to the Mac. Pure (no UIKit, no Color) so `swift test`
/// covers it on the Mac too; `Connection.read` in HomeView only maps the tone to a colour.
/// The one rule: "Connected" is said only while the Mac answers the phone's pings.
struct ConnectionStatus: Equatable {
    enum Tone: Equatable { case connected, notConnected, unverified, neutral }

    let text: String
    let tone: Tone
    /// Fine (connected, or the demo): no bar is shown.
    var healthy = false

    /// "Connected · same Wi-Fi" / "Connected · via cloud" while the Mac answers, else "Not connected · last heard …".
    static func routeText(_ route: ChannelRoute, mac: MacLiveness, now: Date = Date()) -> String {
        switch mac {
        case .answering, .checking: return route == .local ? "Connected · same Wi-Fi" : "Connected · via cloud"
        case .unknown: return "Unverified · this Mac does not confirm it is online"
        case .silent(let since): return "Not connected · last heard \(Age.sync(since, now: now))"
        }
    }

    static func read(snapshot: PhoneSnapshot?, problem: String?, demo: Bool, lastFetch: Date? = nil,
                     mac: MacLiveness = .unknown, route: ChannelRoute = .cloud, phoneOffline: Bool = false,
                     macAliveAt: Date? = nil, streamDownSince: Date? = nil, now: Date = Date()) -> ConnectionStatus {
        if demo { return ConnectionStatus(text: "Mac connected", tone: .connected, healthy: true) }
        // This iPhone's own network outranks everything: nothing below can be trusted without it.
        if phoneOffline {
            let heard = macAliveAt ?? lastFetch
            let tail = heard.map { " · last heard from your Mac \(Age.sync($0, now: now))" } ?? ""
            return ConnectionStatus(text: "No internet on this iPhone" + tail, tone: .notConnected)
        }
        guard let snapshot else {
            return problem == nil
                ? ConnectionStatus(text: "Connecting to your Mac…", tone: .neutral)
                : ConnectionStatus(text: "Can't reach Squeak's server", tone: .notConnected)
        }
        if problem != nil { return ConnectionStatus(text: "Can't reach Squeak's server. Showing the last view.", tone: .notConnected) }
        // A blip is reconnected within a second or two; longer, the view on screen may be out of date, so say so.
        if let down = streamDownSince, now.timeIntervalSince(down) > 5 {
            return ConnectionStatus(text: "Reconnecting… showing the view from \(Age.sync(lastFetch ?? down, now: now))", tone: .notConnected)
        }
        switch mac {
        case .silent(let since):
            // During an awake session it is meant to be awake, so it is most likely offline: say how to fix that.
            if let advice = MacStrip.offlineAdvice(awake: snapshot.keepAwake == true, hotspot: snapshot.hotspot) {
                return ConnectionStatus(text: "Mac offline · \(advice.short) · last heard \(Age.sync(since, now: now))", tone: .notConnected)
            }
            return ConnectionStatus(text: "Mac not answering, maybe asleep · last heard \(Age.sync(since, now: now))", tone: .notConnected)
        case .unknown:
            // An older Mac never answers pings, so nothing proves it is there.
            let synced = lastFetch.map { " · synced \(Age.sync($0, now: now))" } ?? ""
            return ConnectionStatus(text: "Unverified · this Mac does not confirm it is online" + synced, tone: .unverified)
        case .answering, .checking:
            // The Mac only writes a new view when something changed, so the view's age is "last change", not staleness.
            let minutes = Age.minutes(snapshot.generatedAt, now: now) ?? 0
            let change = minutes >= 2 ? " · last change \(Age.describe(snapshot.generatedAt, now: now)) ago" : ""
            return ConnectionStatus(text: routeText(route, mac: mac, now: now) + change, tone: .connected, healthy: true)
        }
    }
}
