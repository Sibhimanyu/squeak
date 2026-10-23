import CryptoKit
import Foundation

/// The direct same-Wi-Fi path's request authentication, byte for byte the Mac's
/// `src/remote/local-auth.ts` (docs/remote-channel.md, "The direct path").
///
/// Plain HTTP on the LAN is acceptable only because every document stays an AES-GCM
/// box and every command stays signed by this phone's key, and because every request
/// carries an HMAC under a key derived from the channel key, and every response one
/// that binds the request's nonce, so a host that is not the Mac cannot be believed.
public enum LocalAuth {
    public static let label = "squeak-local-v1"
    static let responseLabel = "squeak-local-v1-resp"
    public static let headerTimestamp = "x-squeak-ts"
    public static let headerNonce = "x-squeak-nonce"
    public static let headerMAC = "x-squeak-mac"
    public static let headerResponseMAC = "x-squeak-rmac"

    /// HKDF-SHA256 of the channel key, no salt, info "squeak-local-v1".
    public static func key(channelKey: String) -> SymmetricKey? {
        guard let data = Data(base64Encoded: channelKey), data.count == 32 else { return nil }
        return HKDF<SHA256>.deriveKey(inputKeyMaterial: SymmetricKey(data: data), salt: Data(), info: Data(label.utf8), outputByteCount: 32)
    }

    /// The Mac's public tag: the first 8 bytes of HMAC-SHA256(channel key, "local-id"), hex.
    /// What a phone matches against a Bonjour result's TXT record to find its own Mac.
    public static func tag(channelKey: String) -> String? {
        guard let data = Data(base64Encoded: channelKey), data.count == 32 else { return nil }
        let mac = HMAC<SHA256>.authenticationCode(for: Data("local-id".utf8), using: SymmetricKey(data: data))
        return Data(mac).prefix(8).map { String(format: "%02x", $0) }.joined()
    }

    static func hex(_ data: Data) -> String { data.map { String(format: "%02x", $0) }.joined() }

    static func bodyHash(_ body: Data) -> String { hex(Data(SHA256.hash(data: body))) }

    public static func requestCanonical(method: String, target: String, timestamp: String, nonce: String, body: Data) -> String {
        [label, method.uppercased(), target, timestamp, nonce, bodyHash(body)].joined(separator: "\n")
    }

    public static func requestMAC(key: SymmetricKey, method: String, target: String, timestamp: String, nonce: String, body: Data) -> String {
        let canonical = requestCanonical(method: method, target: target, timestamp: timestamp, nonce: nonce, body: body)
        return Data(HMAC<SHA256>.authenticationCode(for: Data(canonical.utf8), using: key)).base64EncodedString()
    }

    public static func responseCanonical(nonce: String, status: Int, body: Data) -> String {
        [responseLabel, nonce, String(status), bodyHash(body)].joined(separator: "\n")
    }

    public static func responseMAC(key: SymmetricKey, nonce: String, status: Int, body: Data) -> String {
        Data(HMAC<SHA256>.authenticationCode(for: Data(responseCanonical(nonce: nonce, status: status, body: body).utf8), using: key)).base64EncodedString()
    }

    /// Constant time, through CryptoKit.
    public static func isValidResponse(key: SymmetricKey, nonce: String, status: Int, body: Data, mac: String?) -> Bool {
        guard let mac, let code = Data(base64Encoded: mac) else { return false }
        return HMAC<SHA256>.isValidAuthenticationCode(code, authenticating: Data(responseCanonical(nonce: nonce, status: status, body: body).utf8), using: key)
    }

    /// 16 random bytes, hex: what the Mac remembers to refuse a captured request sent again.
    public static func newNonce() -> String {
        var bytes = [UInt8](repeating: 0, count: 16)
        _ = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        return bytes.map { String(format: "%02x", $0) }.joined()
    }
}
