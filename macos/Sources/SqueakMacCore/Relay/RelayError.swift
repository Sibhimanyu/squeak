import Foundation

/// Errors from the relay port. `message` uses the same strings as the
/// TypeScript implementation (`decrypt_failed`, `counter_mismatch`, ...).
public struct RelayError: Error, Equatable, CustomStringConvertible, Sendable {
    public let message: String
    public init(_ message: String) { self.message = message }
    public var description: String { message }

    public static let keyAgreementFailed = RelayError("key_agreement_failed")
    public static let decryptFailed = RelayError("decrypt_failed")
    public static let notOpen = RelayError("not_open")
    public static let counterMismatch = RelayError("counter_mismatch")
    public static let unsupportedVersion = RelayError("unsupported_version")
    public static func unexpectedFrame(_ t: String) -> RelayError { RelayError("unexpected_frame: \(t)") }
    public static func invalidHandshake(_ why: String) -> RelayError { RelayError("invalid_handshake: \(why)") }
}
