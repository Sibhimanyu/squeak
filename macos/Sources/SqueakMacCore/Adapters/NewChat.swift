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
    /// `model`, `thinking` and `split` are sent only when set; a split only for Claude, plan first only with a split.
    public func startChat(workspaceId: String, agent: NewChatAgent, text: String,
                          model: String? = nil, thinking: String? = nil, split: WorkSplit? = nil) async -> StartChatResult {
        guard let token = tokenProvider() else { return .failed(reason: "Squeak's access token was not found") }
        var fields: [String: any Sendable] = ["workspaceId": workspaceId, "agent": agent.rawValue, "text": text]
        if let model, !model.isEmpty { fields["model"] = model }
        if let thinking, !thinking.isEmpty { fields["thinking"] = thinking }
        if agent == .claude, let split, !split.isEmpty { fields["split"] = split.json }
        let extended = fields.count > 3
        guard JSONSerialization.isValidJSONObject(fields), let body = try? JSONSerialization.data(withJSONObject: fields) else { return .failed(reason: "Could not encode the message") }
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
        if extended, response.status == 400, parsed?.ok != true, (parsed?.reason ?? "").isEmpty {
            return .failed(reason: "This version of the Squeak service can't take a model or work split yet. Update the service.")
        }
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
    /// The daemon's models (empty until loaded or from an older daemon) and the chosen setup.
    public private(set) var models: [DaemonChatModel] = []
    public private(set) var setup = ChatSetup()
    private let store: ChatChoiceStore?

    public init(workspaces: [NewChatWorkspace] = [], preselect: String? = nil, store: ChatChoiceStore? = nil) {
        self.store = store
        self.workspaces = workspaces.sorted { ($0.lastActivityAt ?? .distantPast) > ($1.lastActivityAt ?? .distantPast) }
        if let preselect, self.workspaces.contains(where: { $0.id == preselect }) { select(preselect) }
        else if let first = self.workspaces.first { select(first.id) }
    }

    public mutating func setWorkspaces(_ list: [NewChatWorkspace]) {
        let keep = workspaceId, keepAgent = agentChosen ? agent : nil, keepQuery = query, keepText = text
        let keepModels = models, keepSetup = setup
        self = NewChatForm(workspaces: list, preselect: keep, store: store)
        query = keepQuery
        text = keepText
        models = keepModels; setup = keepSetup
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

    public mutating func choose(agent: NewChatAgent) {
        self.agent = agent; agentChosen = true
        restoreSetup()
    }

    // MARK: Setup (presets, model, thinking, split)

    public mutating func setModels(_ list: [DaemonChatModel]) {
        models = list
        restoreSetup()
    }

    private mutating func restoreSetup() {
        setup = models.isEmpty ? ChatSetup() : (store?.restore(agent: agent, models: models) ?? ChatPresets.setup(for: .best, agent: agent, models: models) ?? ChatSetup())
    }

    public var agentModels: [DaemonChatModel] { ChatPresets.models(models, agent) }
    public var chosenModel: DaemonChatModel? { agentModels.first { $0.id == setup.modelId } }
    public var presets: [ChatPreset] { ChatPresets.available(agent: agent, models: models) }
    public var preset: ChatPreset { ChatPresets.preset(of: setup, agent: agent, models: models) }
    public var summary: String { ChatPresets.summary(of: setup, agent: agent, models: models) }
    public var canSplit: Bool { agent == .claude && !models.isEmpty }

    public mutating func apply(preset: ChatPreset) {
        guard let s = ChatPresets.setup(for: preset, agent: agent, models: models) else { return }
        setup = s
        remember()
    }

    public mutating func pick(modelId: String) {
        guard let m = agentModels.first(where: { $0.id == modelId }) else { return }
        setup.modelId = m.id
        if let l = setup.level, m.levels.contains(l) {} else { setup.level = m.levels.isEmpty ? nil : (m.defaultLevel ?? m.levels.first) }
        remember()
    }

    public mutating func pick(level: String) { setup.level = level; remember() }
    public mutating func pick(code: String?) { setup.code = code; remember() }
    public mutating func pick(run: String?) { setup.run = run; remember() }
    /// Plan first needs a split to hold; with none it stays off.
    public mutating func set(planFirst: Bool) { setup.planFirst = planFirst && canSplit; remember() }

    private func remember() { store?.save(setup, preset: preset, agent: agent) }

    /// What startChat sends: nil keys when default, a split only for Claude.
    public var request: (model: String?, thinking: String?, split: WorkSplit?) {
        let s = ChatPresets.sanitised(setup, agent: agent, models: models)
        let split = canSplit && !s.split.isEmpty ? s.split : nil
        return (s.modelId, s.level, split)
    }

    public var trimmedText: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }
    public var isTooLong: Bool { trimmedText.count > Self.maxLength }
    public var canStart: Bool { selected != nil && !trimmedText.isEmpty && !isTooLong }
}
