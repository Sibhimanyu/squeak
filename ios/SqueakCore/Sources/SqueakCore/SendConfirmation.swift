import Foundation

/// "Ask for Face ID to send": on this phone only, on by default. Pure, so tests can pin it. Turning it off needs
/// Face ID or the passcode once (the caller's job); PIN reset never reads it.
public struct SendConfirmation: Equatable, Sendable {
    public static let key = "squeak.askFaceIDToSend"

    public var asksForFaceID: Bool

    public init(asksForFaceID: Bool = true) { self.asksForFaceID = asksForFaceID }

    /// Absent = on.
    public init(defaults: UserDefaults) {
        asksForFaceID = defaults.object(forKey: Self.key) as? Bool ?? true
    }

    public func save(to defaults: UserDefaults) { defaults.set(asksForFaceID, forKey: Self.key) }

    /// Whether a send must be confirmed now: the setting is on and the unlock has lapsed.
    public func needsConfirmation(_ unlock: SendUnlock) -> Bool { asksForFaceID && unlock.needsAuthentication }

    /// Turning it on is free; turning it off asks the owner first.
    public static func needsOwnerCheck(turningOn: Bool) -> Bool { !turningOn }
}
