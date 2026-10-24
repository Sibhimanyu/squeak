import Foundation

/// Words for the Mac's awake rules and the last session's end, drawn from what the Mac sends. Formatting
/// only: the Mac decides every number and every end; this phone never picks a threshold of its own, and says
/// 40 and 10 only for an older Mac that sends none.
public enum AwakeFormat {
    /// What older Macs enforce and say nothing about.
    public static let defaultRules = PhoneSnapshot.AwakeRules(lowPowerPercent: 40, endPercent: 10, heat: true)

    /// The four lid actions, in the order they are shown, with the explanation the Mac's own page gives.
    public struct LidActionInfo: Identifiable, Equatable, Sendable {
        public let key: String
        public let title: String
        public let detail: String
        public var id: String { key }
    }

    /// What a running session does while the lid is open, in the order they are shown.
    public static let openActionInfos: [LidActionInfo] = [
        .init(key: "screenOn", title: "Keep the screen on", detail: "The display stays on, so the Mac doesn't lock while you're away."),
        .init(key: "mute", title: "Mute the sound", detail: "Only if it wasn't muted already, and unmuted when the session ends."),
        .init(key: "lowPower", title: "Use Low Power Mode", detail: "Saves battery for the whole session."),
        .init(key: "freezeApps", title: "Pause chat apps", detail: "Slack, WhatsApp, Discord and Telegram stop until the session ends."),
    ]

    public static let lidActionInfos: [LidActionInfo] = [
        .init(key: "displayOff", title: "Turn off the display", detail: "The screen goes dark when the lid closes."),
        .init(key: "mute", title: "Mute the sound", detail: "Only if it wasn't muted already, and unmuted when the lid opens."),
        .init(key: "lowPower", title: "Use Low Power Mode", detail: "Saves battery while the lid is shut."),
        .init(key: "freezeApps", title: "Pause chat apps", detail: "Slack, WhatsApp, Discord and Telegram stop until the lid opens."),
    ]

    /// "Low Power Mode comes on at 40% battery or when your Mac runs hot, and the session ends by itself at 10%
    /// or when it gets very hot."
    public static func safetySentence(_ rules: PhoneSnapshot.AwakeRules?) -> String {
        let r = rules ?? defaultRules
        let heat = r.heat ?? true
        return "Low Power Mode comes on at \(r.lowPowerPercent)% battery\(heat ? " or when your Mac runs hot" : ""), "
            + "and the session ends by itself at \(r.endPercent)%\(heat ? " or when it gets very hot" : "")."
    }

    /// "1h 23m" / "45m" / "under a minute" until `until`.
    public static func left(_ until: Date, now: Date = Date()) -> String {
        let minutes = Int((until.timeIntervalSince(now) / 60).rounded(.up))
        if minutes <= 1 { return "under a minute" }
        let hours = minutes / 60
        if hours >= 24 { return "\(hours / 24)d \(hours % 24)h" }
        return hours > 0 ? "\(hours)h \(minutes % 60)m" : "\(minutes)m"
    }

    /// A line for a session a safety rule ended (and only within the last 6 hours), or nil.
    public static func ended(_ end: PhoneSnapshot.AwakeEnd?, now: Date = Date()) -> String? {
        guard let end, end.reason == "battery" || end.reason == "heat" else { return nil }
        if let at = end.at.flatMap(parse), now.timeIntervalSince(at) > 6 * 3600 { return nil }
        let what = end.reason == "battery" ? "The last session ended because the battery ran low" : "The last session ended because your Mac got too hot"
        return what + (end.why.map { " (\($0))" } ?? "") + "."
    }

    private static func parse(_ value: String) -> Date? {
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return fractional.date(from: value) ?? ISO8601DateFormatter().date(from: value)
    }
}
