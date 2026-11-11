import CryptoKit
import Foundation

/// Pure rules behind the host app's Heresay calls, so they are tested without the package or a phone.
public enum HeresayIdentity {
    /// The id Heresay is told for a signed-in account: the account's own user id when known, else a stable hash of
    /// the email (lower-cased, trimmed), so the same person is the same id on every launch and device.
    public static func id(userId: String?, email: String?) -> String? {
        if let u = userId?.trimmingCharacters(in: .whitespacesAndNewlines), !u.isEmpty { return u }
        guard let e = email?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), !e.isEmpty else { return nil }
        let digest = SHA256.hash(data: Data(e.utf8))
        return "acct_" + digest.prefix(12).map { String(format: "%02x", $0) }.joined()
    }
}

/// Offers Heresay's help note once per episode of trouble: a service that stays unreachable past `after` seconds
/// fires once, and fires again only after it has been reachable in between.
public struct NudgeGate: Sendable, Equatable {
    public var after: TimeInterval
    private var fired = false

    public init(after: TimeInterval = 30) { self.after = after }

    /// `downSince` is when the service stopped answering, nil while it answers. True exactly when the note is due.
    public mutating func observe(downSince: Date?, now: Date = Date()) -> Bool {
        guard let downSince else { fired = false; return false }
        guard !fired, now.timeIntervalSince(downSince) > after else { return false }
        fired = true
        return true
    }
}
