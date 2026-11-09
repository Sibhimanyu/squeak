import Foundation

/// Swift port of `pairing.ts`: parses the `CONDUCTOR://P/<base32>` link
/// Conductor shows when adding a phone (spec §1.3).
public struct RelayPairingInfo: Equatable, Sendable {
    public let version: Int
    public let hostStaticPublicKey: Data
    public let pairingToken: Data
    public let pairingTokenExpiresAt: Date
    public let hostName: String
    public let relayUrl: String
    public let hostId: String
}

public enum RelayPairing {
    public static let prefix = "CONDUCTOR://P/"
    private static let alphabet = Array("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567")
    private static let knownRelays: [UInt8: String] = [
        1: "https://api.conductor.build",
        2: "https://stage-api.conductor.build",
    ]

    static func base32Decode(_ s: String) throws -> [UInt8] {
        var clean = s.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        while clean.hasSuffix("=") { clean.removeLast() }
        var bits = 0
        var value: UInt32 = 0
        var out: [UInt8] = []
        for ch in clean {
            guard let idx = alphabet.firstIndex(of: ch) else { throw RelayError("invalid base32 character: \(ch)") }
            value = (value << 5) | UInt32(idx)
            bits += 5
            if bits >= 8 {
                bits -= 8
                out.append(UInt8((value >> UInt32(bits)) & 0xff))
            }
        }
        return out
    }

    public static func parse(_ link: String) throws -> RelayPairingInfo {
        let trimmed = link.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.uppercased().hasPrefix(prefix.uppercased()) else {
            throw RelayError("not a CONDUCTOR://P/ pairing link")
        }
        let bytes = try base32Decode(String(trimmed.dropFirst(prefix.count)))
        var off = 0
        func need(_ n: Int) throws {
            if off + n > bytes.count { throw RelayError("pairing link truncated") }
        }
        try need(1)
        let version = Int(bytes[off]); off += 1
        try need(32)
        let hostKey = Data(bytes[off..<off + 32]); off += 32
        try need(16)
        let token = Data(bytes[off..<off + 16]); off += 16
        try need(4)
        let expiry = bytes[off..<off + 4].reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }; off += 4
        try need(1)
        let nameLen = Int(bytes[off]); off += 1
        try need(nameLen)
        let hostName = String(decoding: bytes[off..<off + nameLen], as: UTF8.self); off += nameLen
        try need(1)
        let tag = bytes[off]; off += 1
        let relayUrl: String
        if tag == 0 {
            try need(1)
            let len = Int(bytes[off]); off += 1
            try need(len)
            relayUrl = String(decoding: bytes[off..<off + len], as: UTF8.self); off += len
        } else {
            guard let known = knownRelays[tag] else { throw RelayError("unknown relay id \(tag)") }
            relayUrl = known
        }
        return RelayPairingInfo(
            version: version,
            hostStaticPublicKey: hostKey,
            pairingToken: token,
            pairingTokenExpiresAt: Date(timeIntervalSince1970: TimeInterval(expiry)),
            hostName: hostName,
            relayUrl: relayUrl,
            hostId: RelayCrypto.hostId(fromStaticKey: hostKey))
    }
}
