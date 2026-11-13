import Foundation

// docs/ponds.md, "Host routes": every route the Mac calls, over the session host's token-gated HTTP (`x-squeak-token`,
// no CORS, under /native). Built against the contract, so a host without the routes (404: the flag is off, or an
// older host) answers nil from `ponds()` and the app behaves as it did before ponds.

public enum PondAnswerResult: Sendable, Equatable {
    case sent
    /// Another member holds the question (409); `message` is the host's own words, often who.
    case held(String?)
}

public struct PondsClient: Sendable {
    let host: NativeHostClient

    public init(host: NativeHostClient) { self.host = host }

    private static func p(_ pond: String) -> String { "/native/ponds/\(NativeHostClient.id(pond))" }
    private static func t(_ pond: String, _ thread: String) -> String { "\(p(pond))/threads/\(NativeHostClient.id(thread))" }

    /// Pond reads go to a relay that can take several seconds; the host answers within about 6 s, from its last read if it must.
    static let readTimeout: TimeInterval = 25

    private func decode<T: Decodable>(_ type: T.Type, _ data: Data) throws -> T {
        do { return try JSONDecoder().decode(type, from: data) } catch { throw NativeHostError.badResponse }
    }

    /// True for the answers that mean "this host has no ponds": the route is absent or the flag is off.
    static func isAbsent(_ error: Error) -> Bool {
        if case NativeHostError.http(let code, _) = error { return code == 404 || code == 501 }
        return false
    }

    // MARK: Ponds

    /// nil when the host has no pond routes. Any other failure throws.
    public func ponds() async throws -> [PondSummary]? {
        struct R: Decodable { var ponds: [Failable<PondSummary>]? }
        do { return try decode(R.self, try await host.call("GET", "/native/ponds", timeout: Self.readTimeout)).ponds?.compactMap(\.value) ?? [] }
        catch where Self.isAbsent(error) { return nil }
    }

    /// The list with whether the host has a cloud store an invite could publish to (absent on an older host: assume yes).
    public func listing() async throws -> (ponds: [PondSummary], cloud: Bool)? {
        struct R: Decodable { var ponds: [Failable<PondSummary>]?; var cloud: Bool? }
        do {
            let r = try decode(R.self, try await host.call("GET", "/native/ponds", timeout: Self.readTimeout))
            return (r.ponds?.compactMap(\.value) ?? [], r.cloud ?? true)
        } catch where Self.isAbsent(error) { return nil }
    }

    /// The pond directory: the one list every pond is drawn from (nil from a host without the route).
    public func directory() async throws -> PondDirectory? { try await host.directory() }

    /// The local pond of a project, by its project id (made once; the same one every time). A name is not a pond: the host
    /// refuses one. Nothing leaves this Mac.
    public func ensureLocal(projectId: String) async throws -> PondSummary {
        struct R: Decodable { var pond: PondSummary }
        return try decode(R.self, try await host.call("POST", "/native/ponds/local", body: .object(["projectId": .string(projectId)]), timeout: 30)).pond
    }

    public func create(name: String, projectId: String? = nil, rootPath: String? = nil) async throws -> PondSummary {
        struct R: Decodable { var pond: PondSummary }
        var body: [String: NativeJSON] = ["name": .string(name)]
        if let projectId { body["projectId"] = .string(projectId) }
        if let rootPath { body["rootPath"] = .string(rootPath) }
        return try decode(R.self, try await host.call("POST", "/native/ponds", body: .object(body), timeout: 30)).pond
    }

    /// nil when the pond is unknown to this host (404).
    public func detail(id: String) async throws -> PondDetail? {
        do { return try decode(PondDetail.self, try await host.call("GET", Self.p(id), timeout: Self.readTimeout)) }
        catch where Self.isAbsent(error) { return nil }
    }

    public func removeMember(pond: String, member: String) async throws {
        _ = try await host.call("DELETE", "\(Self.p(pond))/members/\(NativeHostClient.id(member))", timeout: 60)
    }

    /// Owner: member or viewer.
    public func setRole(pond: String, member: String, role: PondRole) async throws {
        _ = try await host.call("POST", "\(Self.p(pond))/members/\(NativeHostClient.id(member))/role", body: .object(["role": .string(role.rawValue)]), timeout: 60)
    }

    /// A member leaves.
    public func leave(pond: String) async throws {
        _ = try await host.call("POST", "\(Self.p(pond))/leave", body: .object(["pondId": .string(pond)]), timeout: 60)
    }

    public func rename(pond: String, name: String) async throws {
        _ = try await host.call("POST", "\(Self.p(pond))/rename", body: .object(["name": .string(name)]), timeout: 30)
    }

    /// Owner: ends the pond for everyone.
    public func deletePond(pond: String) async throws {
        _ = try await host.call("POST", "\(Self.p(pond))/delete", body: .object(["pondId": .string(pond)]), timeout: 120)
    }

    public func rotateKey(pond: String) async throws {
        _ = try await host.call("POST", "\(Self.p(pond))/rotate-key", body: .object(["pondId": .string(pond)]), timeout: 120)
    }

    /// Clears a pond that ended for me (declined, expired, withdrawn, removed) from this Mac.
    public func forget(pond: String) async throws {
        _ = try await host.call("POST", "\(Self.p(pond))/forget", body: .object(["pondId": .string(pond)]), timeout: 30)
    }

    public func revokeInvite(pond: String, invite: String) async throws {
        _ = try await host.call("DELETE", "\(Self.p(pond))/invites/\(NativeHostClient.id(invite))", timeout: 30)
    }

    // MARK: Invites and joins

    /// `short: true` asks for a six-character code (10 minutes, once) instead of the long code.
    public func invite(pond: String, role: PondRole, short: Bool = false) async throws -> PondInvite {
        var body: [String: NativeJSON] = ["role": .string(role.rawValue)]
        if short { body["short"] = .bool(true) }
        return try decode(PondInvite.self, try await host.call("POST", "\(Self.p(pond))/invites", body: .object(body), timeout: 60))
    }

    public func join(code: String) async throws -> PondJoinResult {
        try decode(
            PondJoinResult.self,
            try await host.call("POST", "/native/ponds/join", body: .object(["code": .string(code)]), timeout: 30))
    }

    /// Withdraws this Mac's pending join request, or clears a declined one.
    public func cancelJoin(pond: String) async throws {
        _ = try await host.call("POST", "\(Self.p(pond))/cancel-join", body: .object(["pondId": .string(pond)]), timeout: 30)
    }

    public func decideJoin(pond: String, request: String, approve: Bool, role: PondRole = .member) async throws {
        _ = try await host.call(
            "POST", "\(Self.p(pond))/joins/\(NativeHostClient.id(request))",
            body: .object(["approve": .bool(approve), "role": .string(role.rawValue)]), timeout: 30)
    }

    // MARK: Threads

    /// An own thread on this Nest (needs a pond with a Git remote). The thread, when the host says it.
    /// `effort`, `permissionMode` and `split` are the fields a normal new thread sends; `isPrivate` publishes it private
    /// from the start (the host never shows it shared first).
    public func startThread(pond: String, text: String, agent: String, model: String, workspaceId: String? = nil,
                            effort: String? = nil, permissionMode: String? = nil, split: WorkSplit? = nil,
                            isPrivate: Bool = false, main: Bool = false) async throws -> PondThread? {
        struct R: Decodable { var thread: PondThread? }
        var body: [String: NativeJSON] = ["text": .string(text), "agent": .string(agent), "model": .string(model)]
        if let workspaceId { body["workspaceId"] = .string(workspaceId) }
        if main { body["main"] = .bool(true) }
        if let effort { body["effort"] = .string(effort) }
        if let permissionMode { body["permissionMode"] = .string(permissionMode) }
        if let split, !split.isEmpty { body["split"] = split.nativeJSON }
        if isPrivate { body["private"] = .bool(true) }
        let data = try await host.call("POST", "\(Self.p(pond))/threads", body: .object(body), timeout: 30)
        return (try? JSONDecoder().decode(R.self, from: data))?.thread
    }

    /// Asks for what changed in a thread (and one file's patch). Someone else's thread answers `ready: false` with a request
    /// id to read once the pond says it changed; your own answers at once.
    public func requestChanges(pond: String, thread: String, path: String? = nil) async throws -> PondChangesReply {
        var body: [String: NativeJSON] = [:]
        if let path, !path.isEmpty { body["path"] = .string(path) }
        return try decode(PondChangesReply.self, try await host.call("POST", "\(Self.t(pond, thread))/changes", body: .object(body), timeout: 30))
    }

    /// The starter's answer to a request, or nil while it has not come (or it lapsed).
    public func changes(pond: String, thread: String, request: String) async throws -> PondChanges? {
        let r = try decode(PondChangesReply.self, try await host.call("GET", "\(Self.t(pond, thread))/changes?request=\(NativeHostClient.id(request))"))
        return r.ready ? r.result : nil
    }

    /// Asks the pond owner's Mac to start a thread (a pond with no Git remote, or "Run on their Mac"). The request id comes
    /// back; the thread shows up in the pond carrying it.
    public func requestStart(pond: String, text: String, agent: String, model: String, title: String? = nil) async throws -> String {
        struct R: Decodable { var requestId: String }
        var body: [String: NativeJSON] = ["text": .string(text), "agent": .string(agent), "model": .string(model)]
        if let title, !title.isEmpty { body["title"] = .string(title) }
        return try decode(R.self, try await host.call("POST", "\(Self.p(pond))/start", body: .object(body), timeout: 30)).requestId
    }

    /// Publishes a host chat as a shared thread.
    public func share(pond: String, sessionId: String, isPrivate: Bool = false) async throws {
        _ = try await host.call("POST", "\(Self.p(pond))/share", body: .object(["sessionId": .string(sessionId), "private": .bool(isPrivate)]), timeout: 30)
    }

    /// Starter only.
    public func setPrivate(pond: String, thread: String, isPrivate: Bool) async throws {
        _ = try await host.call("POST", "\(Self.t(pond, thread))/visibility", body: .object(["private": .bool(isPrivate)]))
    }

    public func events(pond: String, thread: String, after: Int) async throws -> ThreadEventPage {
        try decode(ThreadEventPage.self, try await host.call("GET", "\(Self.t(pond, thread))/events?after=\(max(0, after))"))
    }

    /// The host's word on the message: queued behind the starter's Mac, sent, or refused with its reason. Never retried: a
    /// timeout is `uncertain`.
    public func send(pond: String, thread: String, text: String, mode: SendMode) async throws -> PondSendResult {
        let r = try await host.call(
            "POST", "\(Self.t(pond, thread))/messages", body: .object(["text": .string(text), "mode": .string(mode.rawValue)]), timeout: 30,
            maybeSent: true)
        return (try? JSONDecoder().decode(PondSendResult.self, from: r)) ?? PondSendResult(state: .sent)
    }

    /// Starts (or renews) answering a question; the host answers who holds it.
    public func hold(pond: String, thread: String, requestId: String) async throws -> (ok: Bool, heldBy: String?) {
        do {
            let r = try await host.call("POST", "\(Self.t(pond, thread))/hold", body: .object(["requestId": .string(requestId)]))
            let json = try? JSONDecoder().decode(NativeJSON.self, from: r)
            return (json?["ok"]?.bool ?? true, json?["heldBy"]?.string)
        } catch NativeHostError.http(409, let message) {
            return (false, message)
        }
    }

    public func answer(pond: String, thread: String, requestId: String, answer: String) async throws -> PondAnswerResult {
        do {
            _ = try await host.call(
                "POST", "\(Self.t(pond, thread))/answers", body: .object(["requestId": .string(requestId), "answer": .string(answer)]), timeout: 20,
                maybeSent: true)
            return .sent
        } catch NativeHostError.http(409, let message) {
            return .held(message)
        }
    }

    /// `typingIn` is the thread the person is typing in (the host stores the id, not a flag); nil or empty says not typing.
    public func presence(pond: String, viewing: String?, typingIn: String?) async throws {
        var body: [String: NativeJSON] = [:]
        if let viewing, !viewing.isEmpty { body["viewing"] = .string(viewing) }
        if let typingIn, !typingIn.isEmpty { body["typing"] = .string(typingIn) }
        _ = try await host.call("POST", "\(Self.p(pond))/presence", body: .object(body))
    }

    // MARK: Stream

    /// The pond ids whose data changed, from `GET /ponds/stream` (`event: changed`, data `{ pondId }`, never content).
    /// A change only wakes a read: callers re-read through `detail` and `events`. Reconnects until iteration stops.
    public func changes(
        minBackoff: Duration = .seconds(1), maxBackoff: Duration = .seconds(10),
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) -> AsyncStream<String> {
        let host = self.host
        return AsyncStream { continuation in
            let task = Task {
                var backoff = minBackoff
                while !Task.isCancelled {
                    guard let token = host.tokenProvider() else {
                        try? await sleep(maxBackoff)
                        continue
                    }
                    let request = HTTPRequest(url: host.url("/native/ponds/stream"), headers: ["x-squeak-token": token], timeout: 90)
                    var parser = SSEParser()
                    var absent = false
                    do {
                        for try await line in host.lineSource(request) {
                            guard let frame = parser.feed(line), frame.event == "changed" else { continue }
                            backoff = minBackoff
                            if let id = NativeJSON.parse(frame.data)?["pondId"]?.string { continuation.yield(id) }
                        }
                    } catch NativeHostError.http(let code, _) where code == 404 || code == 501 {
                        absent = true
                    } catch {}
                    if Task.isCancelled { break }
                    // An absent route will not appear on the next try; wait the long time.
                    try? await sleep(absent ? maxBackoff * 6 : backoff)
                    backoff = min(maxBackoff, backoff * 2)
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}
