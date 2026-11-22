import Foundation

// Artifacts of a remote pond: the owner's outputs (never code), asked of the owner's Mac through the pond and cached here.
// docs/ponds.md, "Artifacts across Macs". The routes: `POST|GET /native/ponds/<id>/artifacts` for the list and
// `POST|GET /native/ponds/<id>/artifacts/fetch` for one file. Asking answers at once with a request id; reading answers
// `{ ready, ... }` until the owner's Mac has written its answer. Rows carry a wire id in `path`, never a path.

/// One file the owner's Mac sent, cached on this Mac (`path` is the local copy).
public struct RemoteArtifactFile: Sendable, Equatable {
    public var path: String
    public var name: String
    public var kind: ArtifactKind
    public var size: Int64
    public var ownerName: String?
}

public enum RemoteArtifactsAnswer: Sendable, Equatable {
    /// The owner's Mac has not answered yet.
    case pending
    case items([ArtifactItem], ownerName: String?)
    /// The owner's Mac said no, in a sentence.
    case refused(String)
}

public enum RemoteFileAnswer: Sendable, Equatable {
    /// Not here yet; `progress` is the share of the file already downloaded (0 to 1) once it is on its way.
    case pending(progress: Double?)
    case failed(String)
    case ready(RemoteArtifactFile)
}

private struct RemoteArtifactsReply: Decodable {
    var ready: Bool
    var requestId: String?
    var error: String?
    var ownerName: String?
    var items: [ArtifactItem]

    enum CodingKeys: String, CodingKey { case ready, requestId, error, result, ownerName }
    enum ResultKeys: String, CodingKey { case items, ownerName }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ready = c.lenient(Bool.self, .ready) ?? false
        requestId = c.lenient(String.self, .requestId)
        error = c.lenient(String.self, .error)
        ownerName = c.lenient(String.self, .ownerName)
        var rows: [ArtifactItem] = []
        if let r = try? c.nestedContainer(keyedBy: ResultKeys.self, forKey: .result) {
            rows = (r.lenient([Failable<ArtifactItem>].self, .items) ?? []).compactMap(\.value)
            ownerName = ownerName ?? r.lenient(String.self, .ownerName)
        }
        items = rows
    }
}

private struct RemoteFileReply: Decodable {
    var ready: Bool
    var error: String?
    var have: Int?
    var total: Int?
    var file: RemoteArtifactFile?

    enum CodingKeys: String, CodingKey { case ready, error, progress, file }
    enum ProgressKeys: String, CodingKey { case have, total }
    enum FileKeys: String, CodingKey { case path, name, kind, size, ownerName }
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        ready = c.lenient(Bool.self, .ready) ?? false
        error = c.lenient(String.self, .error)
        if let p = try? c.nestedContainer(keyedBy: ProgressKeys.self, forKey: .progress) {
            have = p.lenient(Int.self, .have); total = p.lenient(Int.self, .total)
        }
        if let f = try? c.nestedContainer(keyedBy: FileKeys.self, forKey: .file), let path = f.lenient(String.self, .path) {
            file = RemoteArtifactFile(
                path: path, name: f.lenient(String.self, .name) ?? (path as NSString).lastPathComponent,
                kind: ArtifactKind(wire: f.lenient(String.self, .kind)), size: f.lenient(Int64.self, .size) ?? 0,
                ownerName: f.lenient(String.self, .ownerName))
        }
    }
}

extension PondsClient {
    private static func artifactsPath(_ pond: String) -> String { "/native/ponds/\(NativeHostClient.id(pond))/artifacts" }

    /// Asks the owner's Mac for its artifacts; the request id to read the answer with.
    public func askArtifacts(pond: String) async throws -> String {
        let r = try decode(RemoteArtifactsReply.self, try await host.call("POST", Self.artifactsPath(pond), body: .object([:]), timeout: 30))
        guard let id = r.requestId else { throw NativeHostError.badResponse }
        return id
    }

    public func artifacts(pond: String, request: String) async throws -> RemoteArtifactsAnswer {
        let r = try decode(RemoteArtifactsReply.self, try await host.call("GET", "\(Self.artifactsPath(pond))?request=\(NativeHostClient.id(request))"))
        if let e = r.error { return .refused(e) }
        return r.ready ? .items(r.items, ownerName: r.ownerName) : .pending
    }

    /// Asks the owner's Mac for one file by the id its list gave; the request id to read it with.
    public func askArtifactFile(pond: String, id: String) async throws -> String {
        let r = try decode(RemoteArtifactsReply.self, try await host.call("POST", "\(Self.artifactsPath(pond))/fetch", body: .object(["path": .string(id)]), timeout: 30))
        guard let request = r.requestId else { throw NativeHostError.badResponse }
        return request
    }

    /// Reading downloads the file's pieces on the host (a few seconds each time) and answers with the cached copy once whole.
    public func artifactFile(pond: String, request: String) async throws -> RemoteFileAnswer {
        let r = try decode(RemoteFileReply.self, try await host.call("GET", "\(Self.artifactsPath(pond))/fetch?request=\(NativeHostClient.id(request))", timeout: 30))
        if let e = r.error { return .failed(e) }
        if r.ready, let file = r.file { return .ready(file) }
        let progress = r.total.flatMap { $0 > 0 ? Double(r.have ?? 0) / Double($0) : nil }
        return .pending(progress: progress)
    }
}

/// How the tab and the viewer wait for the owner's Mac, and what they say. Pure; the views draw it.
public enum RemoteArtifacts {
    /// The owner's Mac answers within seconds when it is awake and online; past this it is not.
    public static let listWait: TimeInterval = 25
    public static let pollEvery: TimeInterval = 1.2
    /// A file is fetched in pieces; this is the longest the viewer waits without the last piece arriving.
    public static let fileWait: TimeInterval = 300

    /// "From Sibhi's Mac", the header's line.
    public static func fromLine(_ ownerMac: String) -> String { "From \(ownerMac)" }

    public static func offline(_ ownerMac: String) -> String {
        "\(ownerMac) didn\u{2019}t answer. It may be asleep or offline; try again when it is back."
    }

    public static func downloading(_ progress: Double?) -> String {
        guard let p = progress, p > 0 else { return "Asking \u{2026}" }
        return "Downloading \(Int((min(p, 1) * 100).rounded()))%"
    }

    /// Asks, then reads until the owner's Mac answers or `wait` passes (`.pending` then). `sleep` is injected for tests.
    public static func waitForList(
        _ client: PondsClient, pond: String, wait: TimeInterval = listWait, every: TimeInterval = pollEvery,
        sleep: @Sendable (TimeInterval) async -> Void = { try? await Task.sleep(for: .seconds($0)) }
    ) async throws -> RemoteArtifactsAnswer {
        let request = try await client.askArtifacts(pond: pond)
        var waited: TimeInterval = 0
        while !Task.isCancelled {
            let answer = try await client.artifacts(pond: pond, request: request)
            if answer != .pending { return answer }
            if waited >= wait { return .pending }
            await sleep(every); waited += every
        }
        throw CancellationError()
    }

    /// Asks for one file and reads until it is whole, refused, or no piece has moved for `wait`. `progress` reports 0...1.
    public static func waitForFile(
        _ client: PondsClient, pond: String, id: String, wait: TimeInterval = fileWait, every: TimeInterval = pollEvery,
        progress: @Sendable (Double?) -> Void = { _ in },
        sleep: @Sendable (TimeInterval) async -> Void = { try? await Task.sleep(for: .seconds($0)) }
    ) async throws -> RemoteFileAnswer {
        let request = try await client.askArtifactFile(pond: pond, id: id)
        var idle: TimeInterval = 0
        var best = -1.0
        while !Task.isCancelled {
            let answer = try await client.artifactFile(pond: pond, request: request)
            switch answer {
            case .pending(let p):
                progress(p)
                if (p ?? 0) > best { best = p ?? 0; idle = 0 }
                if idle >= wait { return .pending(progress: p) }
            default: return answer
            }
            await sleep(every); idle += every
        }
        throw CancellationError()
    }
}
