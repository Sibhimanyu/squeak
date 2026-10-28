import Foundation

/// The daemon's reading of the agent hooks (`GET /control/hooks`). The daemon computes the state and every
/// sentence; the Mac only draws them.
public enum HooksState: String, Sendable, Equatable {
    case installed, partial, missing, error
    /// A state this build does not know: drawn like an error, with the daemon's own message.
    case unknown
}

public struct HooksStatus: Sendable, Equatable, Decodable {
    public struct Claude: Sendable, Equatable {
        public var settingsFound: Bool
        public var hooksInstalled: Bool
        public var missing: [String]
        public var askFormat: Bool
        public init(settingsFound: Bool = false, hooksInstalled: Bool = false, missing: [String] = [], askFormat: Bool = false) {
            self.settingsFound = settingsFound; self.hooksInstalled = hooksInstalled; self.missing = missing; self.askFormat = askFormat
        }
    }
    public struct Codex: Sendable, Equatable {
        public var agentsFound: Bool
        public var askFormat: Bool
        public init(agentsFound: Bool = false, askFormat: Bool = false) { self.agentsFound = agentsFound; self.askFormat = askFormat }
    }

    public var state: HooksState
    public var claude: Claude
    public var codex: Codex
    public var message: String
    public var steps: [String]

    public init(state: HooksState, claude: Claude = .init(), codex: Codex = .init(), message: String = "", steps: [String] = []) {
        self.state = state; self.claude = claude; self.codex = codex; self.message = message; self.steps = steps
    }

    private enum Keys: String, CodingKey { case state, claude, codex, message, steps }
    private enum ClaudeKeys: String, CodingKey { case settingsFound, hooksInstalled, missing, askFormat }
    private enum CodexKeys: String, CodingKey { case agentsFound, askFormat }

    /// Lenient: every field optional, an unknown state is `.unknown`, so a newer daemon never breaks the page.
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: Keys.self)
        state = (try? c.decodeIfPresent(String.self, forKey: .state)).flatMap { $0 }.flatMap(HooksState.init(rawValue:)) ?? .unknown
        message = (try? c.decodeIfPresent(String.self, forKey: .message)) ?? ""
        steps = (try? c.decodeIfPresent([String].self, forKey: .steps)) ?? []
        claude = .init()
        if let k = try? c.nestedContainer(keyedBy: ClaudeKeys.self, forKey: .claude) {
            claude = Claude(
                settingsFound: (try? k.decodeIfPresent(Bool.self, forKey: .settingsFound)) ?? false,
                hooksInstalled: (try? k.decodeIfPresent(Bool.self, forKey: .hooksInstalled)) ?? false,
                missing: (try? k.decodeIfPresent([String].self, forKey: .missing)) ?? [],
                askFormat: (try? k.decodeIfPresent(Bool.self, forKey: .askFormat)) ?? false)
        }
        codex = .init()
        if let k = try? c.nestedContainer(keyedBy: CodexKeys.self, forKey: .codex) {
            codex = Codex(
                agentsFound: (try? k.decodeIfPresent(Bool.self, forKey: .agentsFound)) ?? false,
                askFormat: (try? k.decodeIfPresent(Bool.self, forKey: .askFormat)) ?? false)
        }
    }
}

/// What an install or uninstall did. `status` is the daemon's reading afterwards when it could be read.
public struct HooksActionResult: Sendable, Equatable {
    public var ok: Bool
    public var status: HooksStatus?
    public var reason: String?

    public init(ok: Bool, status: HooksStatus? = nil, reason: String? = nil) {
        self.ok = ok; self.status = status; self.reason = reason
    }

    /// An older daemon (404/503) answers none of the hooks routes.
    public static let updateService = HooksActionResult(ok: false, reason: RelayStatus.updateServiceSentence)
}

private struct HooksActionBody: Decodable {
    let ok: Bool?
    let status: HooksStatus?
    let reason: String?
}

extension DaemonClient {
    /// nil when the daemon predates the route (404) or has no hooks support (503).
    public func hooksStatus() async throws -> HooksStatus? {
        let r = try await getControl("/control/hooks")
        if r.status == 404 || r.status == 503 { return nil }
        if r.status == 401 || r.status == 403 { throw AdapterError.tokenRejected }
        guard (200..<300).contains(r.status) else { throw AdapterError.http(r.status) }
        guard let s = try? JSONDecoder().decode(HooksStatus.self, from: r.body) else { throw AdapterError.badResponse("unreadable HooksStatus") }
        return s
    }

    /// One attempt, never retried: install edits the agents' settings files.
    public func installHooks() async -> HooksActionResult { await hooksAction("/control/hooks/install") }

    /// One attempt, never retried.
    public func uninstallHooks() async -> HooksActionResult { await hooksAction("/control/hooks/uninstall") }

    private func hooksAction(_ path: String) async -> HooksActionResult {
        guard let token = tokenProvider() else { return HooksActionResult(ok: false, reason: "Squeak's access token was not found") }
        let request = HTTPRequest(
            method: "POST", url: controlURL(path), headers: ["x-squeak-token": token, "content-type": "application/json"],
            body: Data("{}".utf8), timeout: 60)
        do {
            let r = try await transportForControl.send(request)
            if r.status == 404 || r.status == 503 { return .updateService }
            if r.status == 401 || r.status == 403 { return HooksActionResult(ok: false, reason: "Squeak rejected the access token") }
            let parsed = try? JSONDecoder().decode(HooksActionBody.self, from: r.body)
            if (200..<300).contains(r.status), parsed?.ok == true { return HooksActionResult(ok: true, status: parsed?.status) }
            return HooksActionResult(ok: false, status: parsed?.status, reason: parsed?.reason ?? "Squeak couldn't finish that (HTTP \(r.status)).")
        } catch {
            return HooksActionResult(ok: false, reason: "Squeak isn't running.")
        }
    }
}
