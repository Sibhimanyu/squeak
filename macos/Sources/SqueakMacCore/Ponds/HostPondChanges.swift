import Foundation

// `GET /native/projects/<id>/changes` (src/native/pond-changes.ts): every Duck's changed files in a Pond grouped by Duck
// and Stream (branch), plus Main's uncommitted changes. Decode-only: the host computes, the Mac draws.

/// One changed file in a group. Lenient: a host that adds or drops a key still decodes.
public struct HostChangeFile: Decodable, Sendable, Equatable, Identifiable {
    public var path: String
    /// "A", "M", "D" or "R".
    public var status: String
    public var added: Int
    public var removed: Int
    public var oldPath: String?
    public var untracked: Bool
    public var binary: Bool
    public var id: String { path }

    enum CodingKeys: String, CodingKey { case path, status, added, removed, oldPath, untracked, binary }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let p = c.lenient(String.self, .path), !p.isEmpty else { throw NativeHostError.badResponse }
        path = p
        let s = c.lenient(String.self, .status) ?? "M"
        status = ["A", "M", "D", "R"].contains(s) ? s : "M"
        added = max(0, c.lenient(Int.self, .added) ?? 0)
        removed = max(0, c.lenient(Int.self, .removed) ?? 0)
        oldPath = c.lenient(String.self, .oldPath)
        untracked = c.lenient(Bool.self, .untracked) ?? false
        binary = c.lenient(Bool.self, .binary) ?? false
    }
}

/// A group's files with its totals over every changed file (the list itself may be capped: `truncated`).
public struct HostChangeGroup: Decodable, Sendable, Equatable {
    public var files: [HostChangeFile]
    public var added: Int
    public var removed: Int
    /// Changed files in all, which can exceed `files.count` when `truncated`.
    public var fileCount: Int
    public var truncated: Bool
    /// The commit the diff is measured against; nil for plain uncommitted work.
    public var base: String?

    enum CodingKeys: String, CodingKey { case files, totals, truncated, base }
    enum TotalsKeys: String, CodingKey { case added, removed, files }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        files = (c.lenient([Failable<HostChangeFile>].self, .files) ?? []).compactMap(\.value)
        let t = try? c.nestedContainer(keyedBy: TotalsKeys.self, forKey: .totals)
        added = t?.lenient(Int.self, .added) ?? files.reduce(0) { $0 + $1.added }
        removed = t?.lenient(Int.self, .removed) ?? files.reduce(0) { $0 + $1.removed }
        fileCount = max(t?.lenient(Int.self, .files) ?? files.count, files.count)
        truncated = c.lenient(Bool.self, .truncated) ?? false
        base = c.lenient(String.self, .base)
    }
}

/// One Duck's changes on its Stream.
public struct HostDuckChanges: Decodable, Sendable, Equatable, Identifiable {
    public var duckId: String
    public var duckName: String
    public var colourSeed: String
    public var onDuty: Bool
    public var branch: String
    public var workspaceId: String
    public var changes: HostChangeGroup
    public var id: String { duckId }

    enum CodingKeys: String, CodingKey { case duckId, duckName, colourSeed, duty, branch, workspaceId }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        guard let id = c.lenient(String.self, .duckId), !id.isEmpty else { throw NativeHostError.badResponse }
        duckId = id
        duckName = c.lenient(String.self, .duckName) ?? "Duck"
        colourSeed = c.lenient(String.self, .colourSeed) ?? id
        onDuty = (c.lenient(String.self, .duty) ?? "on") != "off"
        branch = c.lenient(String.self, .branch) ?? ""
        workspaceId = c.lenient(String.self, .workspaceId) ?? ""
        changes = try HostChangeGroup(from: decoder)
    }
}

/// The Pond's main checkout: what is uncommitted there.
public struct HostMainChanges: Decodable, Sendable, Equatable {
    public var branch: String?
    public var changes: HostChangeGroup

    enum CodingKeys: String, CodingKey { case branch }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        branch = c.lenient(String.self, .branch)
        changes = try HostChangeGroup(from: decoder)
    }
}

public struct HostPondChanges: Decodable, Sendable, Equatable {
    public var projectId: String
    /// nil for a plain-folder Pond (no repository).
    public var main: HostMainChanges?
    public var ducks: [HostDuckChanges]
    /// More Ducks work in Streams than the host read.
    public var ducksTruncated: Bool

    enum CodingKeys: String, CodingKey { case projectId, main, ducks, ducksTruncated }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        projectId = c.lenient(String.self, .projectId) ?? ""
        main = c.lenient(HostMainChanges.self, .main)
        ducks = (c.lenient([Failable<HostDuckChanges>].self, .ducks) ?? []).compactMap(\.value)
        ducksTruncated = c.lenient(Bool.self, .ducksTruncated) ?? false
    }
}

extension NativeHostClient {
    /// A Pond's changes by Duck and Stream. nil when the host is older than the route (404).
    public func pondChanges(projectId: String) async throws -> HostPondChanges? {
        do {
            let data = try await call("GET", "/native/projects/\(Self.id(projectId))/changes", timeout: 20)
            return try JSONDecoder.native(HostPondChanges.self, data)
        } catch NativeHostError.http(404, _) { return nil }
    }
}
