import AppKit
import Foundation
import Observation
import SqueakMacCore

// DESIGN.md §8.10, the Files tab and the file viewer: one browser per workspace folder (tree, filter, open files).
// The pure rules (ordering, ignored/.git hiding, classification, save conflicts) are in SqueakMacCore/Files; this
// holds the state and does the reads and writes off the main thread.

@MainActor @Observable
final class OpenFile: Identifiable {
    enum Content { case text, image(NSImage) }

    let path: String
    var content: Content
    /// The text as last read or saved, and as it is in the editor now.
    var original: String
    var edited: String
    /// What the file looked like when read; a save is refused if it changed since.
    var stamp: FileStamp
    var editing = false
    var conflict: SaveConflict?
    var note: String?
    var saving = false

    nonisolated var id: String { path }
    var name: String { ChangesPresentation.fileName(path) }
    var dirty: Bool { edited != original }

    init(path: String, content: Content, text: String, stamp: FileStamp) {
        self.path = path; self.content = content; self.original = text; self.edited = text; self.stamp = stamp
    }
}

@MainActor @Observable
final class FilesModel {
    let root: String
    private(set) var children: [String: [FileEntry]] = [:]
    private(set) var ignored: Set<String> = []
    var expanded: Set<String> = []
    var showIgnored = false
    var filter = "" { didSet { if filter != oldValue { Task { await refilter() } } } }
    private(set) var filtered: [String] = []
    @ObservationIgnored private var allFiles: [String]?
    private(set) var open: [OpenFile] = []
    var activePath: String? { didSet { if activePath != nil, diffs.active != nil { diffs.deactivate() } } }
    /// The diff tabs in the strip (one file's, or all changes), beside the open files.
    private(set) var diffs = DiffTabs()
    /// A sentence under the tree: why a file went to its default app, or why one did not open.
    var note: String?
    /// The file whose tab was closed with unsaved edits; the window asks what to do.
    var closeAsk: String?
    @ObservationIgnored private var loading = false

    init(root: String) { self.root = root }

    var rows: [FileRow] { FileTree.rows(children: children, expanded: expanded, ignored: ignored, showIgnored: showIgnored) }
    var activeFile: OpenFile? { activePath.flatMap { p in open.first { $0.path == p } } }
    var isFiltering: Bool { !filter.trimmingCharacters(in: .whitespaces).isEmpty }
    var hasUnsaved: Bool { open.contains { $0.dirty } }

    // MARK: Tree

    /// Reads the root and every expanded folder again (a folder that vanished is dropped).
    func refreshTree() async {
        guard !loading else { return }
        loading = true
        defer { loading = false }
        allFiles = nil
        for dir in [""] + expanded.sorted() { await load(dir) }
        expanded = expanded.filter { children[$0] != nil }
        if isFiltering { await refilter() }
    }

    private func load(_ dir: String) async {
        let root = root
        let (entries, hidden) = await Task.detached(priority: .userInitiated) { () -> ([FileEntry], Set<String>) in
            let e = FileDisk.list(root: root, relative: dir)
            return (e, FileDisk.gitIgnored(root: root, paths: e.map(\.path)))
        }.value
        if children[dir] != entries { children[dir] = entries }
        let inDir = Set(entries.map(\.path))
        ignored = ignored.filter { FileTree.parent(of: $0) != dir || inDir.contains($0) }.union(hidden)
    }

    func toggle(_ dir: String) {
        if expanded.contains(dir) { expanded.remove(dir); return }
        expanded.insert(dir)
        if children[dir] == nil { Task { await load(dir) } }
    }

    /// Opens every folder above `path`, so the row can be seen.
    func reveal(_ path: String) {
        for a in FileTree.ancestors(of: path) where !expanded.contains(a) { toggle(a) }
    }

    private func refilter() async {
        guard isFiltering else { filtered = []; return }
        if allFiles == nil {
            let root = root
            allFiles = await Task.detached(priority: .userInitiated) { FileDisk.allFiles(root: root) }.value
        }
        let hiddenGit = (allFiles ?? []).filter { !$0.hasPrefix(".git/") }
        filtered = FileFilter.match(filter, in: hiddenGit)
    }

    // MARK: Open files

    func openFile(_ path: String) {
        note = nil
        if let existing = open.first(where: { $0.path == path }) { activePath = existing.path; return }
        let root = root
        Task {
            let result = await Task.detached(priority: .userInitiated) { FileDisk.load(root: root, relative: path) }.value
            switch result {
            case .text(let text, let stamp):
                if !open.contains(where: { $0.path == path }) { open.append(OpenFile(path: path, content: .text, text: text, stamp: stamp)) }
                activePath = path
            case .image(let data, let stamp):
                guard let image = NSImage(data: data) else { note = "Squeak can't show \(ChangesPresentation.fileName(path))."; return }
                if !open.contains(where: { $0.path == path }) { open.append(OpenFile(path: path, content: .image(image), text: "", stamp: stamp)) }
                activePath = path
            case .external(let why):
                if let url = FileDisk.resolve(root: root, relative: path) {
                    NSWorkspace.shared.open(url)
                    note = "\(why), so \(ChangesPresentation.fileName(path)) opened in its default app."
                }
            case .failed(let why):
                note = why
            }
        }
    }

    /// Closes the tab; with unsaved edits it asks first (`closeAsk`) unless `force`.
    func close(_ path: String, force: Bool = false) {
        guard let i = open.firstIndex(where: { $0.path == path }) else { return }
        if open[i].dirty && !force { closeAsk = path; activePath = path; return }
        open.remove(at: i)
        if closeAsk == path { closeAsk = nil }
        if activePath == path { activePath = nil }
    }

    func showDiff(_ target: DiffTabs.Target) { activePath = nil; diffs.show(target) }
    func closeDiff(_ target: DiffTabs.Target) { diffs.close(target) }
    @discardableResult func reopenDiff() -> Bool { activePath = nil; return diffs.reopen() != nil }
    func pruneDiffs(changed: Set<String>) { diffs.prune(changed: changed) }
    func toggleDiffFold(_ path: String) { diffs.toggleFold(path) }
    func showChat() { activePath = nil; diffs.deactivate() }

    func url(for path: String) -> URL? { FileDisk.resolve(root: root, relative: path) }

    // MARK: Editing

    func save(_ file: OpenFile, overwrite: Bool = false, thenClose: Bool = false) {
        guard !file.saving, file.dirty else { return }
        file.saving = true
        file.note = nil
        let (root, path, text, stamp) = (root, file.path, file.edited, file.stamp)
        Task {
            let outcome = await Task.detached(priority: .userInitiated) {
                FileDisk.save(root: root, relative: path, text: text, opened: stamp, overwrite: overwrite)
            }.value
            file.saving = false
            switch outcome {
            case .saved(let newStamp):
                file.original = text; file.stamp = newStamp; file.conflict = nil
                if thenClose { close(path, force: true) }
            case .conflict(let c):
                file.conflict = c
                if thenClose { closeAsk = nil }
            case .failed(let why):
                file.note = why
            }
        }
    }

    /// Takes the file as it is on disk, dropping the edits.
    func reload(_ file: OpenFile) {
        let (root, path) = (root, file.path)
        Task {
            let result = await Task.detached(priority: .userInitiated) { FileDisk.load(root: root, relative: path) }.value
            switch result {
            case .text(let text, let stamp):
                file.original = text; file.edited = text; file.stamp = stamp; file.conflict = nil; file.note = nil
            case .image(let data, let stamp):
                if let image = NSImage(data: data) { file.content = .image(image); file.stamp = stamp; file.conflict = nil }
            case .external, .failed:
                file.conflict = .deletedOnDisk
            }
        }
    }

    /// Run while a file is on screen: a file nobody edited here follows the disk; an edited one is flagged instead.
    func checkDisk(_ file: OpenFile) async {
        guard !file.saving else { return }
        let (root, path) = (root, file.path)
        let now = await Task.detached { FileDisk.resolve(root: root, relative: path).flatMap(FileDisk.stamp) }.value
        guard let conflict = SaveGuard.check(opened: file.stamp, current: now) else { return }
        if !file.dirty, conflict == .changedOnDisk { reload(file) } else if file.conflict != conflict { file.conflict = conflict }
    }
}

extension AppModel {
    /// One browser per workspace folder, shared by the inspector's Files tab and the centre's file tabs.
    func filesModel(root: String) -> FilesModel {
        if let existing = filesModels[root] { return existing }
        let m = FilesModel(root: root)
        filesModels[root] = m
        return m
    }
}
