import Foundation

public enum RoomStreamEvent: Sendable, Equatable {
    case hello(latestSeq: Int)
    case post(RoomPost)
    /// A turn started or changed (room v2): upsert by id.
    case turn(RoomTurn)
    /// A Task appeared or changed: upsert by id.
    case task(RoomTask)
    /// A duck's name, role or duty changed (`thread` frame): upsert by session id.
    case thread(RoomThread)
    /// A Member's stream only: whether the Owner's Mac is running (the sentence to show while it is not).
    case owner(offline: String?)
    /// The stream (re)connected after a drop: read `since` what is held.
    case reconnected
}

/// What a Member's message came back as: it is in the cloud and will show in the Room when the Owner's Mac has applied it.
public struct RoomQueued: Sendable, Equatable {
    public var id: String
    /// True while the Owner's Mac is not running (the message waits there, in order).
    public var offline: Bool
    public var line: String?
}

/// The pond room's routes on the session host (token-gated, same client as every /native route). A host without
/// them (404/501) answers nil, and the caller shows a quiet line instead of an error.
///
/// With `member: true` it is a Member's view of someone else's pond: the id is the pond's, the host answers from what the
/// Owner's Mac published (`/native/ponds/<id>/room`), and a message is queued for that Mac instead of posted.
public struct RoomClient: Sendable {
    let host: NativeHostClient
    let member: Bool
    public init(host: NativeHostClient, member: Bool = false) { self.host = host; self.member = member }

    private func path(_ id: String) -> String {
        member ? "/native/ponds/\(NativeHostClient.id(id))/room" : "/native/projects/\(NativeHostClient.id(id))/room"
    }

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
            let data = try await host.call("GET", path(project) + Self.query(since: since, before: before, limit: limit), timeout: 15)
            do { return try JSONDecoder().decode(RoomPage.self, from: data) } catch { throw NativeHostError.badResponse }
        } catch where PondsClient.isAbsent(error) { return nil }
    }

    public func send(project: String, text: String, level: RoomLevel = .room, attachments: [OutgoingAttachment] = []) async throws -> RoomPost {
        struct R: Decodable { var post: RoomPost }
        var fields: [String: NativeJSON] = ["text": .string(text), "level": .string(level.rawValue)]
        if !attachments.isEmpty { fields["attachments"] = RoomAttachmentDraft.wire(attachments) }
        let data = try await host.call("POST", path(project), body: .object(fields), timeout: attachments.isEmpty ? 20 : 90, maybeSent: true)
        do { return try JSONDecoder().decode(R.self, from: data).post } catch { throw NativeHostError.badResponse }
    }

    /// A Member's message: `POST /native/ponds/<id>/room { text }` answers 202 once it is in the cloud.
    public func queue(pond: String, text: String) async throws -> RoomQueued {
        let data = try await host.call("POST", path(pond), body: .object(["text": .string(text)]), timeout: 20, maybeSent: true)
        guard let j = NativeJSON.parse(String(decoding: data, as: UTF8.self)), let id = j["id"]?.string else { throw NativeHostError.badResponse }
        return RoomQueued(id: id, offline: j["offline"]?.bool ?? false, line: j["line"]?.string)
    }

    /// An attachment's bytes (`GET` its `url`, token-gated).
    public func attachment(_ a: RoomAttachment) async throws -> Data {
        guard a.url.hasPrefix("/native/") else { throw NativeHostError.badResponse }
        return try await host.call("GET", a.url, timeout: 60)
    }

    /// "Make task": `POST .../room/tasks { messageId }` answers 201 `{ task }`.
    public func makeJob(project: String, messageId: String) async throws -> RoomTask {
        let body: NativeJSON = .object(["messageId": .string(messageId)])
        return try Self.job(try await host.call("POST", path(project) + "/tasks", body: body, timeout: 20))
    }

    /// Go / New thread / Just a note / Allow / No: `POST .../room/tasks/<id>`. A 409 carries its own sentence.
    public func act(project: String, jobId: String, action: RoomTaskAction, place: RoomTaskPlace? = nil, include: [String]? = nil) async throws -> RoomTask {
        let taskPath = path(project) + "/tasks/" + NativeHostClient.id(jobId)
        return try Self.job(try await host.call("POST", taskPath, body: action.body(place: place, include: include), timeout: 20))
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

    /// The stream sends the bare Task; a wrapped `{ task }` is read too.
    static func streamedJob(_ data: Data) -> RoomTask? {
        struct W: Decodable { var task: RoomTask }
        if let j = try? JSONDecoder().decode(RoomTask.self, from: data) { return j }
        return (try? JSONDecoder().decode(W.self, from: data))?.task
    }

    static func job(_ data: Data) throws -> RoomTask {
        struct R: Decodable { var task: RoomTask }
        do { return try JSONDecoder().decode(R.self, from: data).task } catch { throw NativeHostError.badResponse }
    }

    /// `GET .../room/stream`: `hello`, then a `post` per new post. Reconnects until iteration stops; a reconnect
    /// yields `.reconnected` first so the caller refetches `since` its last seq. An absent route ends the stream.
    public func events(
        project: String, minBackoff: Duration = .seconds(1), maxBackoff: Duration = .seconds(10),
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) -> AsyncStream<RoomStreamEvent> {
        let host = self.host
        let streamPath = path(project) + "/stream"
        return AsyncStream { continuation in
            let task = Task {
                var backoff = minBackoff
                var connectedBefore = false
                while !Task.isCancelled {
                    guard let token = host.tokenProvider() else {
                        try? await sleep(maxBackoff)
                        continue
                    }
                    let request = HTTPRequest(url: host.url(streamPath), headers: ["x-squeak-token": token], timeout: 90)
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
                            case "owner":
                                let j = NativeJSON.parse(frame.data)
                                continuation.yield(.owner(offline: j?["offline"]?.bool == true ? (j?["line"]?.string ?? "") : nil))
                            case "post":
                                if let data = frame.data.data(using: .utf8), let p = try? JSONDecoder().decode(RoomPost.self, from: data) {
                                    continuation.yield(.post(p))
                                }
                            case "turn":
                                if let data = frame.data.data(using: .utf8), let t = try? JSONDecoder().decode(RoomTurn.self, from: data) {
                                    continuation.yield(.turn(t))
                                }
                            case "task":
                                if let data = frame.data.data(using: .utf8), let j = Self.streamedJob(data) { continuation.yield(.task(j)) }
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
