import Foundation

public struct DeviceCredentials: Codable, Equatable, Sendable {
    public let deviceId: String
    public let deviceToken: String
    public init(deviceId: String, deviceToken: String) {
        self.deviceId = deviceId
        self.deviceToken = deviceToken
    }
}

public struct TunnelResponse: Equatable, Sendable {
    public let status: Int
    public let headers: [String: String]
    public let body: String
}

/// Carries one session frame (the relay `data` payload) and can drop the link.
public protocol PhoneTransport: Sendable {
    func send(frame: RelayJSON)
    func close(reason: String)
}

/// JavaScript's `encodeURIComponent`.
func encodeURIComponent(_ s: String) -> String {
    var allowed = CharacterSet.alphanumerics
    allowed.insert(charactersIn: "-_.!~*'()")
    // `alphanumerics` includes non-ASCII letters; JS escapes those.
    var out = ""
    for u in s.unicodeScalars {
        if u.isASCII, allowed.contains(u) {
            out.unicodeScalars.append(u)
        } else {
            for b in String(u).utf8 { out += String(format: "%%%02X", b) }
        }
    }
    return out
}

/// Swift port of `phone.ts`: pair/auth, then HTTP-like requests tunnelled
/// through the encrypted session. Thread-safe; incoming frames are processed
/// synchronously under a lock so ordering is preserved.
public final class PhoneClient: @unchecked Sendable {
    private enum AuthResult {
        case paired(DeviceCredentials)
        case ok
    }

    private final class Pending {
        let continuation: CheckedContinuation<TunnelResponse, Error>
        var status: Int?
        var headers: [String: String]?
        var chunks: [String] = []
        var timeout: Task<Void, Never>?
        init(_ c: CheckedContinuation<TunnelResponse, Error>) { continuation = c }
    }

    private let transport: PhoneTransport
    private let expectedHostStaticKey: Data?
    private let requestTimeout: TimeInterval
    private let idGenerator: @Sendable () -> String

    private let lock = NSLock()
    private let session: RelayPhoneSession
    private var handshakeWaiter: CheckedContinuation<Void, Error>?
    private var authWaiter: CheckedContinuation<AuthResult, Error>?
    private var pending: [String: Pending] = [:]
    private var closed = false
    private var observedKey: Data?

    /// `expectedHostStaticKey` pins the Mac. On loopback it may be nil to trust
    /// the key presented on first connect; read it back via `hostStaticKey`.
    public init(
        transport: PhoneTransport,
        expectedHostStaticKey: Data? = nil,
        session: RelayPhoneSession = RelayPhoneSession(),
        requestTimeout: TimeInterval = 30,
        idGenerator: @escaping @Sendable () -> String = { UUID().uuidString.lowercased() }
    ) {
        self.transport = transport
        self.expectedHostStaticKey = expectedHostStaticKey
        self.session = session
        self.requestTimeout = requestTimeout
        self.idGenerator = idGenerator
    }

    public var hostStaticKey: Data? {
        lock.lock(); defer { lock.unlock() }
        return observedKey
    }

    // MARK: handshake / auth

    public func handshake() async throws {
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<Void, Error>) in
            lock.lock()
            handshakeWaiter = c
            transport.send(frame: session.hello())
            lock.unlock()
        }
    }

    public func pair(pairingToken: String, deviceName: String) async throws -> DeviceCredentials {
        let r = try await authExchange(
            .obj(["type": "pair", "pairingToken": .string(pairingToken), "deviceName": .string(deviceName)]))
        guard case .paired(let creds) = r else { throw RelayError("expected paired credentials") }
        return creds
    }

    public func authenticate(_ creds: DeviceCredentials) async throws {
        _ = try await authExchange(
            .obj([
                "type": "auth", "deviceId": .string(creds.deviceId), "deviceToken": .string(creds.deviceToken),
            ]))
    }

    private func authExchange(_ message: RelayJSON) async throws -> AuthResult {
        try await withCheckedThrowingContinuation { (c: CheckedContinuation<AuthResult, Error>) in
            lock.lock()
            authWaiter = c
            do {
                try sendAppLocked(message)
                lock.unlock()
            } catch {
                authWaiter = nil
                lock.unlock()
                c.resume(throwing: error)
            }
        }
    }

    // MARK: requests

    public func request(
        method: String, target: String, headers: [String: String] = [:], body: RelayJSON? = nil,
        rawBody: String? = nil
    ) async throws -> TunnelResponse {
        let id = idGenerator()
        return try await withCheckedThrowingContinuation { (c: CheckedContinuation<TunnelResponse, Error>) in
            let p = Pending(c)
            var members: [RelayJSON.Member] = [
                .init("type", "request"), .init("id", .string(id)), .init("method", .string(method)),
                .init("target", .string(target)),
                .init("headers", .object(headers.keys.sorted().map { .init($0, .string(headers[$0]!)) })),
            ]
            if let rawBody {
                members.append(.init("body", .obj(["encoding": "utf8", "data": .string(rawBody)])))
            } else if let body {
                members.append(.init("body", .obj(["encoding": "utf8", "data": .string(body.serialized())])))
            }
            lock.lock()
            if closed {
                lock.unlock()
                c.resume(throwing: RelayError("phone client closed"))
                return
            }
            pending[id] = p
            p.timeout = Task { [weak self, requestTimeout] in
                try? await Task.sleep(nanoseconds: UInt64(requestTimeout * 1_000_000_000))
                if Task.isCancelled { return }
                self?.timeOut(id: id, method: method, target: target)
            }
            do {
                try sendAppLocked(.object(members))
                lock.unlock()
            } catch {
                pending[id] = nil
                lock.unlock()
                p.timeout?.cancel()
                c.resume(throwing: error)
            }
        }
    }

    private func timeOut(id: String, method: String, target: String) {
        lock.lock()
        let p = pending.removeValue(forKey: id)
        lock.unlock()
        p?.continuation.resume(throwing: RelayError("request \(method) \(target) timed out"))
    }

    public func requestJSON(method: String, target: String, headers: [String: String] = [:], body: RelayJSON? = nil)
        async throws -> (status: Int, body: RelayJSON?)
    {
        let r = try await request(method: method, target: target, headers: headers, body: body)
        return (r.status, r.body.isEmpty ? nil : RelayJSON.parse(r.body))
    }

    private func sendAppLocked(_ message: RelayJSON) throws {
        if closed { throw RelayError("phone client closed") }
        let frame = try session.encrypt(message)
        transport.send(frame: frame.json)
    }

    // MARK: incoming

    /// Feed one incoming session frame (the relay `data` payload, JSON text).
    public func handleData(_ text: String) {
        guard let frame = RelayJSON.parse(text) else { return }
        handleData(frame)
    }

    public func handleData(_ frame: RelayJSON) {
        var resumes: [() -> Void] = []
        var closeReason: String?
        lock.lock()
        if closed {
            lock.unlock()
            return
        }
        do {
            if !session.established {
                let key: Data
                if let expectedHostStaticKey {
                    key = expectedHostStaticKey
                } else if let presented = frame["hostStaticPublicKey"]?.stringValue.flatMap(RelayCrypto.b64urlDecode) {
                    key = presented
                } else {
                    throw RelayError.invalidHandshake("malformed ready")
                }
                try session.acceptReady(frame, expectedHostStaticKey: key)
                observedKey = key
                if let w = handshakeWaiter {
                    handshakeWaiter = nil
                    resumes.append { w.resume() }
                }
            } else {
                let message = try session.decrypt(frame)
                dispatchLocked(message, &resumes)
            }
        } catch {
            resumes += failAllLocked(error)
            closeReason = "protocol error"
        }
        lock.unlock()
        for r in resumes { r() }
        if let closeReason { transport.close(reason: closeReason) }
    }

    private func dispatchLocked(_ m: RelayJSON, _ resumes: inout [() -> Void]) {
        switch m["type"]?.stringValue {
        case "paired":
            if let w = authWaiter {
                authWaiter = nil
                let creds = DeviceCredentials(
                    deviceId: m["deviceId"]?.stringValue ?? "", deviceToken: m["deviceToken"]?.stringValue ?? "")
                resumes.append { w.resume(returning: .paired(creds)) }
            }
        case "authOk":
            if let w = authWaiter {
                authWaiter = nil
                resumes.append { w.resume(returning: .ok) }
            }
        case "authError":
            if let w = authWaiter {
                authWaiter = nil
                let reason = m["reason"]?.stringValue ?? "undefined"
                resumes.append { w.resume(throwing: RelayError("authError: \(reason)")) }
            }
        case "responseHead":
            guard let id = m["id"]?.stringValue, let p = pending[id] else { return }
            p.status = m["status"]?.intValue
            var headers: [String: String] = [:]
            if case .object(let members) = m["headers"] ?? .null {
                for h in members { if let v = h.value.stringValue { headers[h.key] = v } }
            }
            p.headers = headers
        case "responseBody":
            guard let id = m["id"]?.stringValue, let p = pending[id] else { return }
            if let data = m["body"]?["data"]?.stringValue, !data.isEmpty { p.chunks.append(data) }
            if m["final"]?.boolValue == true {
                p.timeout?.cancel()
                pending[id] = nil
                let response = TunnelResponse(status: p.status ?? 0, headers: p.headers ?? [:], body: p.chunks.joined())
                resumes.append { p.continuation.resume(returning: response) }
            }
        case "pong":
            break
        case "revoked":
            resumes += failAllLocked(RelayError("device revoked by the Mac"))
            transport.close(reason: "revoked")
        default:
            break  // wsOpened / wsMessage / wsClose: not used by the send path
        }
    }

    private func failAllLocked(_ error: Error) -> [() -> Void] {
        var out: [() -> Void] = []
        if let w = handshakeWaiter { handshakeWaiter = nil; out.append { w.resume(throwing: error) } }
        if let w = authWaiter { authWaiter = nil; out.append { w.resume(throwing: error) } }
        for (_, p) in pending {
            p.timeout?.cancel()
            out.append { p.continuation.resume(throwing: error) }
        }
        pending.removeAll()
        return out
    }

    public func handleClose() {
        lock.lock()
        closed = true
        let resumes = failAllLocked(RelayError("relay connection closed"))
        lock.unlock()
        for r in resumes { r() }
    }

    // MARK: send a chat message (spec §5.4)

    public func sendChatMessage(
        workspaceLocalId: String, sessionId: String, text: String, mode: String = "queue", model: String? = nil
    ) async throws -> TunnelResponse {
        let base =
            "/workspaces/\(encodeURIComponent(workspaceLocalId))/sessions/\(encodeURIComponent(sessionId))/pending-messages"
        let post: (Int) async throws -> TunnelResponse = { generation in
            try await self.request(
                method: "POST", target: "\(base)/send", headers: ["content-type": "application/json"],
                body: .obj([
                    "messageId": .string(self.idGenerator()),
                    "deliveryPayload": .obj(["message": .string(text)]),
                    "config": model.map { .obj(["model": .string($0)]) } ?? .object([]),
                    "mode": .string(mode),
                    "expectedGeneration": .int(Int64(generation)),
                ]))
        }
        let queue = try await requestJSON(method: "GET", target: base)
        var res = try await post(queue.body?["generation"]?.intValue ?? 0)
        if res.status == 409 {
            let state = RelayJSON.parse(res.body)
            res = try await post(state?["state"]?["generation"]?.intValue ?? 0)
        }
        return res
    }
}
