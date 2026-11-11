import Foundation

// The Squeak cloud's Mac side: one relay for everyone, reached by signing in (docs/cloud-layer.md).
// Decoding is tolerant on purpose: an older daemon sends no `hosted` block, and every field is optional.

/// The daemon's hosted-cloud block (`GET /control/cloud` `hosted`, `/state` `cloud.hosted`).
public struct HostedCloud: Decodable, Sendable, Equatable {
    public enum Phase: String, Sendable { case needsSignIn = "needs-sign-in", connecting, ready, error }
    public enum Legacy: String, Sendable { case firebase, shared, catalystOwn = "catalyst-own" }

    public var phase: Phase?
    public var email: String?
    public var error: String?
    public var legacy: Legacy?
    public var moving: Bool?

    public init(phase: Phase? = nil, email: String? = nil, error: String? = nil, legacy: Legacy? = nil, moving: Bool? = nil) {
        self.phase = phase; self.email = email; self.error = error; self.legacy = legacy; self.moving = moving
    }

    private enum Keys: String, CodingKey { case state, email, error, legacy, moving }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        phase = (try? c.decode(String.self, forKey: .state)).flatMap(Phase.init(rawValue:))
        email = (try? c.decode(String.self, forKey: .email)).flatMap { $0.isEmpty ? nil : $0 }
        error = (try? c.decode(String.self, forKey: .error)).flatMap { $0.isEmpty ? nil : $0 }
        legacy = (try? c.decode(String.self, forKey: .legacy)).flatMap(Legacy.init(rawValue:))
        moving = try? c.decode(Bool.self, forKey: .moving)
    }

    /// The status line: what the cloud is doing. Nil when the daemon did not say (an older one).
    public var statusSentence: String? {
        switch phase {
        case .needsSignIn: "Sign in to connect"
        case .connecting: "Connecting…"
        case .ready: "Connected"
        case .error: error ?? "Couldn't connect to Squeak's cloud."
        case nil: nil
        }
    }

    /// Shown only while a pre-account setup is still in use and nothing is moving it yet.
    public var legacySentence: String? {
        guard let legacy, moving != true else { return nil }
        let what: String
        switch legacy {
        case .firebase: what = "your own Firebase"
        case .shared: what = "Squeak's old shared server"
        case .catalystOwn: what = "your own Catalyst relay"
        }
        return "This Mac still uses \(what). Sign in to move it; paired devices follow."
    }

    public var isReady: Bool { phase == .ready }
    public var needsSignIn: Bool { phase == .needsSignIn }
}

public struct CloudState: Decodable, Sendable, Equatable {
    public var hosted: HostedCloud?
    public init(hosted: HostedCloud? = nil) { self.hosted = hosted }
    private enum Keys: String, CodingKey { case hosted }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        hosted = try? c.decode(HostedCloud.self, forKey: .hosted)
    }
}

/// What a write route answers.
public struct CloudAck: Sendable, Equatable {
    public var ok: Bool
    public var error: String?
    public static let olderDaemon = CloudAck(ok: false, error: "Update the Squeak service on this Mac to do that.")
    public static func failed(_ s: String) -> CloudAck { CloudAck(ok: false, error: s) }
}

extension DaemonClient {
    /// nil when the daemon has no `/control/cloud` (404): an older daemon.
    public func cloudState() async throws -> CloudState? {
        let r = try await getControl("/control/cloud")
        if r.status == 404 { return nil }
        if r.status == 401 || r.status == 403 { throw AdapterError.tokenRejected }
        guard (200..<300).contains(r.status) else { throw AdapterError.http(r.status) }
        guard let s = try? JSONDecoder().decode(CloudState.self, from: r.body) else { throw AdapterError.badResponse("unreadable CloudState") }
        return s
    }

    /// `POST /control/cloud/hosted/connect`: 202 started, 409 not signed in.
    public func connectHosted() async -> CloudAck {
        guard let t = tokenProvider() else { return .failed("Squeak's access token was not found") }
        do {
            let r = try await transportForControl.send(HTTPRequest(
                method: "POST", url: controlURL("/control/cloud/hosted/connect"),
                headers: ["x-squeak-token": t, "content-type": "application/json"], body: Data("{}".utf8), timeout: 30))
            switch r.status {
            case 200..<300: return CloudAck(ok: true, error: nil)
            case 404, 410: return .olderDaemon
            case 401, 403: return .failed("Squeak rejected the access token")
            case 409: return .failed("Sign in to Squeak first.")
            default: return .failed("That didn't work.")
            }
        } catch {
            return .failed("Squeak isn't running.")
        }
    }
}
