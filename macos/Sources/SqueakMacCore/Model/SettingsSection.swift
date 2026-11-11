import Foundation

/// The pages of Settings, which lives inside the main window. `AppModel.settingsSection` is the
/// page on screen, or nil while the window shows sessions.
public enum SettingsSection: String, CaseIterable, Hashable, Sendable, Identifiable {
    case setup, account, general, notifications, awake, conductor, connections, telegram, cliq, iphone, voice, privacy, about

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .setup: "Setup"
        case .account: "Account"
        case .general: "Mac"
        case .notifications: "Notifications"
        case .awake: "Keep awake"
        case .conductor: "Conductor"
        case .connections: "Connections"
        case .telegram: "Telegram"
        case .cliq: "Zoho Cliq"
        case .iphone: "iPhone"
        case .voice: "Phone calls"
        case .privacy: "Privacy"
        case .about: "About"
        }
    }

    /// Sidebar groups, in order. The Agents group is empty until an agent page exists and is then not listed.
    public enum Group: String, CaseIterable, Sendable, Identifiable {
        case general, devices, agents, addons, about
        public var id: String { rawValue }
        public var title: String {
            switch self {
            case .general: "General"
            case .devices: "Devices"
            case .agents: "Agents"
            case .addons: "Add-ons"
            case .about: "About"
            }
        }
        public var sections: [SettingsSection] {
            switch self {
            case .general: [.setup, .account, .general, .notifications, .awake, .privacy]
            case .devices: [.iphone, .connections]
            case .agents: []
            case .addons: [.conductor, .telegram, .cliq, .voice]
            case .about: [.about]
            }
        }
    }

    /// The sidebar's groups that have pages, with their headers.
    public static var titledGroups: [Group] { Group.allCases.filter { !$0.sections.isEmpty } }

    /// The same, without headers.
    public static func groups() -> [[SettingsSection]] { titledGroups.map(\.sections) }

    /// A name from a deep link or the environment (`SQUEAK_MAC_SETTINGS_TAB`). "channels" is the old
    /// combined tab and lands on Telegram, its first half. Unknown names are nil, not General.
    public init?(link: String?) {
        guard let raw = link?.trimmingCharacters(in: .whitespaces).lowercased(), !raw.isEmpty else { return nil }
        if raw == "channels" { self = .telegram; return }
        if raw == "notify" || raw == "notification" { self = .notifications; return }
        if raw == "mac" { self = .general; return }
        if raw == "cliq" || raw == "zoho" { self = .cliq; return }
        if raw == "calls" || raw == "phone" || raw == "3cx" { self = .voice; return }
        guard let s = SettingsSection(rawValue: raw) else { return nil }
        self = s
    }
}
