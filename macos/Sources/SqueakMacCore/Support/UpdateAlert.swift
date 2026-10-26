import Foundation

/// What Squeak tells the person when Sparkle finds an update: a dot on the menu-bar mark and one
/// notification per version. Pure decisions; `AppModel` and `Notifier` carry them out.
public enum UpdateAlert {
    /// The dot on the menu-bar mark: while an update is found or downloaded and the switch is on.
    /// It clears by itself, since the updater drops both versions when the update is installed or skipped.
    public static func badgeShown(available: String?, ready: String?, switchOn: Bool) -> Bool {
        switchOn && (available != nil || ready != nil)
    }

    /// The version a notification would be about: the downloaded one wins over the merely found one.
    public static func pendingVersion(available: String?, ready: String?) -> String? { ready ?? available }

    /// One notification per version, ever: a version already told (across launches) or skipped stays quiet,
    /// as does everything while the switch or Squeak's notifications are off.
    public static func shouldNotify(
        version: String?, lastNotified: String?, skipped: String?, switchOn: Bool, notificationsOn: Bool
    ) -> Bool {
        guard switchOn, notificationsOn, let version, !version.isEmpty else { return false }
        return version != lastNotified && version != skipped
    }

    /// Marker in `userInfo` so a click is never read as a session's notification (which opens the composer).
    public static let userInfoKind = "kind", userInfoKindValue = "update", userInfoVersion = "version"

    public struct Payload: Equatable, Sendable {
        public var identifier: String
        public var title: String
        public var body: String
        public var threadIdentifier: String
        public var userInfo: [String: String]
    }

    /// "Squeak 2.7.0 is available", with the first line of What's new; a downloaded update says to restart.
    public static func payload(version: String, downloaded: Bool, notes: [String]) -> Payload {
        let first = notes.first?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
        let body = downloaded ? "Restart to update" : (first ?? "Open Settings to install it.")
        return Payload(
            identifier: "update-\(version)", title: "Squeak \(version) is available", body: body,
            threadIdentifier: "update",
            userInfo: [userInfoKind: userInfoKindValue, userInfoVersion: version])
    }

    /// True for a notification response this file's payload made. It has no `session`, so session routing ignores it too.
    public static func isUpdate(_ info: [AnyHashable: Any]) -> Bool {
        info[userInfoKind] as? String == userInfoKindValue
    }
}

private extension String {
    var nonEmpty: String? { isEmpty ? nil : self }
}
