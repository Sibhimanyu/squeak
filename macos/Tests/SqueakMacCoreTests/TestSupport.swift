import Foundation
@testable import SqueakMacCore

/// Scripted HTTP transport keyed by "METHOD /path". No network is ever touched.
actor FakeTransport: HTTPTransport {
    private var routes: [String: Result<HTTPResponse, TransportError>] = [:]
    private(set) var requests: [HTTPRequest] = []

    func route(_ method: String, _ path: String, _ result: Result<HTTPResponse, TransportError>) {
        routes["\(method) \(path)"] = result
    }

    func json(_ method: String, _ path: String, status: Int = 200, _ body: String) {
        routes["\(method) \(path)"] = .success(HTTPResponse(status: status, body: Data(body.utf8)))
    }

    func send(_ request: HTTPRequest) async throws -> HTTPResponse {
        requests.append(request)
        guard let r = routes["\(request.method) \(request.url.path)"] else { return HTTPResponse(status: 404) }
        return try r.get()
    }
}

final class FakeClock: BrokerClock, @unchecked Sendable {
    private let lock = NSLock()
    private var current: Date
    private var sleeps: [Duration] = []
    private let maxTicks: Int

    init(start: Date = Date(timeIntervalSince1970: 1_800_000_000), maxTicks: Int = 3) {
        current = start
        self.maxTicks = maxTicks
    }

    var recordedSleeps: [Duration] { lock.withLock { sleeps } }

    func now() -> Date { lock.withLock { current } }

    func advance(_ seconds: TimeInterval) { lock.withLock { current = current.addingTimeInterval(seconds) } }

    func sleep(for duration: Duration) async throws {
        let stop = lock.withLock { () -> Bool in
            sleeps.append(duration)
            current = current.addingTimeInterval(Double(duration.components.seconds))
            return sleeps.count >= maxTicks
        }
        if stop { throw CancellationError() }
    }
}

final class Box<T: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: T
    init(_ v: T) { value = v }
    var current: T {
        get { lock.withLock { value } }
        set { lock.withLock { value = newValue } }
    }
}

actor FakeAdapter: HostAdapter {
    nonisolated let id: String
    private var sessionList: [HostSession]
    private var transcriptList: [ChatMessage] = []
    private var sendResult: SendResult = .accepted(via: "conductor")
    private var failure: AdapterError?
    private(set) var sendCount = 0
    private(set) var sentTexts: [String] = []
    private(set) var sentModes: [SendMode] = []
    private(set) var discoverCount = 0

    init(id: String = "fake", sessions: [HostSession] = []) {
        self.id = id
        sessionList = sessions
    }

    func setSessions(_ s: [HostSession]) { sessionList = s }
    func setTranscript(_ t: [ChatMessage]) { transcriptList = t }
    func setSendResult(_ r: SendResult) { sendResult = r }
    func setFailure(_ e: AdapterError?) { failure = e }

    func discover() async throws -> [HostSession] {
        discoverCount += 1
        if let failure { throw failure }
        return sessionList
    }

    func transcript(for session: HostSession, limit: Int) async throws -> [ChatMessage] {
        if let failure { throw failure }
        return transcriptList
    }

    func activity(for session: HostSession) async throws -> [ActivityStep] { [] }

    func send(_ text: String, to session: HostSession, clientId: UUID) async -> SendResult {
        sendCount += 1
        sentTexts.append(text)
        return sendResult
    }

    func send(_ text: String, to session: HostSession, clientId: UUID, mode: SendMode) async -> SendResult {
        sentModes.append(mode)
        return await send(text, to: session, clientId: clientId)
    }

    nonisolated func openInHostURL(for session: HostSession) -> URL? { nil }

    func health() async -> AdapterHealth { AdapterHealth(adapterId: id, status: failure == nil ? .connected : .daemonDown) }
}

func makeSession(
    _ id: String, provider: String = "conductor", title: String = "", state: SessionState = .idle,
    at: Date? = nil, canSend: Bool = true, alive: Bool? = nil
) -> HostSession {
    var caps = Capabilities()
    caps.send = canSend ? .supported : .unsupported("no route")
    return HostSession(
        key: SessionKey(provider: provider, workspaceId: provider == "conductor" ? "ws" : nil, hostSessionId: id),
        title: title.isEmpty ? "Session \(id)" : title,
        state: state,
        lastActivityAt: at,
        alive: alive,
        replyTarget: canSend ? id : nil,
        capabilities: caps
    )
}

func tempDirectory() -> URL {
    let url = FileManager.default.temporaryDirectory.appending(path: "squeak-tests-\(UUID().uuidString)")
    try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    return url
}

let syntheticState = """
{
  "generatedAt": "2030-01-02T03:04:05Z",
  "trackedCount": 7,
  "duck": {"mood": "calm", "futureField": [1, 2, 3]},
  "codexUsage": null,
  "attention": {"items": []},
  "brandNewTopLevelField": true,
  "active": [
    {"key": "claude-transcript:aaaa-1111", "agent": "claude", "origin": "conductor", "originLabel": null,
     "source": "Conductor", "state": "working", "title": "Paint the bikeshed", "repoName": "orchard",
     "branch": "feature/shed", "cwd": "/tmp/orchard", "detail": null,
     "lastActivityAt": "2030-01-02T03:04:00Z", "contextPercent": 12.5, "alive": true,
     "conductorSessionId": "aaaa-1111", "conductorWorkspaceId": "ws-orchard", "replyTarget": "aaaa-1111",
     "distinctTitle": null, "git": {"branch": "feature/shed", "filesChanged": 2}, "costUsd": 0.5,
     "someFutureField": {"nested": true}},
    {"key": "codex-rollout:bbbb-2222", "agent": "codex", "origin": "terminal", "source": "Codex",
     "state": "awaiting_approval", "title": "Tune the kettle", "repoName": "pantry", "branch": "main",
     "cwd": "/tmp/pantry", "lastActivityAt": "2030-01-02T03:03:00.250Z", "alive": true,
     "conductorSessionId": "", "conductorWorkspaceId": "", "replyTarget": "codex-rollout:bbbb-2222",
     "distinctTitle": "Tune the kettle (second)"}
  ],
  "others": [
    {"key": "claude-transcript:aaaa-1111", "agent": "claude", "origin": "conductor", "state": "idle", "title": "duplicate listing"},
    {"key": "claude-transcript:cccc-3333", "agent": "claude", "origin": "desktop", "state": "finished",
     "title": "Sort the spice rack", "repoName": "", "lastActivityAt": 1893553000, "alive": false,
     "replyTarget": null},
    {"key": "claude-transcript:dddd-4444", "agent": "claude", "origin": "sdk", "state": "mystery-state",
     "title": 42, "alive": "yes", "contextPercent": "lots"},
    {"agent": "claude", "origin": "conductor", "title": "has no key"}
  ]
}
"""
