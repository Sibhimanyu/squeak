import Foundation

/// The pages of Settings, which lives inside the main window. `AppModel.settingsSection` is the
/// page on screen, or nil while the window shows sessions.
public enum SettingsSection: String, CaseIterable, Hashable, Sendable, Identifiable {
    case general, notifications, awake, connections, telegram, cliq, iphone, privacy, about

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .general: "Mac"
        case .notifications: "Notifications"
        case .awake: "Keep awake"
        case .connections: "Connections"
        case .telegram: "Telegram"
        case .cliq: "Zoho Cliq"
        case .iphone: "iPhone"
        case .privacy: "Privacy"
        case .about: "About"
        }
    }

    /// Sidebar grouping: how the app behaves, the services it talks to, then Squeak itself.
    public static let groups: [[SettingsSection]] = [
        [.general, .notifications, .awake],
        [.connections, .telegram, .cliq, .iphone],
        [.privacy, .about],
    ]

    /// A name from a deep link or the environment (`SQUEAK_MAC_SETTINGS_TAB`). "channels" is the old
    /// combined tab and lands on Telegram, its first half. Unknown names are nil, not General.
    public init?(link: String?) {
        guard let raw = link?.trimmingCharacters(in: .whitespaces).lowercased(), !raw.isEmpty else { return nil }
        if raw == "channels" { self = .telegram; return }
        if raw == "notify" || raw == "notification" { self = .notifications; return }
        if raw == "mac" { self = .general; return }
        if raw == "cliq" || raw == "zoho" { self = .cliq; return }
        guard let s = SettingsSection(rawValue: raw) else { return nil }
        self = s
    }
}
