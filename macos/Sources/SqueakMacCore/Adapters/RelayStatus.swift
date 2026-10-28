import Foundation

/// The daemon's reading of Conductor's relay (`GET /control/relay`). The daemon computes the state and every
/// sentence; the Mac only draws them.
public enum RelayState: String, Sendable, Equatable {
    case unsupported, notInstalled = "not-installed", off, needsRestart = "needs-restart", waiting, connected, error
    /// A state this build does not know: drawn like an error, with the daemon's own message.
    case unknown
}

public struct RelayStatus: Sendable, Equatable, Decodable {
    public var state: RelayState
    public var conductorInstalled: Bool
    public var conductorVersion: String?
    public var versionTested: Bool
    public var configured: Bool
    public var paired: Bool
    public var hostConnected: Bool
    public var lastHostAt: String?
    public var port: Int
    public var message: String
    public var steps: [String]

    public init(
        state: RelayState, conductorInstalled: Bool = true, conductorVersion: String? = nil, versionTested: Bool = true,
        configured: Bool = false, paired: Bool = false, hostConnected: Bool = false, lastHostAt: String? = nil,
        port: Int = 0, message: String = "", steps: [String] = []
    ) {
        self.state = state; self.conductorInstalled = conductorInstalled; self.conductorVersion = conductorVersion
        self.versionTested = versionTested; self.configured = configured; self.paired = paired
        self.hostConnected = hostConnected; self.lastHostAt = lastHostAt; self.port = port
        self.message = message; self.steps = steps
    }

    private enum Keys: String, CodingKey {
        case state, conductorInstalled, conductorVersion, versionTested, configured, paired, hostConnected, lastHostAt, port, message, steps
    }

    /// Lenient: every field optional, an unknown state is `.unknown`, so a newer daemon never breaks the page.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        state = (try? c.decodeIfPresent(String.self, forKey: .state)).flatMap { $0 }.flatMap(RelayState.init(rawValue:)) ?? .unknown
        conductorInstalled = (try? c.decodeIfPresent(Bool.self, forKey: .conductorInstalled)) ?? false
        conductorVersion = (try? c.decodeIfPresent(String.self, forKey: .conductorVersion)) ?? nil
        versionTested = (try? c.decodeIfPresent(Bool.self, forKey: .versionTested)) ?? false
        configured = (try? c.decodeIfPresent(Bool.self, forKey: .configured)) ?? false
        paired = (try? c.decodeIfPresent(Bool.self, forKey: .paired)) ?? false
        hostConnected = (try? c.decodeIfPresent(Bool.self, forKey: .hostConnected)) ?? false
        lastHostAt = (try? c.decodeIfPresent(String.self, forKey: .lastHostAt)) ?? nil
        port = (try? c.decodeIfPresent(Int.self, forKey: .port)) ?? 0
        message = (try? c.decodeIfPresent(String.self, forKey: .message)) ?? ""
        steps = (try? c.decodeIfPresent([String].self, forKey: .steps)) ?? []
    }

    /// Whether a chat's error text is "the relay is not connected", so a surface can offer Conductor settings.
    public static func isRelayProblem(_ text: String?) -> Bool {
        guard let t = text?.lowercased() else { return false }
        return t.contains("relay") && (t.contains("isn't connected") || t.contains("isn’t connected") || t.contains("not connected"))
    }
}

/// What a setup or reset did. `status` is the daemon's reading afterwards when it could be read.
public struct RelayActionResult: Sendable, Equatable {
    public var ok: Bool
    public var status: RelayStatus?
    public var reason: String?

    public init(ok: Bool, status: RelayStatus? = nil, reason: String? = nil) {
        self.ok = ok; self.status = status; self.reason = reason
    }

    /// An older daemon (404/503) answers neither route.
    public static let updateService = RelayActionResult(ok: false, reason: RelayStatus.updateServiceSentence)
}

extension RelayStatus {
    public static let updateServiceSentence = "Update the background service"
}

private struct RelayActionBody: Decodable {
    let ok: Bool?
    let status: RelayStatus?
    let reason: String?
}

extension DaemonClient {
    /// nil when the daemon predates the route (404) or has no relay support (503).
    public func relayStatus() async throws -> RelayStatus? {
        let r = try await getControl("/control/relay")
        if r.status == 404 || r.status == 503 { return nil }
        if r.status == 401 || r.status == 403 { throw AdapterError.tokenRejected }
        guard (200..<300).contains(r.status) else { throw AdapterError.http(r.status) }
        guard let s = try? JSONDecoder().decode(RelayStatus.self, from: r.body) else { throw AdapterError.badResponse("unreadable RelayStatus") }
        return s
    }

    /// One attempt, never retried: setup edits Conductor's settings.
    public func setupRelay(force: Bool = false) async -> RelayActionResult {
        await relayAction("/control/relay/setup", body: force ? #"{"force":true}"# : "{}")
    }

    /// One attempt, never retried.
    public func resetRelay() async -> RelayActionResult {
        await relayAction("/control/relay/reset", body: "{}")
    }

    private func relayAction(_ path: String, body: String) async -> RelayActionResult {
        guard let token = tokenProvider() else { return RelayActionResult(ok: false, reason: "Squeak's access token was not found") }
        let request = HTTPRequest(
            method: "POST", url: controlURL(path), headers: ["x-squeak-token": token, "content-type": "application/json"],
            body: Data(body.utf8), timeout: 60)
        do {
            let r = try await transportForControl.send(request)
            if r.status == 404 || r.status == 503 { return .updateService }
            if r.status == 401 || r.status == 403 { return RelayActionResult(ok: false, reason: "Squeak rejected the access token") }
            let parsed = try? JSONDecoder().decode(RelayActionBody.self, from: r.body)
            if (200..<300).contains(r.status), parsed?.ok == true { return RelayActionResult(ok: true, status: parsed?.status) }
            return RelayActionResult(ok: false, status: parsed?.status, reason: parsed?.reason ?? "Squeak couldn't finish that (HTTP \(r.status)).")
        } catch {
            return RelayActionResult(ok: false, reason: "Squeak isn't running.")
        }
    }
}
