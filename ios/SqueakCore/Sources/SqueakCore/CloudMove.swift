import Foundation

/// The Mac moved the channel to another store: the sealed `state/move` document (docs/cloud-layer.md, "Moving").
/// Sealed with the channel key like every Mac document, so only the Mac could have written it:
/// `{v:1, provider:"firebase"|"catalyst", r?|c?, ck?, at}`.
public struct CloudMove: Codable, Equatable, Sendable {
    public let v: Int
    /// `firebase` or `catalyst`.
    public let provider: String
    /// firebase: the Realtime Database URL.
    public let r: String?
    /// catalyst: the relay base URL, and its key.
    public let c: String?
    public let ck: String?
    public let at: Int64

    public init(v: Int = 1, provider: String, r: String? = nil, c: String? = nil, ck: String? = nil, at: Int64) {
        self.v = v; self.provider = provider; self.r = r; self.c = c; self.ck = ck; self.at = at
    }

    /// A move is followed only to a host this phone would have accepted in a pairing code.
    public var isValid: Bool {
        guard v == 1 else { return false }
        switch provider {
        case "firebase": return r.map(Channel.isDatabaseURL) ?? false
        case "catalyst": return (c.map(Channel.isRelayURL) ?? false) && Self.isRelayKey(ck)
        default: return false
        }
    }

    /// A header value, so plain URL-safe characters only.
    static func isRelayKey(_ key: String?) -> Bool {
        guard let key, (16...200).contains(key.count) else { return false }
        return key.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || $0 == "-" || $0 == "_") }
    }
}
