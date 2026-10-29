import AppKit
import Foundation
import IOKit.ps
import Observation
import SqueakMacCore

/// Which screen the menu-bar popup shows. The popup is one panel with several screens: four tabs (Home,
/// Needs you, Usage, Controls) and, in place of them, New chat, its workspace list and an opened session
/// (back arrow). Nothing here sends or fetches; it is only where the person is.
@MainActor @Observable
final class PopupNav {
    static let shared = PopupNav()

    enum Tab: String, CaseIterable, Identifiable {
        case home, needsYou, usage, controls
        var id: String { rawValue }
        var title: String {
            switch self {
            case .home: "Home"
            case .needsYou: "Needs you"
            case .usage: "Usage"
            case .controls: "Controls"
            }
        }
    }

    enum Screen: Equatable {
        case tab(Tab)
        case newChat
        case workspaces
        case session(SessionKey)

        var id: String {
            switch self {
            case .tab(let t): "tab-\(t.rawValue)"
            case .newChat: "new-chat"
            case .workspaces: "workspaces"
            case .session(let k): "session-\(k.stringValue)"
            }
        }
    }

    /// The popup's own New chat form state (the desktop page has its own).
    let newChat = NewChatState()
    var screen: Screen = .tab(.home)
    /// The tab to go back to from a sub-screen.
    var lastTab: Tab = .home

    func show(_ tab: Tab) { lastTab = tab; screen = .tab(tab) }

    /// New chat in the panel itself: the same state and Core form as the desktop page.
    func openNewChat(preselect workspaceId: String? = nil) {
        if case .tab(let t) = screen { lastTab = t }
        newChat.prepare(model: AppModel.shared, preselect: workspaceId)
        screen = .newChat
    }

    func openSession(_ key: SessionKey) {
        if case .tab(let t) = screen { lastTab = t }
        screen = .session(key)
    }

    func back() {
        switch screen {
        case .workspaces: screen = .newChat
        default: screen = .tab(lastTab)
        }
    }

    // MARK: Keep awake countdown

    /// The awake session's length, for the countdown bar. The daemon reports only when it ends, so the
    /// length is what the person picked here, else how long it had left when this Mac first saw it.
    private(set) var awakeSpan: (until: Date, total: TimeInterval)?
    private var pendingTotal: TimeInterval?

    func willStartAwake(minutes: Int?) { pendingTotal = minutes.map { TimeInterval($0) * 60 } }

    func observeAwake(until: Date?, now: Date = Date()) {
        guard let until else { awakeSpan = nil; return }
        if let span = awakeSpan, abs(span.until.timeIntervalSince(until)) < 60 { return }
        if let span = awakeSpan, until > span.until, pendingTotal == nil {
            awakeSpan = (until, span.total + until.timeIntervalSince(span.until))
        } else {
            awakeSpan = (until, max(pendingTotal ?? until.timeIntervalSince(now), 60))
        }
        pendingTotal = nil
    }

    /// 0...1 of the session still to run; nil when it has no end or the length is unknown.
    func awakeRemaining(until: Date?, now: Date = Date()) -> Double? {
        guard let until, let span = awakeSpan else { return nil }
        return min(max(until.timeIntervalSince(now) / span.total, 0), 1)
    }

    // MARK: Usage refresh

    /// Refresh is offered once a minute (the daemon throttles to the same), so a double press is not a second call.
    var lastUsageRefresh: Date?

    // MARK: Demo

    /// Capture only: the energy mode the Controls screen shows (the model is read-only from a Mac app's side).
    var demoPower: DaemonPower?
}

/// Facts about this Mac that the popup shows and the daemon does not report.
enum PopupMac {
    static var name: String { Host.current().localizedName ?? "This Mac" }

    struct BatteryStatus {
        let percent: Int
        let isCharging: Bool
    }

    /// The battery's charge and charging state, read from the system's power sources; nil on a desktop Mac.
    static func batteryStatus() -> BatteryStatus? {
        guard let info = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              let list = IOPSCopyPowerSourcesList(info)?.takeRetainedValue() as? [CFTypeRef] else { return nil }
        for source in list {
            guard let d = IOPSGetPowerSourceDescription(info, source)?.takeUnretainedValue() as? [String: Any],
                  (d[kIOPSTypeKey] as? String) == kIOPSInternalBatteryType,
                  let current = d[kIOPSCurrentCapacityKey] as? Int, let max = d[kIOPSMaxCapacityKey] as? Int, max > 0
            else { continue }
            return BatteryStatus(
                percent: Int((Double(current) / Double(max) * 100).rounded()),
                isCharging: d[kIOPSIsChargingKey] as? Bool ?? false
            )
        }
        return nil
    }
}
