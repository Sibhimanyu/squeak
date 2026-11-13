import Foundation

/// The pages of Settings, which lives inside the main window. `AppModel.settingsSection` is the
/// page on screen, or nil while the window shows sessions.
public enum SettingsSection: String, CaseIterable, Hashable, Sendable, Identifiable {
    case account, notifications, privacy, models, messages, general, awake, service, iphone, connections, addons, telegram, cliq, voice, conductor, rasanai, about

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .account: "Account"
        case .models: "Models & presets"
        case .messages: "Messages"
        case .general: "General"
        case .service: "Background service"
        case .notifications: "Notifications"
        case .awake: "Keep awake"
        case .addons: "Extensions"
        case .conductor: "Conductor"
        case .rasanai: "RasanAI"
        case .connections: "Connections"
        case .telegram: "Telegram"
        case .cliq: "Zoho Cliq"
        case .iphone: "iPhone"
        case .voice: "Phone calls"
        case .privacy: "Privacy"
        case .about: "About"
        }
    }

    /// Sidebar groups, in order.
    public enum Group: String, CaseIterable, Sendable, Identifiable {
        case you, agents, mac, devices, extensions, about
        public var id: String { rawValue }
        public var title: String {
            switch self {
            case .you: "You"
            case .agents: "Agents"
            case .mac: "This Mac"
            case .devices: "Devices"
            case .extensions: "Extensions"
            case .about: "About"
            }
        }
        public var sections: [SettingsSection] {
            switch self {
            case .you: [.account, .notifications, .privacy]
            case .agents: [.models, .messages]
            case .mac: [.general, .awake, .service]
            case .devices: [.iphone, .connections]
            // The overview, then each extension's own page; the sidebar lists a page only while its extension is added.
            case .extensions: [.addons, .telegram, .cliq, .voice, .conductor, .rasanai]
            case .about: [.about]
            }
        }
    }

    /// The sidebar's groups that have pages, with their headers.
    public static var titledGroups: [Group] { Group.allCases.filter { !$0.sections.isEmpty } }

    /// The same, without headers.
    public static func groups() -> [[SettingsSection]] { titledGroups.map(\.sections) }

    /// Setup is a card, not a page: `setup` opens Settings with the "Finish setting up" card expanded.
    public static func isSetupLink(_ link: String?) -> Bool {
        link?.trimmingCharacters(in: .whitespaces).lowercased() == "setup"
    }

    /// A name from a deep link or the environment (`SQUEAK_MAC_SETTINGS_TAB`). "channels" is the old
    /// combined tab and lands on Telegram, its first half. Unknown names (and "setup", see `isSetupLink`) are nil.
    public init?(link: String?) {
        guard let raw = link?.trimmingCharacters(in: .whitespaces).lowercased(), !raw.isEmpty else { return nil }
        switch raw {
        case "channels": self = .telegram
        case "notify", "notification": self = .notifications
        case "mac", "this mac": self = .general
        case "presets", "preset", "models & presets", "models-presets": self = .models
        case "sending", "send": self = .messages
        case "diagnostics", "service", "background service", "daemon": self = .service
        case "addons", "add-ons", "addon", "add-on", "integrations", "integration", "extension", "extensions": self = .addons
        case "cliq", "zoho": self = .cliq
        case "calls", "phone", "3cx": self = .voice
        default:
            guard let s = SettingsSection(rawValue: raw) else { return nil }
            self = s
        }
    }
}

/// The "Finish setting up" card: shown only while a listed first-run step is still to do (a skipped one is a decision).
public enum SetupCard {
    public static func remaining(_ flow: SetupFlow) -> [SetupStage] { SetupStage.listed.filter { flow.state($0) == .todo } }
    public static func isVisible(_ flow: SetupFlow) -> Bool { !remaining(flow).isEmpty }

    /// Steps finished, out of the listed ones (a skipped step is not finished).
    public static func progress(_ flow: SetupFlow) -> (done: Int, total: Int) {
        (SetupStage.listed.filter { flow.state($0) == .done }.count, SetupStage.listed.count)
    }

    /// The ring's fill, 0...1 (0 with no steps listed).
    public static func fraction(done: Int, total: Int) -> Double {
        total > 0 ? min(1, max(0, Double(done) / Double(total))) : 0
    }

    /// "1 step left", "3 steps left".
    public static func subtitle(left: Int) -> String { left == 1 ? "1 step left" : "\(left) steps left" }
}
