import CryptoKit
import Foundation

/// Pure rules behind the Heresay calls, so they are tested without the package or an app.
public enum HeresayIdentity {
    /// The id Heresay is told for a signed-in account: the account's own user id when known, else a stable hash of
    /// the email (lower-cased, trimmed), so the same person is the same id on every launch and device.
    public static func id(userId: String?, email: String?) -> String? {
        if let u = userId?.trimmingCharacters(in: .whitespacesAndNewlines), !u.isEmpty { return u }
        guard let e = email?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased(), !e.isEmpty else { return nil }
        let digest = SHA256.hash(data: Data(e.utf8))
        return "acct_" + digest.prefix(12).map { String(format: "%02x", $0) }.joined()
    }

    /// A short label from the email's local part ("sam@x.com" becomes "sam"); nil when there is no email.
    public static func label(email: String?) -> String? {
        guard let e = email?.trimmingCharacters(in: .whitespacesAndNewlines), let at = e.firstIndex(of: "@"), at != e.startIndex else { return nil }
        return String(e[..<at])
    }
}

/// Offers Heresay's help note once per episode of trouble: a service that stays unreachable past `after` seconds
/// fires once, and fires again only after it has been reachable in between.
public struct NudgeGate: Sendable, Equatable {
    public var after: TimeInterval
    private var downSince: Date?
    private var fired = false

    public init(after: TimeInterval = 30) { self.after = after }

    /// Feed every look at reachability; true exactly when the note should be offered now.
    public mutating func observe(reachable: Bool, now: Date = Date()) -> Bool {
        if reachable { downSince = nil; fired = false; return false }
        if downSince == nil { downSince = now }
        guard !fired, let since = downSince, now.timeIntervalSince(since) > after else { return false }
        fired = true
        return true
    }
}
