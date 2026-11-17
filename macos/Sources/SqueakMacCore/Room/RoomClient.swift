import Foundation

public enum RoomStreamEvent: Sendable, Equatable {
    case hello(latestSeq: Int)
    case post(RoomPost)
    /// A turn started or changed (room v2): upsert by id.
    case turn(RoomTurn)
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
