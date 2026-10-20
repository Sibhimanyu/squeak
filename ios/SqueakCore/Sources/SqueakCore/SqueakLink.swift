import Foundation

/// Links that open Squeak on one session: `squeak://open?s=<conductorSessionId>`.
/// The older `squeak://squeak?s=<id>` form is still accepted.
///
/// Telegram cards carry them (through an https redirect page, since Telegram
/// buttons only take https links), so tapping "Open in Squeak" on a card
/// lands on that session.
public enum SqueakLink {
    /// Conductor session ids are UUIDs; anything else is not ours.
    private static let allowed = CharacterSet(charactersIn: "0123456789abcdefABCDEF-")

    public static func sessionId(from url: URL) -> String? {
        guard url.scheme?.lowercased() == "squeak",
              url.host == "open" || url.host == "squeak",
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let id = components.queryItems?.first(where: { $0.name == "s" })?.value,
              (8...64).contains(id.count),
              id.unicodeScalars.allSatisfy({ allowed.contains($0) })
        else { return nil }
        return id
    }
}
