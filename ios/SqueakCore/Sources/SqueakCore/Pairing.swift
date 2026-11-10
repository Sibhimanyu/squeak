import Foundation

/// What the Mac's pairing QR code carries: `squeak://pair?d=<base64url JSON>`.
/// The channel key in here is the secret that lets a phone read; it goes
/// straight to the Keychain and is never shown again.
public struct PairingPayload: Codable, Equatable, Sendable {
    public let v: Int
    /// Firebase project id.
    public let p: String
    /// Channel id: the Firestore path.
    public let c: String
    /// Channel key, base64: AES-256-GCM.
    public let k: String
    /// The Mac's name, for the screen.
    public let n: String
    /// The Realtime Database URL, when the Mac's channel lives there. Absent
    /// in codes from before it did; such a phone learns it from the sealed
    /// `state/transport` document (`Channel`).
    public let r: String?
    /// Catalyst's relay base URL, when the channel lives there (docs/cloud-layer.md). The contract calls it `c`, which
    /// here is already the channel id, so in a pairing code it travels as `cu`; in the `move` document it is `c`.
    public let cu: String?
    /// The relay key for `cu`; kept with the channel key in the Keychain.
    public let ck: String?
    /// When the `move` this pairing last followed was made, so an older one is never followed back.
    public let ma: Int64?

    public init(v: Int, p: String, c: String, k: String, n: String, r: String? = nil, cu: String? = nil, ck: String? = nil, ma: Int64? = nil) {
        self.v = v; self.p = p; self.c = c; self.k = k; self.n = n; self.r = r; self.cu = cu; self.ck = ck; self.ma = ma
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        v = try values.decode(Int.self, forKey: .v)
        // A Catalyst-only Mac has no Firebase project; the id is only used to reach Firestore.
        p = try values.decodeIfPresent(String.self, forKey: .p) ?? ""
        c = try values.decode(String.self, forKey: .c)
        k = try values.decode(String.self, forKey: .k)
        n = try values.decode(String.self, forKey: .n)
        r = try values.decodeIfPresent(String.self, forKey: .r)
        cu = try values.decodeIfPresent(String.self, forKey: .cu)
        ck = try values.decodeIfPresent(String.self, forKey: .ck)
        ma = try values.decodeIfPresent(Int64.self, forKey: .ma)
    }

    /// Catalyst when the code names a relay, else the Realtime Database / Firestore as before.
    public var onCatalyst: Bool { cu != nil }

    /// This pairing after the Mac moved the channel, or nil when the move changes nothing or is older than the last.
    public func applying(_ move: CloudMove) -> PairingPayload? {
        guard move.isValid, move.at > (ma ?? 0) else { return nil }
        switch move.provider {
        case "catalyst":
            guard move.c != cu || move.ck != ck else { return nil }
            return PairingPayload(v: v, p: p, c: c, k: k, n: n, r: nil, cu: move.c, ck: move.ck, ma: move.at)
        default:
            guard cu != nil || move.r != r else { return nil }
            return PairingPayload(v: v, p: p, c: c, k: k, n: n, r: move.r, cu: nil, ck: nil, ma: move.at)
        }
    }

    public enum Failure: Error, Equatable { case notAPairingCode, unsupportedVersion }

    public static func parse(_ text: String) throws -> PairingPayload {
        guard let components = URLComponents(string: text.trimmingCharacters(in: .whitespacesAndNewlines)),
              components.scheme == "squeak", components.host == "pair",
              let encoded = components.queryItems?.first(where: { $0.name == "d" })?.value,
              let data = Data(base64URLEncoded: encoded)
        else { throw Failure.notAPairingCode }
        return try JSONDecoder().decode(PairingPayload.self, from: data).validated()
    }

    /// The checks a scanned code gets, shared with a payload the Mac seals to this phone (`AccountPairing`).
    public func validated() throws -> PairingPayload {
        let payload = self
        guard payload.v == 1 else { throw Failure.unsupportedVersion }
        guard Data(base64Encoded: payload.k)?.count == 32, payload.c.count >= 22 else { throw Failure.notAPairingCode }
        guard payload.r.map(Channel.isDatabaseURL) ?? true else { throw Failure.notAPairingCode }
        // A relay URL and its key come together, and only for a Catalyst host.
        if payload.cu != nil || payload.ck != nil {
            guard let relay = payload.cu, Channel.isRelayURL(relay), CloudMove.isRelayKey(payload.ck) else { throw Failure.notAPairingCode }
        }
        return payload
    }
}

extension Data {
    init?(base64URLEncoded text: String) {
        var base64 = text.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while base64.count % 4 != 0 { base64 += "=" }
        self.init(base64Encoded: base64)
    }
}
