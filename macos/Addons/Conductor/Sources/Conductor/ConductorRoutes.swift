import Foundation
import SqueakMacCore

extension DaemonClient {
    /// Whether Squeak is linked to Conductor, and whether it can be on this Mac.
    public func conductorLink() async throws -> ConductorLinkState? {
        let r = try await getControl("/control/conductor/link")
        if r.status == 404 || r.status == 503 { return nil }
        try Self.check(r.status)
        return try decode(ConductorLinkState.self, r.body)
    }

    /// Links or unlinks Conductor; the daemon answers with the state it ended in. Nil on an older daemon.
    public func setConductorLink(_ linked: Bool) async throws -> Bool? {
        let r = try await postControl("/control/conductor/link", body: Data(#"{"linked":\#(linked)}"#.utf8))
        if r.status == 404 || r.status == 503 { return nil }
        try Self.check(r.status)
        return try decode(ConductorLinkAnswer.self, r.body).linked ?? linked
    }

    /// Conductor's workspaces and which are picked. Nil on an older daemon.
    public func conductorWorkspaces() async throws -> ConductorWorkspaceList? {
        let r = try await getControl("/control/conductor/workspaces")
        if r.status == 404 || r.status == 503 { return nil }
        try Self.check(r.status)
        return try decode(ConductorWorkspaceList.self, r.body)
    }

    /// Picks or drops one workspace; the daemon answers with the whole list. Nil on an older daemon.
    public func setConductorWorkspace(id: String, picked: Bool) async throws -> ConductorWorkspaceList? {
        struct Body: Encodable { let id: String; let picked: Bool }
        let r = try await postControl("/control/conductor/workspaces", body: try JSONEncoder().encode(Body(id: id, picked: picked)))
        if r.status == 404 || r.status == 503 { return nil }
        try Self.check(r.status)
        return try decode(ConductorWorkspaceList.self, r.body)
    }
}

/// `GET /control/conductor/link`. Every field is optional on the wire: a missing one reads as false.
public struct ConductorLinkState: Decodable, Equatable, Sendable {
    public var linked: Bool
    public var available: Bool
    public var appInstalled: Bool

    public init(linked: Bool = false, available: Bool = false, appInstalled: Bool = false) {
        self.linked = linked
        self.available = available
        self.appInstalled = appInstalled
    }

    enum CodingKeys: String, CodingKey { case linked, available, appInstalled }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        linked = (try? c.decode(Bool.self, forKey: .linked)) ?? false
        available = (try? c.decode(Bool.self, forKey: .available)) ?? false
        appInstalled = (try? c.decode(Bool.self, forKey: .appInstalled)) ?? false
    }
}

/// `POST /control/conductor/link` → `{ok, linked}`.
struct ConductorLinkAnswer: Decodable {
    let linked: Bool?
    let ok: Bool?
}

/// One Conductor workspace as `GET /control/conductor/workspaces` lists it.
public struct ConductorWorkspaceItem: Decodable, Equatable, Sendable, Identifiable {
    public var id: String
    public var repo: String
    public var repoId: String?
    public var name: String
    public var branch: String?
    public var state: String?
    public var chats: Int
    public var lastActivityAt: String?
    public var picked: Bool
    public var isArchived: Bool { state == "archived" }

    public init(id: String, repo: String, repoId: String? = nil, name: String, branch: String? = nil, state: String? = nil,
                chats: Int = 0, lastActivityAt: String? = nil, picked: Bool = false) {
        self.id = id; self.repo = repo; self.repoId = repoId; self.name = name; self.branch = branch; self.state = state
        self.chats = chats; self.lastActivityAt = lastActivityAt; self.picked = picked
    }

    enum CodingKeys: String, CodingKey { case id, repo, repoId, name, branch, state, chats, lastActivityAt, picked }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        repo = (try? c.decode(String.self, forKey: .repo)) ?? ""
        repoId = try? c.decode(String.self, forKey: .repoId)
        name = (try? c.decode(String.self, forKey: .name)) ?? id
        branch = try? c.decode(String.self, forKey: .branch)
        state = try? c.decode(String.self, forKey: .state)
        chats = (try? c.decode(Int.self, forKey: .chats)) ?? 0
        lastActivityAt = try? c.decode(String.self, forKey: .lastActivityAt)
        picked = (try? c.decode(Bool.self, forKey: .picked)) ?? false
    }
}

/// `{ linked, workspaces }`, newest first.
public struct ConductorWorkspaceList: Decodable, Equatable, Sendable {
    public var linked: Bool
    public var workspaces: [ConductorWorkspaceItem]

    public init(linked: Bool = false, workspaces: [ConductorWorkspaceItem] = []) {
        self.linked = linked; self.workspaces = workspaces
    }

    enum CodingKeys: String, CodingKey { case linked, workspaces }

    public init(from decoder: any Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        linked = (try? c.decode(Bool.self, forKey: .linked)) ?? false
        workspaces = (try? c.decode([LossyItem<ConductorWorkspaceItem>].self, forKey: .workspaces))?.compactMap(\.value) ?? []
    }
}

/// One element of a list that decodes to nil instead of failing the whole list.
struct LossyItem<T: Decodable>: Decodable {
    let value: T?
    init(from decoder: any Decoder) throws { value = try? T(from: decoder) }
}
