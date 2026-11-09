import Foundation

// DESIGN.md §8.10, the Files tab and its viewer: what a file is, how it is read, and when a save must be refused.
// Everything is relative to one workspace root and never leaves it.

/// What a file looked like when it was read; a save compares it with the file as it is then.
public struct FileStamp: Equatable, Sendable {
    public var modified: TimeInterval
    public var size: Int64
    public init(modified: TimeInterval, size: Int64) { self.modified = modified; self.size = size }
}

public enum SaveConflict: Equatable, Sendable { case changedOnDisk, deletedOnDisk }

/// The one rule behind "refuse if the file changed on disk since opened".
public enum SaveGuard {
    /// `opened`: the stamp when the viewer read the file. `current`: the stamp now, nil when the file is gone.
    public static func check(opened: FileStamp, current: FileStamp?) -> SaveConflict? {
        guard let current else { return .deletedOnDisk }
        return current == opened ? nil : .changedOnDisk
    }
}

public enum FileClass: Equatable, Sendable {
    case text, image
    /// Open with the default app: `reason` is the sentence the Files tab shows.
    case external(String)
}

public enum FileKind {
    public static let maxTextBytes = 2 * 1024 * 1024
    /// An image the viewer shows; bigger than this goes to the default app.
    public static let maxImageBytes = 25 * 1024 * 1024
    static let imageExtensions: Set<String> = ["png", "jpg", "jpeg", "gif", "webp", "heic", "tiff", "tif", "bmp", "ico"]

    /// `head` is the file's first bytes (8 KB is plenty): a NUL byte or invalid UTF-8 makes it binary.
    public static func classify(name: String, size: Int64, head: Data) -> FileClass {
        let ext = (name as NSString).pathExtension.lowercased()
        if imageExtensions.contains(ext) {
            return size > Int64(maxImageBytes) ? .external("It is over 25 MB") : .image
        }
        if size > Int64(maxTextBytes) { return .external("It is over 2 MB") }
        if head.contains(0) { return .external("It is not a text file") }
        // A cut multi-byte character at the end of `head` is not invalid text: drop up to 3 trailing bytes.
        if head.isEmpty { return .text }
        var sample = head
        for _ in 0..<4 where !sample.isEmpty {
            if String(data: sample, encoding: .utf8) != nil { return .text }
            sample.removeLast()
        }
        return .external("It is not a text file")
    }
}

public enum FileOpened: Equatable, Sendable {
    case text(String, FileStamp)
    case image(Data, FileStamp)
    case external(String)
    case failed(String)
}

public enum SaveOutcome: Equatable, Sendable {
    case saved(FileStamp)
    case conflict(SaveConflict)
    case failed(String)
}

public enum FileDisk {
    // MARK: Paths

    /// The file for a relative path, or nil when the path would leave the root (absolute, `..`, or a symlink out).
    public static func resolve(root: String, relative: String) -> URL? {
        guard !root.isEmpty, !relative.hasPrefix("/"), !relative.contains("\0") else { return nil }
        if relative.split(separator: "/").contains("..") { return nil }
        let base = URL(fileURLWithPath: root).resolvingSymlinksInPath()
        let url = relative.isEmpty ? base : base.appendingPathComponent(relative)
        let real = url.resolvingSymlinksInPath().path
        guard real == base.path || real.hasPrefix(base.path + "/") else { return nil }
        return url
    }

    public static func stamp(_ url: URL) -> FileStamp? {
        guard let a = try? FileManager.default.attributesOfItem(atPath: url.path),
              let m = a[.modificationDate] as? Date, let s = a[.size] as? NSNumber else { return nil }
        return FileStamp(modified: m.timeIntervalSinceReferenceDate, size: s.int64Value)
    }

    // MARK: Listing

    /// One folder's entries (unfiltered, unordered). A symlink is listed as a file and never followed.
    public static func list(root: String, relative: String) -> [FileEntry] {
        guard let dir = resolve(root: root, relative: relative),
              let urls = try? FileManager.default.contentsOfDirectory(
                at: dir, includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey], options: [])
        else { return [] }
        return urls.map { u in
            let v = try? u.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
            let path = relative.isEmpty ? u.lastPathComponent : relative + "/" + u.lastPathComponent
            return FileEntry(path: path, isDirectory: v?.isDirectory == true && v?.isSymbolicLink != true)
        }
    }

    /// Which of these (relative) paths `.gitignore` and friends exclude. Empty outside a repository.
    public static func gitIgnored(root: String, paths: [String]) -> Set<String> {
        guard !paths.isEmpty, paths.count <= 5000 else { return [] }
        let input = Data(paths.joined(separator: "\0").utf8 + [0])
        guard let out = runGit(["check-ignore", "-z", "--stdin"], in: root, input: input) else { return [] }
        return Set(out.split(separator: 0).compactMap { String(data: Data($0), encoding: .utf8) })
    }

    /// Every file for the filter: git's own list (tracked and untracked, ignored left out), else a walk that skips
    /// `.git` and `node_modules`. Capped, so a huge tree never stalls the tab.
    public static func allFiles(root: String, cap: Int = 30_000) -> [String] {
        if let out = runGit(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], in: root, input: nil) {
            let list = out.split(separator: 0).prefix(cap).compactMap { String(data: Data($0), encoding: .utf8) }
            return Array(list)
        }
        var out: [String] = []
        let base = URL(fileURLWithPath: root).resolvingSymlinksInPath()
        guard let walker = FileManager.default.enumerator(at: base, includingPropertiesForKeys: [.isDirectoryKey]) else { return [] }
        for case let u as URL in walker {
            if ["node_modules", ".git"].contains(u.lastPathComponent) { walker.skipDescendants(); continue }
            if (try? u.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory == true { continue }
            out.append(String(u.path.dropFirst(base.path.count + 1)))
            if out.count >= cap { break }
        }
        return out
    }

    /// git's stdout when it exits 0 or 1 (check-ignore says 1 for "none"); nil when it cannot run or fails (not a repo).
    static func runGit(_ args: [String], in dir: String, input: Data?) -> Data? {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: "/usr/bin/git")
        p.arguments = ["-C", dir] + args
        let out = Pipe(), inPipe = Pipe()
        p.standardOutput = out
        p.standardError = FileHandle.nullDevice
        p.standardInput = input == nil ? FileHandle.nullDevice : inPipe
        do { try p.run() } catch { return nil }
        if let input {
            // Written off this thread so a big list can never fill the pipe while nobody reads the answer;
            // git may exit before reading it all (not a repository): no SIGPIPE, and the write throws instead of trapping.
            let writer = inPipe.fileHandleForWriting
            _ = fcntl(writer.fileDescriptor, F_SETNOSIGPIPE, 1)
            DispatchQueue.global().async { try? writer.write(contentsOf: input); try? writer.close() }
        }
        let data = out.fileHandleForReading.readDataToEndOfFile()
        p.waitUntilExit()
        return p.terminationStatus == 0 || p.terminationStatus == 1 ? data : nil
    }

    // MARK: Reading and saving

    public static func load(root: String, relative: String) -> FileOpened {
        guard let url = resolve(root: root, relative: relative) else { return .failed("That path is outside the workspace.") }
        guard let stamp = stamp(url) else { return .failed("That file is gone.") }
        guard let handle = try? FileHandle(forReadingFrom: url) else { return .failed("Squeak can't read that file.") }
        defer { try? handle.close() }
        let head = (try? handle.read(upToCount: 8192)) ?? Data()
        let name = url.lastPathComponent
        switch FileKind.classify(name: name, size: stamp.size, head: head) {
        case .external(let why): return .external(why)
        case .image:
            guard let data = try? Data(contentsOf: url) else { return .failed("Squeak can't read that file.") }
            return .image(data, stamp)
        case .text:
            try? handle.seek(toOffset: 0)
            guard let data = try? handle.readToEnd() ?? Data(), let text = String(data: data, encoding: .utf8) else {
                return .external("It is not a text file")
            }
            return .text(text, stamp)
        }
    }

    /// Writes `text` unless the file changed since `opened` (`overwrite` skips that check, after the person asked
    /// to). Keeps the file's permissions; the write is atomic.
    public static func save(root: String, relative: String, text: String, opened: FileStamp, overwrite: Bool = false) -> SaveOutcome {
        guard let url = resolve(root: root, relative: relative) else { return .failed("That path is outside the workspace.") }
        let now = stamp(url)
        if !overwrite, let conflict = SaveGuard.check(opened: opened, current: now) { return .conflict(conflict) }
        let perms = (try? FileManager.default.attributesOfItem(atPath: url.path))?[.posixPermissions]
        do {
            try Data(text.utf8).write(to: url, options: .atomic)
            if let perms { try? FileManager.default.setAttributes([.posixPermissions: perms], ofItemAtPath: url.path) }
        } catch {
            return .failed("Squeak couldn't save that file.")
        }
        guard let after = stamp(url) else { return .failed("Squeak couldn't save that file.") }
        return .saved(after)
    }
}
