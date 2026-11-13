import Foundation

/// `GET /native/directory`: the one list of ponds. The Mac draws it as sent: pond rows in its order, the Other group
/// from `other`, each native thread under its pond by `threads`. Nothing here matches a pond by name.
public struct PondDirectory: Sendable, Equatable, Decodable {
    public struct Member: Sendable, Equatable, Decodable { public var name: String; public var online: Bool }
    public struct Stream: Sendable, Equatable, Decodable, Identifiable {
        public var id: String
        public var name: String
        public var branch: String?
    }
    public struct Counts: Sendable, Equatable, Decodable {
        public var threads: Int; public var needsYou: Int; public var working: Int
        public init(threads: Int = 0, needsYou: Int = 0, working: Int = 0) { self.threads = threads; self.needsYou = needsYou; self.working = working }
    }
    public struct Pond: Sendable, Equatable, Decodable, Identifiable {
        /// The project id; for a joined pond its own pond id. The only key for a pond.
        public var id: String
        /// `project` or `joined`.
        public var kind: String
        public var name: String
        public var projectId: String?
        /// The pond record behind it (invites, members, relay); nil = no record yet.
        public var pondId: String?
        public var shared: Bool
        public var members: [Member]
        public var hidden: Bool
        public var colour: String?
        public var labels: [String]
        public var lastActivityAt: String?
        public var streams: [Stream]
        public var archivedStreams: Int
        public var counts: Counts
        public var folder: String?

        public var isJoined: Bool { kind == "joined" }

        enum CodingKeys: String, CodingKey {
            case id, kind, name, projectId, pondId, shared, members, hidden, colour, labels, lastActivityAt, streams, archivedStreams, counts, folder
        }

        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            id = try c.decode(String.self, forKey: .id)
            kind = (try? c.decode(String.self, forKey: .kind)) ?? "project"
            name = try c.decode(String.self, forKey: .name)
            projectId = try? c.decode(String.self, forKey: .projectId)
            pondId = try? c.decode(String.self, forKey: .pondId)
            shared = (try? c.decode(Bool.self, forKey: .shared)) ?? false
            members = (try? c.decode([Member].self, forKey: .members)) ?? []
            hidden = (try? c.decode(Bool.self, forKey: .hidden)) ?? false
            colour = try? c.decode(String.self, forKey: .colour)
            labels = (try? c.decode([String].self, forKey: .labels)) ?? []
            lastActivityAt = try? c.decode(String.self, forKey: .lastActivityAt)
            streams = (try? c.decode([Stream].self, forKey: .streams)) ?? []
            archivedStreams = (try? c.decode(Int.self, forKey: .archivedStreams)) ?? 0
            counts = (try? c.decode(Counts.self, forKey: .counts)) ?? Counts()
            folder = try? c.decode(String.self, forKey: .folder)
        }

        public init(id: String, kind: String = "project", name: String, projectId: String? = nil, pondId: String? = nil, shared: Bool = false,
                    hidden: Bool = false, labels: [String] = [], streams: [Stream] = [], folder: String? = nil) {
            self.id = id; self.kind = kind; self.name = name; self.projectId = projectId; self.pondId = pondId; self.shared = shared
            self.members = []; self.hidden = hidden; self.colour = nil; self.labels = labels; self.lastActivityAt = nil
            self.streams = streams; self.archivedStreams = 0; self.counts = Counts(); self.folder = folder
        }
    }

    public struct Order: Sendable, Equatable, Decodable {
        public var mode: PondOrderMode
        public var ids: [String]
        public init(mode: PondOrderMode = .recent, ids: [String] = []) { self.mode = mode; self.ids = ids }
        public init(from decoder: Decoder) throws {
            let c = try decoder.container(keyedBy: CodingKeys.self)
            mode = (try? c.decode(PondOrderMode.self, forKey: .mode)) ?? .recent
            ids = (try? c.decode([String].self, forKey: .ids)) ?? []
        }
        enum CodingKeys: String, CodingKey { case mode, ids }
    }

    public var schema: Int
    /// In the host's order (newest first, or the person's own); hidden ponds included, flagged.
    public var ponds: [Pond]
    public var order: Order
    /// Native threads by session key: the pond's id, or nil for Other.
    public var threads: [String: String?]
    public var other: [String]

    public init(schema: Int = 1, ponds: [Pond] = [], order: Order = Order(), threads: [String: String?] = [:], other: [String] = []) {
        self.schema = schema; self.ponds = ponds; self.order = order; self.threads = threads; self.other = other
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        schema = (try? c.decode(Int.self, forKey: .schema)) ?? 1
        ponds = (try? c.decode([Pond].self, forKey: .ponds)) ?? []
        order = (try? c.decode(Order.self, forKey: .order)) ?? Order()
        threads = (try? c.decode([String: String?].self, forKey: .threads)) ?? [:]
        other = (try? c.decode([String].self, forKey: .other)) ?? []
    }
    enum CodingKeys: String, CodingKey { case schema, ponds, order, threads, other }

    public func pond(id: String) -> Pond? { ponds.first { $0.id == id } }
    public func pond(projectId: String) -> Pond? { ponds.first { $0.projectId == projectId } }
    public func pond(pondId: String) -> Pond? { ponds.first { $0.pondId == pondId } }

    /// The pond a thread sits under: the directory's word (`threads`), nil = Other. A thread the host does not place
    /// (a terminal, Claude or Codex chat: the host sees native chats only) is placed by its folder inside a pond's
    /// folder (the longest folder wins), never by a name.
    /// The daemon's own placement (`pondId` on its `/state` session: one function for every surface, worktrees included)
    /// wins; the folder rule below is only for a daemon too old to send it.
    public func place(sessionKey: String, cwd: String?, pondId: String? = nil) -> String? {
        if let pondId, !pondId.isEmpty { return pondId }
        if let placed = threads[sessionKey] { return placed }
        guard let cwd, !cwd.isEmpty else { return nil }
        var best: (id: String, length: Int)?
        for p in ponds {
            guard let folder = p.folder, !folder.isEmpty else { continue }
            let root = folder.hasSuffix("/") ? String(folder.dropLast()) : folder
            if (cwd == root || cwd.hasPrefix(root + "/")), root.count > (best?.length ?? -1) { best = (p.id, root.count) }
        }
        return best?.id
    }
}
