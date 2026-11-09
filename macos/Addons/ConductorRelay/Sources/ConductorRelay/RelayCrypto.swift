import CryptoKit
import Foundation

/// Swift port of `src/fleet/conductor-relay/crypto.ts`: the phone (and, for
/// tests, host) side of Conductor's desktop-relay encrypted session.
/// X25519 + HKDF-SHA256 + XChaCha20-Poly1305 (HChaCha20 subkey over CryptoKit's
/// IETF ChaChaPoly), with the transcript and labels byte-identical to Node's.
public enum RelayCrypto {
    public static let protocolVersion = 2
    public static let dirClientToHost: UInt8 = 1
    public static let dirHostToClient: UInt8 = 2

    static let transcriptLabel = "conductor-desktop-relay-v1/transcript"
    static let saltLabel = "conductor-desktop-relay-v1/salt"
    static let keysLabel = "conductor-desktop-relay-v1/keys"

    // MARK: base64url

    public static func b64urlEncode(_ data: Data) -> String {
        data.base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public static func b64urlDecode(_ s: String) -> Data? {
        var t = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        t = t.replacingOccurrences(of: "=", with: "")
        while t.count % 4 != 0 { t += "=" }
        return Data(base64Encoded: t)
    }

    // MARK: X25519

    public struct X25519KeyPair: @unchecked Sendable {
        public let publicKey: Data
        public let privateKey: Curve25519.KeyAgreement.PrivateKey

        public init(privateKey: Curve25519.KeyAgreement.PrivateKey) {
            self.privateKey = privateKey
            self.publicKey = privateKey.publicKey.rawRepresentation
        }

        public init(privateRaw: Data) throws {
            self.init(privateKey: try Curve25519.KeyAgreement.PrivateKey(rawRepresentation: privateRaw))
        }

        public static func generate() -> X25519KeyPair {
            X25519KeyPair(privateKey: Curve25519.KeyAgreement.PrivateKey())
        }
    }

    public static func x25519(_ priv: Curve25519.KeyAgreement.PrivateKey, peer: Data) throws -> Data {
        guard peer.count == 32 else { throw RelayError("x25519 public key must be 32 bytes") }
        let shared: Data
        do {
            let pub = try Curve25519.KeyAgreement.PublicKey(rawRepresentation: peer)
            let secret = try priv.sharedSecretFromKeyAgreement(with: pub)
            shared = secret.withUnsafeBytes { Data($0) }
        } catch {
            throw RelayError.keyAgreementFailed
        }
        // An all-zero secret is a small-subgroup / invalid peer key; the host rejects it too.
        if shared.allSatisfy({ $0 == 0 }) { throw RelayError.keyAgreementFailed }
        return shared
    }

    // MARK: HChaCha20 / XChaCha20-Poly1305

    private static let chachaConstant: [UInt32] = [0x6170_7865, 0x3320_646e, 0x7962_2d32, 0x6b20_6574]

    private static func rotl(_ x: UInt32, _ n: UInt32) -> UInt32 { (x << n) | (x >> (32 - n)) }

    private static func le32(_ d: Data, _ offset: Int) -> UInt32 {
        let b = d.startIndex + offset
        return UInt32(d[b]) | UInt32(d[b + 1]) << 8 | UInt32(d[b + 2]) << 16 | UInt32(d[b + 3]) << 24
    }

    public static func hchacha20(key: Data, nonce16: Data) -> Data {
        precondition(key.count == 32 && nonce16.count == 16)
        var s = [UInt32](repeating: 0, count: 16)
        for i in 0..<4 { s[i] = chachaConstant[i] }
        for i in 0..<8 { s[4 + i] = le32(key, i * 4) }
        for i in 0..<4 { s[12 + i] = le32(nonce16, i * 4) }
        func qr(_ a: Int, _ b: Int, _ c: Int, _ d: Int) {
            s[a] = s[a] &+ s[b]; s[d] = rotl(s[d] ^ s[a], 16)
            s[c] = s[c] &+ s[d]; s[b] = rotl(s[b] ^ s[c], 12)
            s[a] = s[a] &+ s[b]; s[d] = rotl(s[d] ^ s[a], 8)
            s[c] = s[c] &+ s[d]; s[b] = rotl(s[b] ^ s[c], 7)
        }
        for _ in 0..<10 {
            qr(0, 4, 8, 12); qr(1, 5, 9, 13); qr(2, 6, 10, 14); qr(3, 7, 11, 15)
            qr(0, 5, 10, 15); qr(1, 6, 11, 12); qr(2, 7, 8, 13); qr(3, 4, 9, 14)
        }
        var out = Data()
        for w in [s[0], s[1], s[2], s[3], s[12], s[13], s[14], s[15]] {
            out.append(contentsOf: [UInt8(w & 0xff), UInt8((w >> 8) & 0xff), UInt8((w >> 16) & 0xff), UInt8(w >> 24)])
        }
        return out
    }

    /// 24-byte record nonce: [dir][15 zero bytes][u64be counter] (spec `lsr`).
    public static func recordNonce(direction: UInt8, counter: UInt64) -> Data {
        var n = Data(repeating: 0, count: 24)
        n[0] = direction
        for i in 0..<8 { n[16 + i] = UInt8((counter >> UInt64(8 * (7 - i))) & 0xff) }
        return n
    }

    /// Returns ciphertext ‖ 16-byte tag.
    public static func xchachaSeal(key: Data, nonce24: Data, aad: Data, plaintext: Data) throws -> Data {
        precondition(nonce24.count == 24)
        let subkey = hchacha20(key: key, nonce16: nonce24.prefix(16))
        let iv = Data(repeating: 0, count: 4) + nonce24.suffix(8)
        let box = try ChaChaPoly.seal(
            plaintext, using: SymmetricKey(data: subkey), nonce: ChaChaPoly.Nonce(data: iv), authenticating: aad)
        // Copy: `+` on CryptoKit's Data can keep a non-zero startIndex, which traps callers that index from 0.
        return Data(box.ciphertext + box.tag)
    }

    public static func xchachaOpen(key: Data, nonce24: Data, aad: Data, box: Data) throws -> Data {
        guard box.count >= 16, nonce24.count == 24 else { throw RelayError.decryptFailed }
        let subkey = hchacha20(key: key, nonce16: nonce24.prefix(16))
        let iv = Data(repeating: 0, count: 4) + nonce24.suffix(8)
        do {
            let ct = Data(box.prefix(box.count - 16))
            let tag = Data(box.suffix(16))
            let sealed = try ChaChaPoly.SealedBox(nonce: ChaChaPoly.Nonce(data: iv), ciphertext: ct, tag: tag)
            return try ChaChaPoly.open(sealed, using: SymmetricKey(data: subkey), authenticating: aad)
        } catch {
            throw RelayError.decryptFailed
        }
    }

    // MARK: transcript and keys

    private static func u32be(_ n: Int) -> Data {
        Data([UInt8((n >> 24) & 0xff), UInt8((n >> 16) & 0xff), UInt8((n >> 8) & 0xff), UInt8(n & 0xff)])
    }

    /// Transcript hash (spec `mMa`): SHA256 over Σ u32be(len(x)) ‖ x.
    public static func transcriptHash(
        hostId: String,
        clientEphemeralPublicKey: Data,
        clientNonce: Data,
        hostStaticPublicKey: Data,
        hostEphemeralPublicKey: Data,
        hostNonce: Data
    ) -> Data {
        let parts: [Data] = [
            Data(transcriptLabel.utf8),
            u32be(protocolVersion),
            Data(hostId.utf8),
            clientEphemeralPublicKey,
            clientNonce,
            hostStaticPublicKey,
            hostEphemeralPublicKey,
            hostNonce,
        ]
        var h = SHA256()
        for p in parts {
            h.update(data: u32be(p.count))
            h.update(data: p)
        }
        return Data(h.finalize())
    }

    /// hostId = base64url(SHA256(hostStaticPub))[:22].
    public static func hostId(fromStaticKey key: Data) -> String {
        String(b64urlEncode(Data(SHA256.hash(data: key))).prefix(22))
    }

    public struct SessionKeys: Sendable, Equatable {
        public let transcriptHash: Data
        public let clientToHostKey: Data
        public let hostToClientKey: Data
    }

    /// HKDF over the two DH results (static then ephemeral), 64 bytes split in half.
    public static func deriveKeys(
        dhStatic: Data, dhEphemeral: Data, clientNonce: Data, hostNonce: Data, transcriptHash: Data
    ) -> SessionKeys {
        let ikm = dhStatic + dhEphemeral
        var saltInput = SHA256()
        saltInput.update(data: Data(saltLabel.utf8))
        saltInput.update(data: clientNonce)
        saltInput.update(data: hostNonce)
        let salt = Data(saltInput.finalize())
        let info = Data(keysLabel.utf8) + transcriptHash
        let okm = HKDF<SHA256>.deriveKey(
            inputKeyMaterial: SymmetricKey(data: ikm), salt: salt, info: info, outputByteCount: 64
        ).withUnsafeBytes { Data($0) }
        return SessionKeys(
            transcriptHash: transcriptHash,
            clientToHostKey: okm.prefix(32),
            hostToClientKey: okm.suffix(32)
        )
    }
}
