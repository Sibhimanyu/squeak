import Foundation

/// What the app was showing when an update took it down, so the next launch can put it back.
/// Written just before Sparkle terminates the app; read once on the launch after.
/// Drafts are not in here: the app already keeps them per chat in its own cache.
public struct UpdateRestoreMarker: Codable, Equatable, Sendable {
    public enum Window: String, Codable, Sendable { case none, conversation, settings, welcome }

    public var fromVersion: String
    public var window: Window
    /// `SessionKey.stringValue` of the open chat.
    public var session: String?
    /// `SettingsSection.rawValue`, when `window == .settings`.
    public var settingsSection: String?
    public var savedAt: Date
    /// Set when the quit was "Restart to update" (not a plain quit with an update waiting), with the version
    /// it was to install: a launch on the same version soon after means the install did not happen.
    public var restartTarget: String?
    public var restartAttempt: Bool?

    public init(fromVersion: String, window: Window, session: String? = nil, settingsSection: String? = nil, savedAt: Date = Date(),
                restartAttempt: Bool? = nil, restartTarget: String? = nil) {
        self.restartAttempt = restartAttempt
        self.restartTarget = restartTarget
        self.fromVersion = fromVersion
        self.window = window
        self.session = session
        self.settingsSection = settingsSection
        self.savedAt = savedAt
    }

    public static let defaultsKey = "updateRestoreMarker"
    /// A marker older than this is not from the update that just ran (a failed install, a long gap).
    public static let maxAge: TimeInterval = 60 * 60

    public func encoded() -> Data? { try? JSONEncoder().encode(self) }

    public static func decode(_ data: Data?) -> UpdateRestoreMarker? {
        guard let data else { return nil }
        return try? JSONDecoder().decode(UpdateRestoreMarker.self, from: data)
    }

    /// How long after a "Restart to update" a launch on the same version still counts as that update not applying.
    public static let restartWindow: TimeInterval = 15 * 60

    /// True when this launch is the one after a "Restart to update" that did not change the version.
    public func restartDidNotApply(currentVersion: String, now: Date = Date()) -> Bool {
        restartAttempt == true && fromVersion == currentVersion && now.timeIntervalSince(savedAt) <= Self.restartWindow && savedAt <= now.addingTimeInterval(60)
    }

    /// The marker to act on at launch, or nil: only when the version really changed since it was
    /// written and it is recent. A stale or same-version marker is simply dropped by the caller.
    public func usable(currentVersion: String, now: Date = Date()) -> UpdateRestoreMarker? {
        guard fromVersion != currentVersion, now.timeIntervalSince(savedAt) <= Self.maxAge, savedAt <= now.addingTimeInterval(60) else { return nil }
        return self
    }
}

/// Compares the version that last ran with the one running now.
public enum VersionChange: Equatable, Sendable {
    case firstRun
    case unchanged
    case updated(from: String)

    public static func detect(lastRun: String?, current: String) -> VersionChange {
        guard let lastRun, !lastRun.isEmpty else { return .firstRun }
        return lastRun == current ? .unchanged : .updated(from: lastRun)
    }
}
