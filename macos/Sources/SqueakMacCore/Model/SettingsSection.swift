import Foundation

/// The pages of Settings, which lives inside the main window. `AppModel.settingsSection` is the
/// page on screen, or nil while the window shows sessions.
public enum SettingsSection: String, CaseIterable, Hashable, Sendable, Identifiable {
    case setup, general, notifications, awake, conductor, connections, telegram, cliq, iphone, voice, cloud, privacy, about

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .setup: "Setup"
        case .general: "Mac"
        case .notifications: "Notifications"
        case .awake: "Keep awake"
        case .conductor: "Conductor"
        case .connections: "Connections"
        case .telegram: "Telegram"
        case .cliq: "Zoho Cliq"
        case .iphone: "iPhone"
        case .voice: "Phone calls"
        case .cloud: "Cloud"
        case .privacy: "Privacy"
        case .about: "About"
        }
    }

    /// Sidebar grouping: how the app behaves, the services it talks to, then Squeak itself.
    /// The Conductor page is listed only while an add-on provides it (`AddonRegistry`).
    public static func groups(conductorLink: Bool = AddonRegistry.hasConductorLink) -> [[SettingsSection]] {
        [
            [.setup],
            [.general, .notifications, .awake],
            (conductorLink ? [.conductor] : []) + [.connections, .telegram, .cliq, .iphone, .voice, .cloud],
            [.privacy, .about],
        ]
    }

    /// A name from a deep link or the environment (`SQUEAK_MAC_SETTINGS_TAB`). "channels" is the old
    /// combined tab and lands on Telegram, its first half. Unknown names are nil, not General.
    public init?(link: String?, conductorLink: Bool = AddonRegistry.hasConductorLink) {
        guard let raw = link?.trimmingCharacters(in: .whitespaces).lowercased(), !raw.isEmpty else { return nil }
        if raw == "channels" { self = .telegram; return }
        if raw == "notify" || raw == "notification" { self = .notifications; return }
        if raw == "mac" { self = .general; return }
        if raw == "cliq" || raw == "zoho" { self = .cliq; return }
        if raw == "calls" || raw == "phone" || raw == "3cx" { self = .voice; return }
        guard let s = SettingsSection(rawValue: raw), s != .conductor || conductorLink else { return nil }
        self = s
    }
}
