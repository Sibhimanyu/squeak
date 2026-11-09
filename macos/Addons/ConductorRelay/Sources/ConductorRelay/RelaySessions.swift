import Foundation

/// One encrypted-session record `{t:"e",n,c}`.
public struct RelayEncryptedFrame: Equatable, Sendable {
    public let n: UInt64
    public let c: String
    public var json: RelayJSON { .obj(["t": "e", "n": .int(Int64(n)), "c": .string(c)]) }
}

/// The phone side of the session (`PhoneSession` in crypto.ts). Not thread-safe;
/// `PhoneClient` serializes access.
public final class RelayPhoneSession {
    private let clientEphemeral: RelayCrypto.X25519KeyPair
    private let clientNonce: Data
    private var keys: RelayCrypto.SessionKeys?
    private var sendCounter: UInt64 = 0
    private var recvCounter: UInt64 = 0

    /// Fixed ephemeral key / nonce are for deterministic cross-language vectors.
    public init(ephemeral: RelayCrypto.X25519KeyPair = .generate(), clientNonce: Data? = nil) {
        self.clientEphemeral = ephemeral
        self.clientNonce = clientNonce ?? Data((0..<32).map { _ in UInt8.random(in: 0...255) })
    }

    public var established: Bool { keys != nil }

    public func hello() -> RelayJSON {
        .obj([
            "t": "hello",
            "v": .int(Int64(RelayCrypto.protocolVersion)),
            "clientEphemeralPublicKey": .string(RelayCrypto.b64urlEncode(clientEphemeral.publicKey)),
            "clientNonce": .string(RelayCrypto.b64urlEncode(clientNonce)),
        ])
    }

    /// Process the host's `ready`; `expectedHostStaticKey` authenticates the Mac.
    public func acceptReady(_ ready: RelayJSON, expectedHostStaticKey: Data) throws {
        let t = ready["t"]?.stringValue ?? ""
        guard t == "ready" else { throw RelayError.unexpectedFrame(t) }
        guard ready["v"]?.intValue == RelayCrypto.protocolVersion else { throw RelayError.unsupportedVersion }
        guard let hostStatic = ready["hostStaticPublicKey"]?.stringValue.flatMap(RelayCrypto.b64urlDecode),
            let hostEphemeral = ready["hostEphemeralPublicKey"]?.stringValue.flatMap(RelayCrypto.b64urlDecode),
            let hostNonce = ready["hostNonce"]?.stringValue.flatMap(RelayCrypto.b64urlDecode)
        else { throw RelayError.invalidHandshake("malformed ready") }
        guard hostStatic == expectedHostStaticKey else {
            throw RelayError.invalidHandshake("host static key does not match pairing link")
        }
        let th = RelayCrypto.transcriptHash(
            hostId: RelayCrypto.hostId(fromStaticKey: hostStatic),
            clientEphemeralPublicKey: clientEphemeral.publicKey,
            clientNonce: clientNonce,
            hostStaticPublicKey: hostStatic,
            hostEphemeralPublicKey: hostEphemeral,
            hostNonce: hostNonce)
        // Phone mirror of the host's two DHs: static then ephemeral (spec §3.5).
        let a = try RelayCrypto.x25519(clientEphemeral.privateKey, peer: hostStatic)
        let c = try RelayCrypto.x25519(clientEphemeral.privateKey, peer: hostEphemeral)
        keys = RelayCrypto.deriveKeys(
            dhStatic: a, dhEphemeral: c, clientNonce: clientNonce, hostNonce: hostNonce, transcriptHash: th)
    }

    public func encrypt(_ message: RelayJSON) throws -> RelayEncryptedFrame {
        guard let keys else { throw RelayError.notOpen }
        let box = try RelayCrypto.xchachaSeal(
            key: keys.clientToHostKey,
            nonce24: RelayCrypto.recordNonce(direction: RelayCrypto.dirClientToHost, counter: sendCounter),
            aad: keys.transcriptHash,
            plaintext: Data(message.serialized().utf8))
        let frame = RelayEncryptedFrame(n: sendCounter, c: RelayCrypto.b64urlEncode(box))
        sendCounter += 1
        return frame
    }

    public func decrypt(_ frame: RelayJSON) throws -> RelayJSON {
        guard let keys else { throw RelayError.notOpen }
        let t = frame["t"]?.stringValue ?? ""
        guard t == "e" else { throw RelayError.unexpectedFrame(t) }
        guard let n = frame["n"]?.intValue, UInt64(exactly: n) == recvCounter else { throw RelayError.counterMismatch }
        guard let c = frame["c"]?.stringValue.flatMap(RelayCrypto.b64urlDecode) else { throw RelayError.decryptFailed }
        let plain = try RelayCrypto.xchachaOpen(
            key: keys.hostToClientKey,
            nonce24: RelayCrypto.recordNonce(direction: RelayCrypto.dirHostToClient, counter: recvCounter),
            aad: keys.transcriptHash,
            box: c)
        recvCounter += 1
        guard let json = RelayJSON.parse(plain) else { throw RelayError.decryptFailed }
        return json
    }
}

/// The host side of the same session, built from the spec (§3.3-3.5). The relay
/// only ever plays the phone; this exists so tests (and the cross-language
/// vectors) exercise the other half of the real algorithm.
public final class RelayHostSession {
    public let staticKey: RelayCrypto.X25519KeyPair
    private let ephemeral: RelayCrypto.X25519KeyPair
    private let hostNonce: Data
    private var keys: RelayCrypto.SessionKeys?
    private var sendCounter: UInt64 = 0
    private var recvCounter: UInt64 = 0

    public init(
        staticKey: RelayCrypto.X25519KeyPair = .generate(),
        ephemeral: RelayCrypto.X25519KeyPair = .generate(),
        hostNonce: Data? = nil
    ) {
        self.staticKey = staticKey
        self.ephemeral = ephemeral
        self.hostNonce = hostNonce ?? Data((0..<32).map { _ in UInt8.random(in: 0...255) })
    }

    public var sessionKeys: RelayCrypto.SessionKeys? { keys }

    public func ready(hello: RelayJSON) throws -> RelayJSON {
        guard let clientEph = hello["clientEphemeralPublicKey"]?.stringValue.flatMap(RelayCrypto.b64urlDecode),
            let clientNonce = hello["clientNonce"]?.stringValue.flatMap(RelayCrypto.b64urlDecode)
        else { throw RelayError.invalidHandshake("malformed hello") }
        let th = RelayCrypto.transcriptHash(
            hostId: RelayCrypto.hostId(fromStaticKey: staticKey.publicKey),
            clientEphemeralPublicKey: clientEph,
            clientNonce: clientNonce,
            hostStaticPublicKey: staticKey.publicKey,
            hostEphemeralPublicKey: ephemeral.publicKey,
            hostNonce: hostNonce)
        let a = try RelayCrypto.x25519(staticKey.privateKey, peer: clientEph)
        let c = try RelayCrypto.x25519(ephemeral.privateKey, peer: clientEph)
        keys = RelayCrypto.deriveKeys(
            dhStatic: a, dhEphemeral: c, clientNonce: clientNonce, hostNonce: hostNonce, transcriptHash: th)
        return .obj([
            "t": "ready",
            "v": .int(Int64(RelayCrypto.protocolVersion)),
            "hostStaticPublicKey": .string(RelayCrypto.b64urlEncode(staticKey.publicKey)),
            "hostEphemeralPublicKey": .string(RelayCrypto.b64urlEncode(ephemeral.publicKey)),
            "hostNonce": .string(RelayCrypto.b64urlEncode(hostNonce)),
        ])
    }

    public func decrypt(_ frame: RelayJSON) throws -> RelayJSON {
        guard let keys else { throw RelayError.notOpen }
        guard let n = frame["n"]?.intValue, UInt64(exactly: n) == recvCounter else { throw RelayError.counterMismatch }
        guard let c = frame["c"]?.stringValue.flatMap(RelayCrypto.b64urlDecode) else { throw RelayError.decryptFailed }
        let plain = try RelayCrypto.xchachaOpen(
            key: keys.clientToHostKey,
            nonce24: RelayCrypto.recordNonce(direction: RelayCrypto.dirClientToHost, counter: recvCounter),
            aad: keys.transcriptHash,
            box: c)
        recvCounter += 1
        guard let json = RelayJSON.parse(plain) else { throw RelayError.decryptFailed }
        return json
    }

    public func encrypt(_ message: RelayJSON) throws -> RelayEncryptedFrame {
        guard let keys else { throw RelayError.notOpen }
        let box = try RelayCrypto.xchachaSeal(
            key: keys.hostToClientKey,
            nonce24: RelayCrypto.recordNonce(direction: RelayCrypto.dirHostToClient, counter: sendCounter),
            aad: keys.transcriptHash,
            plaintext: Data(message.serialized().utf8))
        let frame = RelayEncryptedFrame(n: sendCounter, c: RelayCrypto.b64urlEncode(box))
        sendCounter += 1
        return frame
    }
}
