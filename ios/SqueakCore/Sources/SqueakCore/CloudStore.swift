import Foundation

/// One child of a listed collection.
public struct CloudListing: Equatable, Sendable {
    public let id: String
    public let doc: ChannelDocument
    public init(id: String, doc: ChannelDocument) { self.id = id; self.doc = doc }
}

/// The five operations every cloud store has (docs/cloud-layer.md, "What a store is"): `get`, `set`, `delete`,
/// `list` and `watch`, on top of the change streams the channel already reads (`ChannelBackend`). The
/// Realtime Database (`RealtimeDatabaseClient`) and Catalyst (`CatalystClient`) are the two stores.
public protocol CloudStore: ChannelBackend {
    /// The direct children of `collection` (`channels/<id>/<kind>`).
    func list(_ collection: String) async throws -> [CloudListing]
    /// Calls `onChange` when anything under `path` may have changed (never with data: re-read through the
    /// store). Returns the function that stops it.
    func watch(_ path: String, _ onChange: @escaping @Sendable () -> Void) -> @Sendable () -> Void
}

extension CloudStore {
    public func watch(_ path: String, _ onChange: @escaping @Sendable () -> Void) -> @Sendable () -> Void {
        guard let changes = changes(path) else { return {} }
        let task = Task { for await _ in changes { onChange() } }
        return { task.cancel() }
    }
}

extension RealtimeDatabaseClient: CloudStore {
    public func list(_ collection: String) async throws -> [CloudListing] {
        var request = URLRequest(url: url(collection))
        request.httpMethod = "GET"
        request.timeoutInterval = 15
        let (data, response) = try await transport.data(for: request)
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else { throw Failure.http(status) }
        guard let children = try JSONSerialization.jsonObject(with: data, options: .fragmentsAllowed) as? [String: Any] else { return [] }
        return children.keys.sorted().compactMap { name in
            (children[name] as? [String: Any]).flatMap(Self.decoded).map { CloudListing(id: name, doc: $0) }
        }
    }
}
