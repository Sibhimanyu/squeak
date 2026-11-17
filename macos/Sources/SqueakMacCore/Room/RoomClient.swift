import Foundation

public enum RoomStreamEvent: Sendable, Equatable {
    case hello(latestSeq: Int)
    case post(RoomPost)
    /// A turn started or changed (room v2): upsert by id.
    case turn(RoomTurn)
    /// A job appeared or changed (room jobs): upsert by id.
    case job(RoomJob)
    /// A duck's name, role or duty changed (`thread` frame): upsert by session id.
    case thread(RoomThread)
    /// The stream (re)connected after a drop: read `since` what is held.
    case reconnected
}

/// The pond room's routes on the session host (token-gated, same client as every /native route). A host without
/// them (404/501) answers nil, and the caller shows a quiet line instead of an error.
public struct RoomClient: Sendable {
    let host: NativeHostClient
    public init(host: NativeHostClient) { self.host = host }

    private static func path(_ project: String) -> String { "/native/projects/\(NativeHostClient.id(project))/room" }

    public static func query(since: Int?, before: Int?, limit: Int?) -> String {
        var items: [String] = []
        if let since { items.append("since=\(since)") }
        if let before { items.append("before=\(before)") }
        if let limit { items.append("limit=\(limit)") }
        return items.isEmpty ? "" : "?" + items.joined(separator: "&")
    }

    /// nil from a host without the route.
    public func page(project: String, since: Int? = nil, before: Int? = nil, limit: Int? = nil) async throws -> RoomPage? {
        do {
            let data = try await host.call("GET", Self.path(project) + Self.query(since: since, before: before, limit: limit), timeout: 15)
            do { return try JSONDecoder().decode(RoomPage.self, from: data) } catch { throw NativeHostError.badResponse }
        } catch where PondsClient.isAbsent(error) { return nil }
    }

    public func send(project: String, text: String, level: RoomLevel = .room) async throws -> RoomPost {
        struct R: Decodable { var post: RoomPost }
        let body: NativeJSON = .object(["text": .string(text), "level": .string(level.rawValue)])
        let data = try await host.call("POST", Self.path(project), body: body, timeout: 20, maybeSent: true)
        do { return try JSONDecoder().decode(R.self, from: data).post } catch { throw NativeHostError.badResponse }
    }

    /// "Make this a job": `POST .../room/jobs { messageId }` answers 201 `{ job }`.
    public func makeJob(project: String, messageId: String) async throws -> RoomJob {
        let body: NativeJSON = .object(["messageId": .string(messageId)])
        return try Self.job(try await host.call("POST", Self.path(project) + "/jobs", body: body, timeout: 20))
    }

    /// Go / New thread / Just a note / Allow / No: `POST .../room/jobs/<id>`. A 409 carries its own sentence.
    public func act(project: String, jobId: String, action: RoomJobAction) async throws -> RoomJob {
        let path = Self.path(project) + "/jobs/" + NativeHostClient.id(jobId)
        return try Self.job(try await host.call("POST", path, body: action.body, timeout: 20))
    }

    /// Rename a duck or set its role: `PATCH /native/sessions/<id>/duck { name?, role? }` (null clears). Answers the chosen pair.
    @discardableResult
    public func patchDuck(sessionId: String, name: RoomDuckField = .unchanged, role: RoomDuckField = .unchanged) async throws -> (name: String?, role: String?) {
        var o: [String: NativeJSON] = [:]
        if let v = name.json { o["name"] = v }
        if let v = role.json { o["role"] = v }
        let data = try await host.call("PATCH", "/native/sessions/\(NativeHostClient.id(sessionId))/duck", body: .object(o), timeout: 15)
        let j = NativeJSON.parse(String(decoding: data, as: UTF8.self))
        return (j?["name"]?.string, j?["role"]?.string)
    }

    /// Put a duck on or off duty: `POST /native/sessions/<id>/duty { on }`.
    public func setDuty(sessionId: String, on: Bool) async throws {
        _ = try await host.call("POST", "/native/sessions/\(NativeHostClient.id(sessionId))/duty", body: .object(["on": .bool(on)]), timeout: 15)
    }

    /// The stream sends the bare job; a wrapped `{ job }` is read too.
    static func streamedJob(_ data: Data) -> RoomJob? {
        struct W: Decodable { var job: RoomJob }
        if let j = try? JSONDecoder().decode(RoomJob.self, from: data) { return j }
        return (try? JSONDecoder().decode(W.self, from: data))?.job
    }

    static func job(_ data: Data) throws -> RoomJob {
        struct R: Decodable { var job: RoomJob }
        do { return try JSONDecoder().decode(R.self, from: data).job } catch { throw NativeHostError.badResponse }
    }

    /// `GET .../room/stream`: `hello`, then a `post` per new post. Reconnects until iteration stops; a reconnect
    /// yields `.reconnected` first so the caller refetches `since` its last seq. An absent route ends the stream.
    public func events(
        project: String, minBackoff: Duration = .seconds(1), maxBackoff: Duration = .seconds(10),
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) -> AsyncStream<RoomStreamEvent> {
        let host = self.host
        return AsyncStream { continuation in
            let task = Task {
                var backoff = minBackoff
                var connectedBefore = false
                while !Task.isCancelled {
                    guard let token = host.tokenProvider() else {
                        try? await sleep(maxBackoff)
                        continue
                    }
                    let request = HTTPRequest(url: host.url(Self.path(project) + "/stream"), headers: ["x-squeak-token": token], timeout: 90)
                    var parser = SSEParser()
                    var absent = false
                    do {
                        for try await line in host.lineSource(request) {
                            guard let frame = parser.feed(line) else { continue }
                            backoff = minBackoff
                            switch frame.event {
                            case "hello":
                                if connectedBefore { continuation.yield(.reconnected) }
                                connectedBefore = true
                                if let n = NativeJSON.parse(frame.data)?["latestSeq"]?.int { continuation.yield(.hello(latestSeq: n)) }
                            case "post":
                                if let data = frame.data.data(using: .utf8), let p = try? JSONDecoder().decode(RoomPost.self, from: data) {
                                    continuation.yield(.post(p))
                                }
                            case "turn":
                                if let data = frame.data.data(using: .utf8), let t = try? JSONDecoder().decode(RoomTurn.self, from: data) {
                                    continuation.yield(.turn(t))
                                }
                            case "job":
                                if let data = frame.data.data(using: .utf8), let j = Self.streamedJob(data) { continuation.yield(.job(j)) }
                            case "thread":
                                if let data = frame.data.data(using: .utf8), let t = try? JSONDecoder().decode(RoomThread.self, from: data) {
                                    continuation.yield(.thread(t))
                                }
                            default: break
                            }
                        }
                    } catch where PondsClient.isAbsent(error) {
                        absent = true
                    } catch {}
                    if Task.isCancelled || absent { break }
                    try? await sleep(backoff)
                    backoff = min(maxBackoff, backoff * 2)
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

/// A field of a duck PATCH: left alone, set, or cleared (null).
public enum RoomDuckField: Sendable, Equatable {
    case unchanged, set(String), clear
    var json: NativeJSON? {
        switch self { case .unchanged: nil; case .set(let s): .string(s); case .clear: .null }
    }
}
