import Foundation

/// Words for the Mac's awake session, drawn from what `/state` says. Formatting only: nothing here
/// decides whether a session runs, whether the lid is safe or why it ended; the daemon says that.
public enum AwakeFormat {
    /// "2h 10m left", "45m left", "under a minute left"; nil for a session with no end.
    public static func left(until: Date?, now: Date = Date()) -> String? {
        guard let until else { return nil }
        let minutes = Int((until.timeIntervalSince(now) / 60).rounded(.up))
        if minutes <= 0 { return "ending now" }
        if minutes < 2 && until.timeIntervalSince(now) < 60 { return "under a minute left" }
        let h = minutes / 60, m = minutes % 60
        if h == 0 { return "\(m)m left" }
        if m == 0 { return "\(h)h left" }
        return "\(h)h \(m)m left"
    }

    /// "6:30 PM" in the person's own clock format.
    public static func clock(_ date: Date, locale: Locale = .current, timeZone: TimeZone = .current) -> String {
        var style = Date.FormatStyle(date: .omitted, time: .shortened, locale: locale, timeZone: timeZone)
        style.timeZone = timeZone
        return date.formatted(style)
    }

    /// The headline: "Off", "On until 6:30 PM" or "On until you end it".
    public static func headline(_ awake: DaemonAwake?, locale: Locale = .current, timeZone: TimeZone = .current) -> String {
        guard let awake else { return "Off" }
        guard let until = awake.until else { return "On until you end it" }
        return "On until \(clock(until, locale: locale, timeZone: timeZone))"
    }

    /// What the lid does in this session, as the daemon reports it.
    public enum Lid: Equatable, Sendable {
        /// Not asked for: closing the lid sleeps the Mac.
        case open
        case starting
        case on
        case failed(String?)
    }

    public static func lid(_ awake: DaemonAwake) -> Lid {
        guard awake.lid else { return .open }
        switch awake.lidStatus {
        case "starting": return .starting
        case "failed": return .failed(awake.lidProblem)
        default: return .on
        }
    }

    public static func lidTitle(_ lid: Lid) -> String {
        switch lid {
        case .open: "Lid open only"
        case .starting: "Getting ready for a closed lid"
        case .on: "Lid closed is on"
        case .failed: "Lid closed didn't turn on"
        }
    }

    public static func lidDetail(_ lid: Lid) -> String {
        switch lid {
        case .open: "Closing the lid will sleep your Mac."
        case .starting: "Keep the lid open for a few seconds."
        case .on: "Safe to close the lid. Keep the Mac on a hard, open surface, never in a bag."
        case .failed(let why): (why.map { $0 + " " } ?? "") + "The session still runs with the lid open."
        }
    }

    /// A line for a session that a safety rule ended, or nil when it ended any other way.
    public static func ended(_ end: DaemonAwakeEnd?, now: Date = Date()) -> String? {
        guard let end, end.reason == "battery" || end.reason == "heat" else { return nil }
        if let at = end.at, now.timeIntervalSince(at) > 6 * 3600 { return nil }
        let what = end.reason == "battery" ? "The last session ended because the battery ran low" : "The last session ended because your Mac got too hot"
        let why = end.why.map { " (\($0))" } ?? ""
        return what + why + "."
    }

    /// What older daemons enforce and say nothing about; used only when `awakeRules` is absent.
    public static let defaultRules = DaemonAwakeRules(lowPowerPercent: 40, endPercent: 10, heat: true)

    public static func lowPowerTitle(_ rules: DaemonAwakeRules?) -> String {
        "Low Power Mode at \((rules ?? defaultRules).lowPowerPercent)%"
    }

    public static func lowPowerDetail(_ rules: DaemonAwakeRules?) -> String {
        let r = rules ?? defaultRules
        return "Squeak switches it on when the battery drops to \(r.lowPowerPercent)%\(r.heat ? " or your Mac runs hot" : ""), so the session lasts longer."
    }

    public static func endTitle(_ rules: DaemonAwakeRules?) -> String {
        "Ends at \((rules ?? defaultRules).endPercent)%"
    }

    public static func endDetail(_ rules: DaemonAwakeRules?) -> String {
        let r = rules ?? defaultRules
        return "The session ends by itself at \(r.endPercent)% battery\(r.heat ? " or when your Mac gets very hot" : ""), and sleep comes back on."
    }

    /// Heat's headline: the daemon's own line while it acts, else the plain state.
    public static func heatTitle(_ heat: DaemonHeat) -> String {
        switch heat.level {
        case "hot": return "Hot"
        case "warm": return "Warm"
        default: return "Cool"
        }
    }

    /// "Chip 62°C · Battery 33°C · Fans 2,300 rpm"; nil when nothing was read.
    public static func heatReading(_ heat: DaemonHeat, locale: Locale = .current) -> String? {
        var parts: [String] = []
        if let die = heat.die { parts.append("Chip \(die)°C") }
        if let battery = heat.battery { parts.append("Battery \(battery)°C") }
        if let fastest = heat.fansRpm.max() {
            parts.append(fastest == 0 ? "Fans off" : "Fans \(fastest.formatted(.number.locale(locale))) rpm\(heat.fansMax ? ", full" : "")")
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    /// Why hotspot input cannot be saved, in words; nil when it can. The daemon checks the same rules again.
    /// `keepsPassword`: this name is the one already saved, so an empty password leaves the stored one alone.
    public static func hotspotProblem(ssid: String, password: String, keepsPassword: Bool = false) -> String? {
        let name = ssid.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty { return "Enter your iPhone hotspot's name." }
        if name.utf8.count > 32 { return "A Wi-Fi name is at most 32 characters." }
        if name.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value == 0x7f }) { return "That name has a character Wi-Fi can't use." }
        if password.isEmpty { return keepsPassword ? nil : "Enter the hotspot's password." }
        if password.utf8.count < 8 || password.utf8.count > 63 { return "A hotspot password is 8 to 63 characters." }
        if password.unicodeScalars.contains(where: { $0.value < 0x20 || $0.value > 0x7e }) {
            return "A hotspot password uses plain letters, numbers and symbols."
        }
        return nil
    }

    /// The four lid actions, in the order they are shown, with what each does.
    public struct LidActionInfo: Identifiable, Equatable, Sendable {
        public let key: String
        public let title: String
        public let detail: String
        public var id: String { key }
    }

    public static let lidActionInfos: [LidActionInfo] = [
        .init(key: "displayOff", title: "Turn off the display", detail: "The screen goes dark when the lid closes."),
        .init(key: "mute", title: "Mute the sound", detail: "Only if it wasn't muted already, and unmuted when the lid opens."),
        .init(key: "lowPower", title: "Use Low Power Mode", detail: "Saves battery while the lid is shut."),
        .init(key: "freezeApps", title: "Pause chat apps", detail: "Slack, WhatsApp, Discord and Telegram stop until the lid opens."),
    ]

    public static func value(_ key: String, in actions: DaemonLidActions) -> Bool {
        switch key {
        case "displayOff": actions.displayOff
        case "mute": actions.mute
        case "lowPower": actions.lowPower
        case "freezeApps": actions.freezeApps
        default: false
        }
    }
}
