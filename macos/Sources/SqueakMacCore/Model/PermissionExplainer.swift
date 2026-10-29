import Foundation

/// A macOS permission Squeak (or its helper) can ask for, and how to explain it.
public enum PermissionKind: String, CaseIterable, Sendable, Identifiable {
    case notifications, inputMonitoring, accessibility, automation, location
    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .notifications: "Notifications"
        case .inputMonitoring: "Input Monitoring"
        case .accessibility: "Accessibility"
        case .automation: "Automation"
        case .location: "Location Services"
        }
    }

    /// One line on what it is for.
    public var purpose: String {
        switch self {
        case .notifications: "A banner when an agent needs you or finishes."
        case .inputMonitoring: "Lets Squeak notice a double-tap of Control to open the quick message."
        case .accessibility: "Lets Squeak Hands type your reply into Conductor's window."
        case .automation: "Lets Squeak Hands type your reply into a Terminal tab."
        case .location: "macOS asks for it before an app can find your iPhone's hotspot by name."
        }
    }

    /// One line on what Squeak never does with it.
    public var never: String {
        switch self {
        case .notifications: "Banners are made on this Mac. Nothing is sent anywhere."
        case .inputMonitoring: "Squeak never reads what you type, only whether Control was tapped."
        case .accessibility: "Squeak Hands never reads your screen or types anything you did not send."
        case .automation: "Squeak Hands never runs a command you did not send."
        case .location: "Squeak never records or sends where you are."
        }
    }

    /// The app to find in System Settings' list.
    public var appInList: String {
        switch self {
        case .accessibility, .automation, .location: "Squeak Hands"
        case .notifications, .inputMonitoring: "Squeak"
        }
    }

    /// The one button's label before and after it has been pressed.
    public var buttonTitle: String {
        switch self {
        case .notifications: "Allow notifications"
        case .inputMonitoring: "Allow Input Monitoring"
        case .accessibility: "Open Accessibility settings"
        case .automation: "Open Automation settings"
        case .location: "Open Location settings"
        }
    }

    /// True when pressing the button makes macOS show its own prompt; false when only the pane can be opened.
    public var hasSystemPrompt: Bool { self == .notifications || self == .inputMonitoring }

    public var paneURL: String {
        switch self {
        case .notifications: "x-apple.systempreferences:com.apple.Notifications-Settings.extension"
        case .inputMonitoring: "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"
        case .accessibility: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
        case .automation: "x-apple.systempreferences:com.apple.preference.security?Privacy_Automation"
        case .location: "x-apple.systempreferences:com.apple.preference.security?Privacy_LocationServices"
        }
    }

    /// What stops working when it is not allowed: a calm line, never a warning.
    public var withoutIt: String {
        switch self {
        case .notifications: "No banners for now. You can still see everything in the menu bar, and turn this on later."
        case .inputMonitoring: "The double-tap won't work. Control-Shift-Space still opens the quick message."
        case .accessibility: "Replies can't be typed into Conductor's window. Squeak uses Conductor's link instead."
        case .automation: "Replies can't be typed into Terminal tabs. Answer those in Terminal."
        case .location: "Squeak can't join your iPhone's hotspot by name if the Wi-Fi drops."
        }
    }
}

/// What a probe could learn about a grant.
public enum PermissionGrant: Sendable, Equatable {
    case granted
    case notGranted
    /// The person said no in a prompt macOS only shows once (notifications).
    case denied
    /// Held by another process (Squeak Hands), which Squeak cannot read.
    case unreadable
}

/// The explainer's pure state: what to show for a permission given what was pressed and what was read.
public struct PermissionFlow: Sendable, Equatable {
    public let kind: PermissionKind
    /// The button was pressed this run.
    public var requested: Bool
    public var grant: PermissionGrant
    /// The person confirmed a grant Squeak cannot read.
    public var confirmed: Bool
    /// Squeak Hands answered, but it is a build from before it reported its own grants.
    public var handsOutdated: Bool

    public init(kind: PermissionKind, requested: Bool = false, grant: PermissionGrant = .notGranted, confirmed: Bool = false,
                handsOutdated: Bool = false) {
        self.kind = kind; self.requested = requested; self.grant = grant; self.confirmed = confirmed
        self.handsOutdated = handsOutdated
    }

    public var isGranted: Bool { grant == .granted || (grant == .unreadable && confirmed) }

    /// The one button. After a notification denial the system prompt cannot return, so it opens the pane.
    public var buttonTitle: String {
        if grant == .denied, kind == .notifications { return "Open Notification settings" }
        if requested, kind.hasSystemPrompt, kind != .notifications { return "Open Input Monitoring settings" }
        return kind.buttonTitle
    }

    /// Whether pressing the button opens the pane (rather than showing a system prompt).
    public var opensPane: Bool {
        if grant == .denied { return true }
        return !kind.hasSystemPrompt || (requested && kind != .notifications)
    }

    /// Hands' grant is read from the daemon; only when that cannot be (an old Hands or daemon) does the
    /// person say when it is on, once the pane was opened.
    public var offersConfirm: Bool { grant == .unreadable && requested && !confirmed }

    /// Shown while Hands cannot report: the fix is a newer helper, not another click.
    public var outdatedLine: String? {
        handsOutdated && !isGranted ? "Update Squeak Hands: this copy is older than Squeak, so it can't say what it holds. Reopening Squeak installs the new one." : nil
    }

    /// Input Monitoring only takes effect in a new process.
    public var offersRelaunch: Bool { kind == .inputMonitoring && requested && !isGranted }

    /// The calm line on what stops working, shown once it was asked for and is not on.
    public var denialLine: String? {
        guard !isGranted else { return nil }
        if grant == .denied { return kind.withoutIt }
        return nil
    }

    /// Where to look in System Settings.
    public var findLine: String { "In the list, turn on \(kind.appInList)." }

    public func pressed() -> PermissionFlow { var f = self; f.requested = true; return f }
    public func confirmedByPerson() -> PermissionFlow { var f = self; f.confirmed = true; return f }
    public func reading(_ g: PermissionGrant) -> PermissionFlow { var f = self; f.grant = g; return f }

    /// A reading of what Squeak Hands holds. A grant it reports replaces the manual confirmation; an old Hands
    /// (or none) leaves the grant unreadable and says so.
    public func readingHands(_ hands: HandsGrants?) -> PermissionFlow {
        var f = self
        if let hands {
            f.handsOutdated = hands.outdated
            f.grant = hands.grant(for: kind) ?? .unreadable
        } else {
            f.handsOutdated = false
            f.grant = .unreadable
        }
        return f
    }
}
