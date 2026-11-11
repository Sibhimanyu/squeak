import Foundation

// DESIGN.md §8.10, the Files tab's file management: new file/folder, rename, move, Trash, copy in from Finder.
// The rules (names, protected paths, clash naming, how an open tab follows a rename) are pure; the few functions
// that touch the disk prove every path stays inside the workspace root first, symlinks included.

public struct FileOpError: Error, Equatable, Sendable {
    public var message: String
    public init(_ message: String) { self.message = message }
}

/// What a person types as a name.
public enum FileNameRule {
    /// A calm sentence when the name cannot be used, nil when it can. `siblings` are the names already in the target
    /// folder (compared without regard to case, as the Mac's disk does); `renaming` is the item's own current name,
    /// which is not a clash with itself.
    public static func validate(_ raw: String, siblings: Set<String>, renaming: String? = nil) -> String? {
        let name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty { return "Give it a name." }
        if name.contains("/") || name.contains("\0") { return "A name can't contain a slash." }
        if name == "." || name == ".." { return "That name isn't allowed." }
        if name.lowercased() == ".git" { return "That name is reserved for git." }
        if name.utf8.count > 255 { return "That name is too long." }
        let lower = name.lowercased()
        let own = renaming?.lowercased()
        if lower != own, siblings.contains(where: { $0.lowercased() == lower }) { return "\(name) already exists here." }
        return nil
    }

    public static func clean(_ raw: String) -> String { raw.trimmingCharacters(in: .whitespacesAndNewlines) }
}

public enum PathMap {
    /// Where `path` is after `from` (a file or a folder) became `to`; unchanged when `from` does not hold it.
    public static func remap(_ path: String, from: String, to: String) -> String {
        if path == from { return to }
        if path.hasPrefix(from + "/") { return to + String(path.dropFirst(from.count)) }
        return path
    }

    /// True when `path` is `base` or sits inside it.
    public static func isInside(_ path: String, of base: String) -> Bool {
        path == base || path.hasPrefix(base + "/")
    }

    /// The open paths a change to `base` touches.
    public static func affected(_ open: [String], by base: String) -> [String] { open.filter { isInside($0, of: base) } }
}

public enum FileOps {
    /// Why a path may never be moved, renamed or deleted: the workspace root, and `.git` with everything in it.
    public static func protectedReason(_ relative: String) -> String? {
        if relative.isEmpty { return "The stream's folder itself can't be changed from here." }
        if relative.split(separator: "/").contains(".git") { return "git's own folder is left alone." }
        return nil
    }

    public static func join(_ parent: String, _ name: String) -> String { parent.isEmpty ? name : parent + "/" + name }

    /// "a.txt" -> "a copy.txt" -> "a copy 2.txt" (a folder or a name without an extension: "a copy").
    public static func uniqueName(_ name: String, taken: Set<String>) -> String {
        let lowered = Set(taken.map { $0.lowercased() })
        if !lowered.contains(name.lowercased()) { return name }
        let ns = name as NSString
        let ext = ns.pathExtension
        let stem = ext.isEmpty || ns.deletingPathExtension.isEmpty ? name : ns.deletingPathExtension
        let suffix = stem == name ? "" : "." + ext
        var n = 1
        while true {
            let candidate = (n == 1 ? "\(stem) copy" : "\(stem) copy \(n)") + suffix
            if !lowered.contains(candidate.lowercased()) { return candidate }
            n += 1
        }
    }

    /// A move that makes no sense: into itself, or onto where it already is. nil when it is fine.
    public static func checkMove(from: String, toParent: String) -> String? {
        if let why = protectedReason(from) { return why }
        if let why = protectedReason(toParent.isEmpty ? "x" : toParent) { return why }
        if PathMap.isInside(toParent, of: from) { return "A folder can't go inside itself." }
        if FileTree.parent(of: from) == toParent { return "It is already in that folder." }
        return nil
    }

    // MARK: Disk

    /// The URL of an existing-or-new item with the final component left unresolved, so a symlink is handled as
    /// itself and never followed. The folder above it must resolve inside the root.
    public static func itemURL(root: String, relative: String) -> URL? {
        guard !relative.isEmpty else { return nil }
        guard let dir = FileDisk.resolve(root: root, relative: FileTree.parent(of: relative)) else { return nil }
        let last = relative.split(separator: "/").last.map(String.init) ?? relative
        guard last != "..", last != "." else { return nil }
        return dir.appendingPathComponent(last)
    }

    private static func exists(_ url: URL) -> Bool {
        var st = stat()
        return lstat(url.path, &st) == 0
    }

    private static func names(in dir: URL) -> Set<String> {
        Set((try? FileManager.default.contentsOfDirectory(atPath: dir.path)) ?? [])
    }

    /// Makes an empty file or a folder; returns its relative path.
    public static func create(root: String, parent: String, name raw: String, isFolder: Bool) -> Result<String, FileOpError> {
        if let why = protectedReason(parent.isEmpty ? "x" : parent) { return .failure(FileOpError(why)) }
        guard let dir = FileDisk.resolve(root: root, relative: parent) else { return .failure(FileOpError("That folder is outside the stream.")) }
        if let why = FileNameRule.validate(raw, siblings: names(in: dir)) { return .failure(FileOpError(why)) }
        let name = FileNameRule.clean(raw)
        let url = dir.appendingPathComponent(name)
        do {
            if isFolder { try FileManager.default.createDirectory(at: url, withIntermediateDirectories: false) } else {
                guard FileManager.default.createFile(atPath: url.path, contents: Data()) else { throw CocoaError(.fileWriteUnknown) }
            }
        } catch { return .failure(FileOpError("Squeak couldn't make \(name).")) }
        return .success(join(parent, name))
    }

    /// Renames or moves `from` into `toParent` as `newName`; returns the new relative path.
    public static func move(root: String, from: String, toParent: String, newName raw: String) -> Result<String, FileOpError> {
        if let why = protectedReason(from) { return .failure(FileOpError(why)) }
        if let why = protectedReason(toParent.isEmpty ? "x" : toParent) { return .failure(FileOpError(why)) }
        if PathMap.isInside(toParent, of: from) { return .failure(FileOpError("A folder can't go inside itself.")) }
        guard let src = itemURL(root: root, relative: from), exists(src) else { return .failure(FileOpError("That item is gone.")) }
        guard let dir = FileDisk.resolve(root: root, relative: toParent) else { return .failure(FileOpError("That folder is outside the stream.")) }
        let ownName = src.lastPathComponent
        let sameFolder = FileTree.parent(of: from) == toParent
        if let why = FileNameRule.validate(raw, siblings: names(in: dir), renaming: sameFolder ? ownName : nil) {
            return .failure(FileOpError(why))
        }
        let name = FileNameRule.clean(raw)
        let dst = dir.appendingPathComponent(name)
        if name == ownName && sameFolder { return .success(from) }
        do { try FileManager.default.moveItem(at: src, to: dst) } catch { return .failure(FileOpError("Squeak couldn't move \(ownName).")) }
        return .success(join(toParent, name))
    }

    /// Moves the item to the Trash, never deletes it.
    public static func trash(root: String, path: String) -> Result<Bool, FileOpError> {
        if let why = protectedReason(path) { return .failure(FileOpError(why)) }
        guard let url = itemURL(root: root, relative: path), exists(url) else { return .failure(FileOpError("That item is gone.")) }
        do { try FileManager.default.trashItem(at: url, resultingItemURL: nil) } catch {
            return .failure(FileOpError("Squeak couldn't move \(url.lastPathComponent) to the Trash."))
        }
        return .success(true)
    }

    /// How many files and folders a folder holds (capped, so a giant tree answers quickly); 0 for a file.
    public static func countItems(root: String, path: String, cap: Int = 100_000) -> Int {
        guard let url = itemURL(root: root, relative: path),
              (try? url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey]))?.isDirectory == true,
              let walker = FileManager.default.enumerator(at: url, includingPropertiesForKeys: nil) else { return 0 }
        var n = 0
        for _ in walker { n += 1; if n >= cap { break } }
        return n
    }

    /// Copies files dropped from Finder into a folder: never over an existing name (" copy" is added). Returns the
    /// new relative paths; a source that cannot be copied stops the rest with a sentence.
    public static func copyIn(root: String, sources: [URL], toParent: String) -> Result<[String], FileOpError> {
        if let why = protectedReason(toParent.isEmpty ? "x" : toParent) { return .failure(FileOpError(why)) }
        guard let dir = FileDisk.resolve(root: root, relative: toParent) else { return .failure(FileOpError("That folder is outside the stream.")) }
        var out: [String] = []
        var taken = names(in: dir)
        for src in sources where src.isFileURL {
            let source = src.standardizedFileURL
            let target = dir.standardizedFileURL.path
            if target == source.path || target.hasPrefix(source.path + "/") { return .failure(FileOpError("A folder can't be copied into itself.")) }
            guard exists(source) else { return .failure(FileOpError("\(source.lastPathComponent) is gone.")) }
            let name = uniqueName(source.lastPathComponent, taken: taken)
            do { try FileManager.default.copyItem(at: source, to: dir.appendingPathComponent(name)) } catch {
                return .failure(FileOpError("Squeak couldn't copy \(source.lastPathComponent)."))
            }
            taken.insert(name)
            out.append(join(toParent, name))
        }
        return .success(out)
    }
}
