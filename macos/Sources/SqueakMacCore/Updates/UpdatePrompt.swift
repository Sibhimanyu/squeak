import Foundation

/// How the sidebar footer shows an offered update: the quiet row, nothing, or a small dot once the person said "Later".
public enum UpdatePrompt {
    public enum Mode: Equatable, Sendable { case none, row, dot }

    public static let dismissedKey = "squeak.update.dismissedVersion"

    /// `available` is the version on offer (nil = none). "Later" stores that version; a different (newer) one shows the row again.
    public static func mode(available: String?, dismissed: String?, installed: String) -> Mode {
        guard let available, !available.isEmpty, available != installed else { return .none }
        return dismissed == available ? .dot : .row
    }
}
