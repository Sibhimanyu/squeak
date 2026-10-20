import Foundation

/// A Conductor workspace that can take a new chat, as `GET /control/workspaces` lists it.
public struct NewChatWorkspace: Decodable, Sendable, Equatable, Identifiable, Hashable {
    public var id: String
    public var repoName: String
    public var branch: String
    public var title: String?
    public var lastActivityAt: Date?
    public var defaultAgent: NewChatAgent

    public init(id: String, repoName: String, branch: String, title: String? = nil, lastActivityAt: Date? = nil, defaultAgent: NewChatAgent = .claude) {
        self.id = id; self.repoName = repoName; self.branch = branch; self.title = title
        self.lastActivityAt = lastActivityAt; self.defaultAgent = defaultAgent
    }

    enum CodingKeys: String, CodingKey { case id, repoName, branch, title, lastActivityAt, defaultAgent }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        repoName = c.lenient(String.self, .repoName) ?? ""
        branch = c.lenient(String.self, .branch) ?? ""
        title = c.lenient(String.self, .title)
        lastActivityAt = c.lenient(String.self, .lastActivityAt).flatMap(DaemonDate.parse)
        defaultAgent = c.lenient(String.self, .defaultAgent).flatMap(NewChatAgent.init(rawValue:)) ?? .claude
    }

    /// "repo · branch", the one label the picker uses everywhere.
    public var label: String { [repoName, branch].filter { !$0.isEmpty }.joined(separator: " · ") }
}

public enum NewChatAgent: String, Sendable, Equatable, CaseIterable, Identifiable {
    case claude, codex
    public var id: String { rawValue }
    public var displayName: String { self == .claude ? "Claude" : "Codex" }
}

struct NewChatWorkspacesBody: Decodable {
    var workspaces: [NewChatWorkspace]

    init(from decoder: Decoder) throws {
        struct Failable: Decodable {
            let value: NewChatWorkspace?
            init(from decoder: Decoder) throws { value = try? NewChatWorkspace(from: decoder) }
        }
        let c = try decoder.container(keyedBy: CodingKeys.self)
        workspaces = (try c.decode([Failable].self, forKey: .workspaces)).compactMap(\.value)
    }
    enum CodingKeys: String, CodingKey { case workspaces }
}

public enum StartChatResult: Sendable, Equatable {
    case started(sessionId: String)
    /// Nothing was created; the reason is safe to show as is.
    case failed(reason: String)
    /// The request may have been processed: look in Conductor before trying again.
    case uncertain(reason: String)
}

struct StartChatBody: Decodable {
    var ok: Bool?
    var sessionId: String?
    var reason: String?
}

extension DaemonClient {
    /// nil when the daemon predates the route (404) or has no relay behind it (503).
    public func newChatWorkspaces() async throws -> [NewChatWorkspace]? {
        let r = try await getControl("/control/workspaces")
        if r.status == 404 || r.status == 503 { return nil }
        if r.status == 401 || r.status == 403 { throw AdapterError.tokenRejected }
        guard (200..<300).contains(r.status) else { throw AdapterError.http(r.status) }
        guard let body = try? JSONDecoder().decode(NewChatWorkspacesBody.self, from: r.body) else {
            throw AdapterError.badResponse("unreadable workspaces")
        }
        return body.workspaces
    }

    /// Never throws and never retries: a new chat is created by the first message, so a retry could make two.
    public func startChat(workspaceId: String, agent: NewChatAgent, text: String) async -> StartChatResult {
        guard let token = tokenProvider() else { return .failed(reason: "Squeak's access token was not found") }
        let fields = ["workspaceId": workspaceId, "agent": agent.rawValue, "text": text]
        guard let body = try? JSONEncoder().encode(fields) else { return .failed(reason: "Could not encode the message") }
        let request = HTTPRequest(
            method: "POST", url: controlURL("/control/chats"),
            headers: ["x-squeak-token": token, "content-type": "application/json"], body: body, timeout: 45)
        let response: HTTPResponse
        do {
            response = try await transportForControl.send(request)
        } catch let e as TransportError {
            switch e {
            case .connectionRefused: return .failed(reason: "Squeak is not running")
            case .timedOut: return .uncertain(reason: "Timed out waiting for Squeak. Check Conductor before starting it again.")
            case .connectionLost: return .uncertain(reason: "Connection to Squeak dropped. Check Conductor before starting it again.")
            case .other(let m): return .failed(reason: m)
            }
        } catch {
            return .failed(reason: "Request failed")
        }
        if response.status == 401 || response.status == 403 { return .failed(reason: "Squeak rejected the access token") }
        if response.status == 404 || response.status == 503 {
            return .failed(reason: "This version of the Squeak service can't start chats yet. Update the service.")
        }
        let parsed = try? JSONDecoder().decode(StartChatBody.self, from: response.body)
        if parsed?.ok == true, let id = parsed?.sessionId, !id.isEmpty { return .started(sessionId: id) }
        if let reason = parsed?.reason, !reason.isEmpty { return .failed(reason: reason) }
        if (400..<500).contains(response.status) { return .failed(reason: "Squeak rejected the request (HTTP \(response.status))") }
        return .uncertain(reason: "Unexpected reply from Squeak (HTTP \(response.status)). Check Conductor before starting it again.")
    }
}

/// The New chat sheet's logic, kept out of the view so it is tested.
public struct NewChatForm: Sendable, Equatable {
    public static let maxLength = 20_000

    public private(set) var workspaces: [NewChatWorkspace]
    public var query = ""
    public private(set) var workspaceId: String?
    public private(set) var agent: NewChatAgent = .claude
    private var agentChosen = false
    public var text = ""

    public init(workspaces: [NewChatWorkspace] = [], preselect: String? = nil) {
        self.workspaces = workspaces.sorted { ($0.lastActivityAt ?? .distantPast) > ($1.lastActivityAt ?? .distantPast) }
        if let preselect, self.workspaces.contains(where: { $0.id == preselect }) { select(preselect) }
        else if let first = self.workspaces.first { select(first.id) }
    }

    public mutating func setWorkspaces(_ list: [NewChatWorkspace]) {
        let keep = workspaceId, keepAgent = agentChosen ? agent : nil, keepQuery = query, keepText = text
        self = NewChatForm(workspaces: list, preselect: keep)
        query = keepQuery
        text = keepText
        if let keepAgent { agent = keepAgent; agentChosen = true }
    }

    public var selected: NewChatWorkspace? { workspaces.first { $0.id == workspaceId } }

    /// Recent first, narrowed by every word of the query against "repo branch title".
    public var filtered: [NewChatWorkspace] {
        let words = query.lowercased().split(whereSeparator: \.isWhitespace).map(String.init)
        guard !words.isEmpty else { return workspaces }
        return workspaces.filter { w in
            let hay = [w.repoName, w.branch, w.title ?? ""].joined(separator: " ").lowercased()
            return words.allSatisfy { hay.contains($0) }
        }
    }

    public mutating func select(_ id: String) {
        guard let w = workspaces.first(where: { $0.id == id }) else { return }
        workspaceId = id
        // The workspace's own agent, until the user has picked one themselves.
        if !agentChosen { agent = w.defaultAgent }
    }

    public mutating func choose(agent: NewChatAgent) { self.agent = agent; agentChosen = true }

    public var trimmedText: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    public var isTooLong: Bool { trimmedText.count > Self.maxLength }
    public var canStart: Bool { selected != nil && !trimmedText.isEmpty && !isTooLong }
}
