import Foundation

/// A file a duck showed (the `show` tool): the host asks the window to open it as a tab and waits for an answer.
public struct ShowRequest: Sendable, Equatable {
    public var id: String
    public var sessionId: String
    public var projectId: String?
    /// The full path (the chat's folder + `relative`).
    public var path: String
    public var title: String?

    public init(id: String, sessionId: String, projectId: String?, path: String, title: String?) {
        self.id = id; self.sessionId = sessionId; self.projectId = projectId; self.path = path; self.title = title
    }

    /// One `event: open` frame's data; nil when it lacks an id, a chat or a path.
    static func parse(_ data: String) -> ShowRequest? {
        guard let json = try? JSONDecoder().decode(NativeJSON.self, from: Data(data.utf8)),
              let id = json["id"]?.string, let session = json["sessionId"]?.string, let path = json["path"]?.string,
              !id.isEmpty, !session.isEmpty, !path.isEmpty else { return nil }
        return ShowRequest(id: id, sessionId: session, projectId: json["projectId"]?.string, path: path, title: json["title"]?.string)
    }
}

/// Why the window did not open a shown file: said to the duck word for word.
public enum ShowOutcome: Equatable, Sendable {
    case opened
    case refused(String)
}

extension NativeHostClient {
    /// `GET /native/show-requests/stream`: every file a duck shows, whatever the window is on (a chat, a pond page, the
    /// Dashboard). Reconnects until iteration stops; the host answers "no window" while this is down.
    public func showRequests(
        minBackoff: Duration = .seconds(1), maxBackoff: Duration = .seconds(10),
        sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
    ) -> AsyncStream<ShowRequest> {
        let host = self
        return AsyncStream { continuation in
            let task = Task {
                var backoff = minBackoff
                while !Task.isCancelled {
                    guard let token = host.tokenProvider() else {
                        do { try await sleep(maxBackoff) } catch { break }  // a failed sleep (cancelled) stops, never spins
                        continue
                    }
                    let request = HTTPRequest(url: host.url("/native/show-requests/stream"), headers: ["x-squeak-token": token], timeout: 90)
                    var parser = SSEParser()
                    var absent = false
                    do {
                        for try await line in host.lineSource(request) {
                            guard let frame = parser.feed(line) else { continue }
                            backoff = minBackoff
                            if frame.event == "open", let r = ShowRequest.parse(frame.data) { continuation.yield(r) }
                        }
                    } catch where PondsClient.isAbsent(error) {
                        absent = true
                    } catch {}
                    if Task.isCancelled || absent { break }
                    do { try await sleep(backoff) } catch { break }  // was `try?`: a cancelled sleep looped forever
                    backoff = min(maxBackoff, backoff * 2)
                }
                continuation.finish()
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }

    /// Tells the host whether the window opened the file, so the duck is told the truth.
    public func ackShow(id: String, outcome: ShowOutcome) async {
        var body: [String: NativeJSON] = [:]
        switch outcome {
        case .opened: body["ok"] = .bool(true)
        case .refused(let why): body["ok"] = .bool(false); body["message"] = .string(why)
        }
        _ = try? await call("POST", "/native/show-requests/\(Self.id(id))/ack", body: .object(body), timeout: 8)
    }
}

/// Where a shown file opens: the tab id in its chat's strip, or why it can't.
public enum ShownFilePlan: Equatable, Sendable {
    /// `tab` is the path under the chat's folder, or the full path for a file outside it.
    case open(tab: String)
    case refuse(String)

    public static func make(path: String, cwd: String, exists: Bool) -> ShownFilePlan {
        let name = (path as NSString).lastPathComponent
        guard exists else { return .refuse("\(name) is not on disk where Squeak looked (\(path)).") }
        if let rel = PathRouting.inside(URL(fileURLWithPath: path), root: cwd), !rel.isEmpty { return .open(tab: rel) }
        return .open(tab: URL(fileURLWithPath: path).standardizedFileURL.path)
    }
}
