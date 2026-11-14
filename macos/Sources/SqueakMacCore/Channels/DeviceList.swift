import Foundation

/// What Settings › Devices shows: every iPhone and browser that can open this Mac, from the daemon's own list. There is
/// no pairing step to explain: a device joins by signing in to the same Squeak account, so the rows say what it is and
/// how it got here, and the person can remove it.
public enum DeviceKind: String, Sendable, Equatable {
    case iphone, browser, other

    /// From the name the device gave itself ("Sibhi's iPhone", "Web · Chrome").
    public init(name: String) {
        let n = name.lowercased()
        if n.contains("iphone") || n.contains("ipad") { self = .iphone }
        else if n.hasPrefix("web") || ["chrome", "safari", "firefox", "edge", "brave", "arc", "browser"].contains(where: n.contains) { self = .browser }
        else { self = .other }
    }

    public var symbol: String {
        switch self {
        case .iphone: "iphone.gen3"
        case .browser: "globe"
        case .other: "laptopcomputer.and.iphone"
        }
    }
}

public struct DeviceRow: Identifiable, Equatable, Sendable {
    public var id: String
    public var name: String
    public var kind: DeviceKind
    /// "On your account · added 3 Nov 2026", "Added 3 Nov 2026", or "On your account".
    public var line: String
    public var viaAccount: Bool
}

public enum DeviceList {
    /// Active devices only, newest first (a device without a date goes last, then by name).
    public static func rows(_ devices: [RemoteStatus.Device], calendar: Calendar = .current, locale: Locale = Locale(identifier: "en_GB")) -> [DeviceRow] {
        let f = DateFormatter()
        f.locale = locale; f.calendar = calendar; f.timeZone = calendar.timeZone
        f.dateFormat = "d MMM yyyy"
        return devices.filter { $0.revokedAt == nil }
            .sorted {
                switch ($0.pairedAt, $1.pairedAt) {
                case let (a?, b?): return a == b ? $0.name < $1.name : a > b
                case (_?, nil): return true
                case (nil, _?): return false
                default: return $0.name < $1.name
                }
            }
            .map { d in
                let date = d.pairedAt.map { f.string(from: $0) }
                let line: String
                switch (d.isViaAccount, date) {
                case (true, let day?): line = "On your account · added \(day)"
                case (true, nil): line = "On your account"
                case (false, let day?): line = "Added \(day)"
                case (false, nil): line = "Added earlier"
                }
                return DeviceRow(id: d.id, name: d.name, kind: DeviceKind(name: d.name), line: line, viaAccount: d.isViaAccount)
            }
    }

    /// The empty state: nothing about pairing, only what to do.
    public static func emptyLine(accountEmail: String?) -> String {
        if let email = accountEmail, !email.isEmpty {
            return "Open Squeak on your iPhone or on the web and sign in as \(email). This Mac shows up there by itself."
        }
        return "Sign in to Squeak on this Mac, then sign in with the same account on your iPhone or the web."
    }

    /// Under the list.
    public static func footnote() -> String {
        "A device on your account can read your sessions and send replies. Remove one to cut it off at once."
    }

    /// The "Ask before adding my own devices" footnote: one click, never a code.
    public static func askFootnote(email: String) -> String {
        "When off, an iPhone or browser signed in to \(email) joins this Mac by itself. When on, each new one waits here, and in a notification, for one click to approve it. You're told either way and can remove it."
    }

    /// The dialog behind Remove.
    public static func removeMessage(name: String) -> String {
        "\(name) stops getting sessions and can't reply. Signing in on it again adds it back."
    }
}

/// Finds account requests that now wait for a click (`askOwnDevices` on), once each. The first status seeds what is
/// already waiting without telling anyone, so a restart never repeats an old request.
public struct PendingRequestWatch: Sendable, Equatable {
    private var seen: Set<String> = []
    private var seeded = false
    public init() {}

    public mutating func newlyWaiting(in status: RemoteStatus) -> [RemoteStatus.Pending] {
        let current = status.pending.filter(\.isAccountRequest)
        defer { seen = Set(current.map(\.id)); seeded = true }
        guard seeded else { return [] }
        return current.filter { !seen.contains($0.id) }
    }
}
