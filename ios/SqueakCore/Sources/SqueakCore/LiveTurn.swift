import CryptoKit
import Foundation

/// The verbose view of one session (src/remote/live-turn.ts): its whole
/// current turn, thinking included, written by the Mac only while this phone
/// asks for it and has that session open, and deleted when it stops looking.
public struct LiveTurn: Codable, Equatable, Sendable {
    public struct Step: Codable, Equatable, Sendable {
        public let kind: String
        public let text: String
        public let at: String?
    }

    public let v: Int
    public let key: String
    public let working: Bool
    /// How many steps the turn has had; `steps` holds the newest of them.
    public let total: Int
    public let steps: [Step]

    /// The document id for a session: the same as the Mac's `liveHandle`.
    public static func handle(for sessionKey: String) -> String {
        let digest = SHA256.hash(data: Data(sessionKey.utf8))
        let base64url = Data(digest).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        return String(base64url.prefix(22))
    }
}

/// What the phone's presence ping says, sealed: when it was last on screen
/// and, in verbose mode, which session it is watching.
public struct Presence: Codable, Equatable, Sendable {
    public let at: Int64
    /// The session open on screen, only when verbose mode is on.
    public let watching: String?

    public init(at: Int64, watching: String? = nil) {
        self.at = at; self.watching = watching
    }
}
