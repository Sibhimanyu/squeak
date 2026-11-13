import Foundation

// Disk clean-up (`GET/POST /native/disk-cleanup`, `POST /native/workspaces/<id>/delete-branch`): what Squeak left on
// disk, listed with sizes, and removed only as selected. The host decides what is safe; this file only draws it.

public struct CleanupItem: Sendable, Equatable, Decodable, Identifiable {
    public var id: String
    /// untracked-folder, stale-worktree, archived-folder, merged-branch or live-stream.
    public var kind: String
    public var pondId: String?
    public var pondName: String?
    public var path: String?
    public var branch: String?
    public var sizeBytes: Int64?
    public var modifiedAt: String?
    public var unsavedWork: Bool
    public var unsavedReason: String?
    public var preselected: Bool
    public var registered: Bool
    public var label: String

    public init(
        id: String, kind: String, pondId: String? = nil, pondName: String? = nil, path: String? = nil, branch: String? = nil,
        sizeBytes: Int64? = nil, modifiedAt: String? = nil, unsavedWork: Bool = false, unsavedReason: String? = nil,
        preselected: Bool = true, registered: Bool = false, label: String = ""
    ) {
        self.id = id; self.kind = kind; self.pondId = pondId; self.pondName = pondName; self.path = path; self.branch = branch
        self.sizeBytes = sizeBytes; self.modifiedAt = modifiedAt; self.unsavedWork = unsavedWork
        self.unsavedReason = unsavedReason; self.preselected = preselected; self.registered = registered; self.label = label
    }
}

public struct CleanupScan: Sendable, Equatable, Decodable {
    public var items: [CleanupItem]
    public var reclaimableBytes: Int64
    public var scannedAt: String
    public init(items: [CleanupItem], reclaimableBytes: Int64, scannedAt: String) {
        self.items = items; self.reclaimableBytes = reclaimableBytes; self.scannedAt = scannedAt
    }
}

public struct CleanupResult: Sendable, Equatable, Decodable {
    public var removedFolders: Int
    public var removedBranches: Int
    public var freedBytes: Int64
    public var failed: Int
}

public struct BranchDeleteResult: Sendable, Equatable, Decodable {
    public var deleted: Bool
    public var remoteDeleted: Bool
    public var note: String?
}

/// What the archive route says: the workspace, and whether its branch is merged and can be offered for deletion.
public struct ArchiveOutcome: Sendable, Equatable, Decodable {
    public var workspace: NativeWorkspace
    public var branchDeletable: Bool
    public var branch: String?

    private enum CodingKeys: String, CodingKey { case workspace, branchDeletable, branch }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        workspace = try c.decode(NativeWorkspace.self, forKey: .workspace)
        branchDeletable = (try? c.decode(Bool.self, forKey: .branchDeletable)) ?? false   // an older host says nothing
        branch = try? c.decode(String.self, forKey: .branch)
    }
}

extension NativeHostClient {
    public func diskCleanupScan(pondId: String? = nil) async throws -> CleanupScan {
        let q = pondId.map { "?pond=\(Self.id($0))" } ?? ""
        return try JSONDecoder.native(CleanupScan.self, try await call("GET", "/native/disk-cleanup\(q)", timeout: 600))
    }

    /// Exactly these items; `confirmUnsaved` ids are the ones with unsaved work the person ticked on purpose.
    public func diskCleanup(ids: [String], confirmUnsaved: Set<String>, pondId: String? = nil, alsoOnGitHub: Bool = false) async throws -> CleanupResult {
        let items: [NativeJSON] = ids.map { .object(["id": .string($0), "confirmUnsaved": .bool(confirmUnsaved.contains($0))]) }
        let q = pondId.map { "?pond=\(Self.id($0))" } ?? ""
        let body: NativeJSON = .object(["items": .array(items), "alsoOnGitHub": .bool(alsoOnGitHub)])
        return try JSONDecoder.native(CleanupResult.self, try await call("POST", "/native/disk-cleanup\(q)", body: body, timeout: 900, maybeSent: true))
    }

    /// An archived stream's merged branch. The host refuses (409) anything not merged.
    public func deleteBranch(workspaceId: String, alsoOnGitHub: Bool) async throws -> BranchDeleteResult {
        let body: NativeJSON = .object(["alsoOnGitHub": .bool(alsoOnGitHub)])
        return try JSONDecoder.native(
            BranchDeleteResult.self, try await call("POST", "/native/workspaces/\(Self.id(workspaceId))/delete-branch", body: body, timeout: 60))
    }

    public func archiveReportingBranch(workspaceId: String, force: Bool = false) async throws -> ArchiveOutcome {
        let body: NativeJSON = .object(force ? ["force": .bool(true)] : [:])
        return try JSONDecoder.native(
            ArchiveOutcome.self, try await call("POST", "/native/workspaces/\(Self.id(workspaceId))/archive", body: body, timeout: 60))
    }

    /// Remove from Squeak and also clean its streams' folders the same way as Clean up disk (safe ones only).
    public func removeProject(projectId: String, cleaningStreams: Bool) async throws -> CleanupResult? {
        let data = try await call("DELETE", "/native/projects/\(Self.id(projectId))\(cleaningStreams ? "?cleanup=1" : "")", timeout: cleaningStreams ? 900 : 15)
        struct Reply: Decodable { var cleanup: CleanupResult? }
        return (try? JSONDecoder().decode(Reply.self, from: data))?.cleanup
    }
}

// MARK: Pure logic

public enum DiskCleanupLogic {
    public struct Group: Equatable, Identifiable, Sendable {
        public var id: String
        public var title: String
        public var detail: String
        public var items: [CleanupItem]
    }

    /// The four groups, in the order shown; an empty one is left out.
    public static func groups(_ items: [CleanupItem]) -> [Group] {
        let defs: [(String, String, String, Set<String>)] = [
            ("untracked", "Not tracked by Squeak", "Folders in your Squeak workspaces that no stream owns.", ["untracked-folder"]),
            ("archived", "Archived streams", "Folders of archived streams that are still on disk.", ["archived-folder", "live-stream"]),
            ("stale", "Worktrees git still lists", "Entries for folders that are gone. Removing them frees no space.", ["stale-worktree"]),
            ("branches", "Merged branches", "Branches of archived streams, already merged. The commits are safe in the target branch.", ["merged-branch"]),
        ]
        return defs.compactMap { id, title, detail, kinds in
            let list = items.filter { kinds.contains($0.kind) }
            return list.isEmpty ? nil : Group(id: id, title: title, detail: detail, items: list)
        }
    }

    public static func initialSelection(_ items: [CleanupItem]) -> Set<String> {
        Set(items.filter { $0.preselected && !$0.unsavedWork }.map(\.id))
    }

    public static func bytes(_ items: [CleanupItem], in selection: Set<String>) -> Int64 {
        items.filter { selection.contains($0.id) }.reduce(0) { $0 + ($1.sizeBytes ?? 0) }
    }

    public static func size(_ bytes: Int64?) -> String {
        guard let bytes else { return "size unknown" }
        let f = ByteCountFormatter()
        f.countStyle = .file
        return f.string(fromByteCount: bytes)
    }

    private static func plural(_ n: Int, _ one: String, _ many: String) -> String { n == 1 ? "1 \(one)" : "\(n) \(many)" }

    /// "Move 11 folders (44 GB) to the Trash and delete 6 merged branches?"
    public static func confirmation(_ items: [CleanupItem], in selection: Set<String>) -> String {
        let chosen = items.filter { selection.contains($0.id) }
        let folders = chosen.filter { $0.path != nil && $0.kind != "stale-worktree" }
        let stale = chosen.filter { $0.kind == "stale-worktree" }.count
        let branches = chosen.filter { $0.kind == "merged-branch" }.count
        var parts: [String] = []
        if !folders.isEmpty {
            parts.append("Move \(plural(folders.count, "folder", "folders")) (\(size(bytes(folders, in: Set(folders.map(\.id)))))) to the Trash")
        }
        if stale > 0 { parts.append("\(parts.isEmpty ? "Forget" : "forget") \(plural(stale, "stale worktree", "stale worktrees"))") }
        if branches > 0 { parts.append("\(parts.isEmpty ? "Delete" : "delete") \(plural(branches, "merged branch", "merged branches"))") }
        return parts.isEmpty ? "Nothing selected." : parts.joined(separator: " and ") + "?"
    }

    public static func resultLine(_ r: CleanupResult) -> String {
        var parts: [String] = []
        if r.removedFolders > 0 { parts.append("Moved \(plural(r.removedFolders, "folder", "folders")) to the Trash, freeing \(size(r.freedBytes))") }
        if r.removedBranches > 0 { parts.append("deleted \(plural(r.removedBranches, "branch", "branches"))") }
        var line = parts.isEmpty ? "Nothing was removed" : parts.joined(separator: ", ")
        if r.failed > 0 { line += ". \(plural(r.failed, "item", "items")) could not be removed" }
        return line + "."
    }

    /// The archive offer's wording.
    public static func branchOffer(_ branch: String) -> String { "Branch \(branch) is merged. Delete it?" }
}
