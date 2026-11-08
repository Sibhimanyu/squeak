import Foundation

/// What the phone feels, as data: every interactive moment names an `Event`, the table says which of six
/// feelings it is, and `Haptics` (iOS only) plays it. Kept free of UIKit so the table is tested.
///
/// Never fired: scrolling, live ticks, automatic state changes, pull-to-refresh except the release moment.
public enum HapticEvent: String, CaseIterable, Sendable {
    // light impact
    case tap, navigate, menu, toggle, refresh
    // selection
    case tab, segment, pick, option
    // firm impact: the person commits something
    case send, queue, steer, stop, answer, approve
    // notifications: the Mac's word
    case confirmed, notConfirmed, refused
}

public enum HapticKind: String, CaseIterable, Sendable {
    case light, selection, firm, success, warning, error

    /// Notifications are the Mac's word and always play; the others yield to one just played.
    public var isNotification: Bool { self == .success || self == .warning || self == .error }

    /// How strong the touch is; a stronger feeling is never swallowed by a weaker one just before it.
    public var weight: Int { self == .firm ? 1 : isNotification ? 2 : 0 }
}

public enum HapticMap {
    public static let table: [HapticEvent: HapticKind] = [
        .tap: .light, .navigate: .light, .menu: .light, .toggle: .light, .refresh: .light,
        .tab: .selection, .segment: .selection, .pick: .selection, .option: .selection,
        .send: .firm, .queue: .firm, .steer: .firm, .stop: .firm, .answer: .firm, .approve: .firm,
        .confirmed: .success, .notConfirmed: .warning, .refused: .error,
    ]

    public static func kind(_ event: HapticEvent) -> HapticKind { table[event] ?? .light }

    /// One control must never buzz twice: a feeling that comes right after another is dropped, unless it is the
    /// Mac's word (a notification), which is the news and always plays.
    public static let quiet: TimeInterval = 0.12

    public static func plays(_ kind: HapticKind, sinceLast: TimeInterval?, last: HapticKind? = nil) -> Bool {
        if kind.isNotification { return true }
        guard let sinceLast, let last else { return true }
        return sinceLast >= quiet || kind.weight > last.weight
    }
}
