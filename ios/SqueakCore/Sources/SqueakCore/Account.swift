import CryptoKit
import Foundation

/* A Squeak account (docs/remote-channel.md, "Web accounts"; the browser's twin is web/js/account.js). Signing in only says
   who you are and lists your Macs: it never opens one. To add a Mac without a QR code the phone asks it, both screens show
   the same six-digit code, the Mac's owner approves, and the Mac answers with the pairing a QR code would have carried,
   sealed to a key made for this one request. */

/// Where the account lives and how its sign-in link is made and read.
public enum AccountEndpoints {
    /// The app on Catalyst the sign-in page and relay are served from, used until a Catalyst pairing names its own.
    public static let defaultAppURL = "https://squeak-60083782173.development.catalystserverless.in"

    /// `https://<app>` from a pairing's relay base (`https://<app>/server/squeak_relay`), or the default.
    public static func appURL(fromRelay relay: String?) -> String {
        guard let relay, Channel.isRelayURL(relay),
              let url = URL(string: relay), url.scheme == "https", let host = url.host?.lowercased(),
              Channel.isRelayURL("https://\(host)") else { return defaultAppURL }
        return "https://\(host)"
    }

    public static func relayBase(appURL: String) -> String { appURL + "/server/squeak_relay" }

    public static func signInURL(appURL: String, state: String) -> URL? {
        URL(string: "\(appURL)/app/index.html#app-signin=\(state)")
    }

    /// 32 random bytes, base64url, kept in memory for one sign-in.
    public static func newState() -> String {
        Data((0..<32).map { _ in UInt8.random(in: 0...255) }).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }

    public enum SignInFailure: Error, Equatable { case notOurs, wrongState, noToken }

    /// `squeak://signed-in?token=…&state=…&email=…&name=…`: the host and the state are checked exactly.
    public static func parseSignedIn(_ url: URL, state: String) throws -> AccountSession {
        guard url.scheme?.lowercased() == "squeak", url.host == "signed-in",
              let items = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems else { throw SignInFailure.notOurs }
        func value(_ name: String) -> String? { items.first { $0.name == name }?.value }
        guard !state.isEmpty, value("state") == state else { throw SignInFailure.wrongState }
        guard let token = value("token"), !token.isEmpty else { throw SignInFailure.noToken }
        let expires = value("expiresAt").flatMap(Double.init).map { $0 < 1e12 ? $0 : $0 / 1000 }
        return AccountSession(token: token, expiresAt: expires.map { Date(timeIntervalSince1970: $0) },
                              email: value("email") ?? "", name: value("name") ?? "")
    }
}

/// Who is signed in. The token is an account token (30-day life); it goes to the Keychain only.
public struct AccountSession: Codable, Equatable, Sendable {
    public let token: String
    public let expiresAt: Date?
    public let email: String
    public let name: String
    public init(token: String, expiresAt: Date? = nil, email: String, name: String) {
        self.token = token; self.expiresAt = expiresAt; self.email = email; self.name = name
    }
}

/// The saved sign-in, over whatever holds secrets (the Keychain on a phone). An expired one is forgotten on read.
public struct AccountTokenStore: Sendable {
    let load: @Sendable () -> Data?
    let save: @Sendable (Data) -> Void
    let delete: @Sendable () -> Void
    public init(load: @escaping @Sendable () -> Data?, save: @escaping @Sendable (Data) -> Void, delete: @escaping @Sendable () -> Void) {
        self.load = load; self.save = save; self.delete = delete
    }

    public func current(now: Date = Date()) -> AccountSession? {
        guard let data = load(), let session = try? JSONDecoder().decode(AccountSession.self, from: data) else { return nil }
        if let end = session.expiresAt, end <= now { delete(); return nil }
        return session
    }

    public func store(_ session: AccountSession) {
        if let data = try? JSONEncoder().encode(session) { save(data) }
    }

    public func signOut() { delete() }
}

/// A Mac linked to the account.
public struct AccountMac: Equatable, Sendable, Identifiable {
    public let macId: String
    public let name: String
    public var id: String { macId }
    public init(macId: String, name: String) { self.macId = macId; self.name = name }
}

public enum AccountError: Error, Equatable, Sendable {
    /// 401: the sign-in ran out; the caller drops it.
    case signedOut
    /// 403 `mac`: that Mac is no longer linked.
    case macGone
    /// 429 `busy`.
    case busy
    /// 410.
    case gone
    case network
    case server(Int)

    /// Plain sentences for the screen (the web's `SENTENCES`).
    public var sentence: String {
        switch self {
        case .signedOut: return "Your sign-in ran out. Sign in again."
        case .macGone: return "That Mac is no longer linked to your account."
        case .busy: return "That Mac already has a request waiting. Try again in a minute."
        case .gone: return "That request ran out. Ask again."
        case .network, .server: return "Could not reach Squeak's server. Check your connection and try again."
        }
    }

    public static func deniedSentence(_ mac: String) -> String { "\(mac.isEmpty ? "Your Mac" : mac) said no." }
    public static let expiredSentence = "Your Mac did not answer in time. Ask again."
    public static let unreadableSentence = "Your Mac's answer could not be read. Ask again."
}

/// One HTTP exchange, injectable so the account calls test against a fake.
public protocol AccountHTTP: Sendable {
    func send(_ request: URLRequest) async throws -> (status: Int, body: Data)
}

public struct URLSessionAccountHTTP: AccountHTTP {
    let session: URLSession
    public init(session: URLSession = .shared) { self.session = session }
    public func send(_ request: URLRequest) async throws -> (status: Int, body: Data) {
        var request = request
        request.timeoutInterval = 10
        let (data, response) = try await session.data(for: request)
        return ((response as? HTTPURLResponse)?.statusCode ?? 0, data)
    }
}

public enum DeviceAnswer: Equatable, Sendable {
    case pending, denied, gone
    case box(String)
}

public struct AccountAPI: Sendable {
    let base: String
    let token: String
    let http: AccountHTTP

    public init(appURL: String, token: String, http: AccountHTTP = URLSessionAccountHTTP()) {
        base = AccountEndpoints.relayBase(appURL: appURL); self.token = token; self.http = http
    }

    private func call(_ path: String, method: String = "GET", body: [String: String]? = nil) async throws -> (status: Int, json: [String: Any]) {
        guard let url = URL(string: base + path) else { throw AccountError.network }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue(token, forHTTPHeaderField: "x-squeak-account")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "content-type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let answer: (status: Int, body: Data)
        do { answer = try await http.send(request) } catch { throw AccountError.network }
        if answer.status == 401 { throw AccountError.signedOut }
        let json = (try? JSONSerialization.jsonObject(with: answer.body)) as? [String: Any] ?? [:]
        return (answer.status, json)
    }

    public func macs() async throws -> [AccountMac] {
        let (status, json) = try await call("/account/macs")
        guard (200..<300).contains(status) else { throw AccountError.server(status) }
        return (json["macs"] as? [[String: Any]] ?? []).compactMap { entry in
            guard let id = entry["macId"] as? String, !id.isEmpty else { return nil }
            let name = entry["name"] as? String
            return AccountMac(macId: id, name: name?.isEmpty == false ? name! : "Your Mac")
        }
    }

    /// `(reqId, expiresAt)`; the relay may count the expiry in seconds or milliseconds.
    public func deviceRequest(macId: String, name: String, publicKey: String, boxKey: String) async throws -> (reqId: String, expiresAt: Date?) {
        let (status, json) = try await call("/account/device-request", method: "POST",
                                            body: ["macId": macId, "name": name, "publicKey": publicKey, "boxKey": boxKey])
        if status == 403 { throw AccountError.macGone }
        if status == 429 { throw AccountError.busy }
        if status == 410 { throw AccountError.gone }
        guard (200..<300).contains(status) else { throw AccountError.server(status) }
        guard let reqId = json["reqId"] as? String, !reqId.isEmpty else { throw AccountError.server(502) }
        let end = (json["expiresAt"] as? Double).flatMap { $0 > 0 ? ($0 < 1e12 ? $0 : $0 / 1000) : nil }
        return (reqId, end.map { Date(timeIntervalSince1970: $0) })
    }

    public func deviceAnswer(macId: String, reqId: String) async throws -> DeviceAnswer {
        var allowed = CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn: "&=+#")
        let m = macId.addingPercentEncoding(withAllowedCharacters: allowed) ?? macId
        let r = reqId.addingPercentEncoding(withAllowedCharacters: allowed) ?? reqId
        let (status, json) = try await call("/account/device-request?macId=\(m)&id=\(r)")
        if status == 202 { return .pending }
        if status == 410 { return .gone }
        if status == 403 { throw AccountError.macGone }
        guard (200..<300).contains(status) else { throw AccountError.server(status) }
        let result = json["result"] as? [String: Any]
        if result?["denied"] as? Bool == true { return .denied }
        if let box = result?["box"] as? String { return .box(box) }
        return .pending
    }
}

/// What a Mac seals to a member key: ephemeral ECDH, HKDF-SHA256 (salt = the 65 ephemeral bytes, info "squeak-pond-key-v1"),
/// AES-256-GCM, no additional data. Box = base64(ephemeralPublic65 ‖ nonce12 ‖ ciphertext ‖ tag16);
/// src/flotilla/crypto.ts `sealToMember`, web/js/guest-crypto.js `openFromMember`.
public enum MemberBox {
    public enum Failure: Error, Equatable { case badBox }
    static let info = Data("squeak-pond-key-v1".utf8)

    public static func open(_ box: String, with key: P256.KeyAgreement.PrivateKey) throws -> Data {
        guard let raw = Data(base64Encoded: box), raw.count >= 65 + 12 + 16 else { throw Failure.badBox }
        do {
            let eph = raw.prefix(65)
            let peer = try P256.KeyAgreement.PublicKey(x963Representation: eph)
            let shared = try key.sharedSecretFromKeyAgreement(with: peer)
            let aes = shared.hkdfDerivedSymmetricKey(using: SHA256.self, salt: eph, sharedInfo: info, outputByteCount: 32)
            let sealed = try AES.GCM.SealedBox(combined: raw.dropFirst(65))
            return try AES.GCM.open(sealed, using: aes)
        } catch {
            throw Failure.badBox
        }
    }

    /// The pairing the Mac sealed, held to the checks a scanned code gets. Only a Catalyst one (it names a relay) is taken.
    public static func pairing(_ box: String, with key: P256.KeyAgreement.PrivateKey) throws -> PairingPayload {
        let plain = try open(box, with: key)
        guard let payload = try? JSONDecoder().decode(PairingPayload.self, from: plain),
              let valid = try? payload.validated(), valid.onCatalyst else { throw Failure.badBox }
        return valid
    }
}

/// One "add this Mac" request, from the ask to the answer. The caller keeps `boxKey` private in memory only.
public struct DeviceRequest: Sendable {
    public let mac: AccountMac
    public let reqId: String
    public let expiresAt: Date?
    public let code: String
    public let deviceName: String
}

public enum DeviceOutcome: Equatable, Sendable {
    case approved(PairingPayload, deviceId: String)
    case denied, gone, expired, cancelled
    case failed(String)
}

public enum AccountPairing {
    public static let pollInterval: TimeInterval = 2

    /// Asks the Mac. The six-digit code is the one a QR pairing shows for the same device key.
    public static func request(api: AccountAPI, mac: AccountMac, deviceName: String, publicKeyX963: Data,
                               boxKey: P256.KeyAgreement.PrivateKey) async throws -> DeviceRequest {
        let made = try await api.deviceRequest(macId: mac.macId, name: deviceName, publicKey: publicKeyX963.base64EncodedString(),
                                               boxKey: boxKey.publicKey.x963Representation.base64EncodedString())
        return DeviceRequest(mac: mac, reqId: made.reqId, expiresAt: made.expiresAt,
                             code: ChannelCrypto.pairingCode(publicKeyX963: publicKeyX963), deviceName: deviceName)
    }

    /// Polls every 2 s until the Mac answers, the request runs out, or the task is cancelled. A 401 is thrown (sign-in over).
    public static func await(api: AccountAPI, request: DeviceRequest, boxKey: P256.KeyAgreement.PrivateKey,
                             interval: TimeInterval = pollInterval, now: @Sendable () -> Date = { Date() },
                             sleep: @Sendable (TimeInterval) async -> Void = { try? await Task.sleep(for: .seconds($0)) }) async throws -> DeviceOutcome {
        while !Task.isCancelled {
            if let end = request.expiresAt, now() >= end { return .expired }
            do {
                switch try await api.deviceAnswer(macId: request.mac.macId, reqId: request.reqId) {
                case .pending: break
                case .denied: return .denied
                case .gone: return .gone
                case .box(let box):
                    guard let payload = try? MemberBox.pairing(box, with: boxKey) else {
                        return .failed(AccountError.unreadableSentence)
                    }
                    return .approved(payload, deviceId: request.reqId)
                }
            } catch AccountError.signedOut {
                throw AccountError.signedOut
            } catch AccountError.macGone {
                return .failed(AccountError.macGone.sentence)
            } catch {
                // Offline for a moment: keep asking.
            }
            await sleep(interval)
        }
        return .cancelled
    }
}
