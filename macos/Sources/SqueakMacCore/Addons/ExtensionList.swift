import Foundation

/// Settings › Extensions: every extension as one kind of card. The daemon's add-ons (`/control/addons`) and the
/// built-in channels (Telegram, Zoho Cliq, Phone calls) are merged here, so the page only draws what this says.
public enum ExtensionStatus: String, Sendable, Equatable {
    case added, notAdded, needsAttention

    public var label: String {
        switch self {
        case .added: "Added"
        case .notAdded: "Not added"
        case .needsAttention: "Needs attention"
        }
    }
}

public struct ExtensionItem: Identifiable, Equatable, Sendable {
    public enum Kind: Equatable, Sendable { case addon, telegram, cliq, calls }

    public var id: String
    public var name: String
    public var blurb: String
    public var kind: Kind
    public var status: ExtensionStatus
    /// Its own page in Settings (nil for a daemon add-on this app has no page for).
    public var section: SettingsSection?
    /// Add can be pressed (a daemon add-on whose host is missing cannot be added).
    public var canAdd: Bool
    /// A sentence under the blurb when something is off ("Conductor isn't installed on this Mac").
    public var note: String?
    /// Phone calls only: this Mac is set up for calls (so Add switches them on rather than opening setup).
    public var callsConfigured = false

    public var isAdded: Bool { status != .notAdded }
}

public enum ExtensionList {
    /// The page each daemon add-on opens.
    public static func section(forAddon id: String) -> SettingsSection? {
        switch id {
        case "conductor": .conductor
        case "rasanai": .rasanai
        default: nil
        }
    }

    /// Daemon add-ons first, then the built-ins. A nil channel answer reads as not added, never as an error.
    public static func items(
        addons: [AddonInfo], telegram: ChannelsStatus.Telegram?, cliq: ChannelsStatus.Cliq?, voice: VoiceSettings?
    ) -> [ExtensionItem] {
        var out = addons.map { info -> ExtensionItem in
            let status: ExtensionStatus = info.enabled ? (info.available ? .added : .needsAttention) : .notAdded
            return ExtensionItem(
                id: info.id, name: info.name, blurb: info.blurb, kind: .addon, status: status, section: section(forAddon: info.id),
                canAdd: info.available,
                note: info.available ? nil : "\(info.name) isn't installed on this Mac.")
        }
        let tgStatus: ExtensionStatus = telegram.map { $0.configured ? ($0.polling == .error ? .needsAttention : .added) : .notAdded } ?? .notAdded
        out.append(ExtensionItem(
            id: "telegram", name: "Telegram", blurb: "Cards and replies in a private Telegram chat.", kind: .telegram, status: tgStatus,
            section: .telegram, canAdd: true, note: tgStatus == .needsAttention ? telegram?.lastError : nil))
        let cliqOn = cliq.map { $0.oneWay || $0.twoWay } ?? false
        out.append(ExtensionItem(
            id: "cliq", name: "Zoho Cliq", blurb: "Updates and replies through your Cliq bot.", kind: .cliq, status: cliqOn ? .added : .notAdded,
            section: .cliq, canAdd: true, note: nil))
        out.append(ExtensionItem(
            id: "calls", name: "Phone calls", blurb: "A phone call when an agent is waiting for you.", kind: .calls,
            status: voice?.callsOn == true ? .added : .notAdded, section: .voice, canAdd: true, note: nil,
            callsConfigured: voice?.isOn == true && voice?.enabled != nil))
        return out
    }

    /// The sidebar rows under Extensions: the overview, then each added extension's own page.
    public static func sidebarSections(_ items: [ExtensionItem]) -> [SettingsSection] {
        [.addons] + items.filter(\.isAdded).compactMap(\.section)
    }
}
