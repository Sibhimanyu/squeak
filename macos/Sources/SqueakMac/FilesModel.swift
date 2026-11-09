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

    var path: String
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
    /// A line to scroll to and select once the text is on screen (a content-search hit).
    var jump: LineJump?

    nonisolated let id = UUID()
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
    /// "Names" filters paths as before; "Contents" greps the files (`ContentSearch`).
    var searchMode: SearchMode = .names { didSet { if searchMode != oldValue { Task { await refilter() } } } }
    private(set) var filtered: [String] = []
    private(set) var hits: [ContentHit] = []
    private(set) var searching = false
    @ObservationIgnored private var searchTask: Task<Void, Never>?
    /// The row selected in the tree (Return renames it), and the inline name field being shown.
    var selection: String?
    var inline: InlineEdit?
    var inlineName = ""
    var inlineError: String?
    /// Run after a change on disk, so git's status letters follow (set by the Files tab).
    @ObservationIgnored var afterChange: (() async -> Void)?
    /// A delete waiting for its confirmation, and an operation waiting for unsaved edits to be saved or dropped.
    var deleteAsk: DeleteAsk?
    var dirtyAsk: DirtyAsk?
    var dropTarget: String?
    @ObservationIgnored private var allFiles: [String]?
    private(set) var open: [OpenFile] = []
    var activePath: String?
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

    func load(_ dir: String) async {
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
        searchTask?.cancel()
        guard isFiltering else { filtered = []; hits = []; searching = false; return }
        if searchMode == .contents {
            filtered = []
            runContentSearch()
            return
        }
        hits = []; searching = false
        if allFiles == nil {
            let root = root
            allFiles = await Task.detached(priority: .userInitiated) { FileDisk.allFiles(root: root) }.value
        }
        let hiddenGit = (allFiles ?? []).filter { !$0.hasPrefix(".git/") }
        filtered = FileFilter.match(filter, in: hiddenGit)
    }

    // MARK: Open files

    func openFile(_ path: String, line: Int? = nil) {
        note = nil
        selection = path
        if let existing = open.first(where: { $0.path == path }) {
            activePath = existing.path
            if let line { existing.jump = LineJump(line: line) }
            return
        }
        let root = root
        Task {
            let result = await Task.detached(priority: .userInitiated) { FileDisk.load(root: root, relative: path) }.value
            switch result {
            case .text(let text, let stamp):
                let file = OpenFile(path: path, content: .text, text: text, stamp: stamp)
                if let line { file.jump = LineJump(line: line) }
                if !open.contains(where: { $0.path == path }) { open.append(file) }
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

// MARK: Types for managing files

final class CancelFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var value = false
    var isSet: Bool { lock.lock(); defer { lock.unlock() }; return value }
    func set() { lock.lock(); value = true; lock.unlock() }
}

enum SearchMode: String, CaseIterable { case names = "Names", contents = "Contents" }

/// A scroll-to-line request; a new `id` makes a repeat of the same line scroll again.
struct LineJump: Equatable { var line: Int; var id = UUID() }

enum InlineEdit: Equatable {
    case create(parent: String, folder: Bool)
    case rename(String)
}

struct DeleteAsk: Equatable { var path: String; var isDirectory: Bool; var items: Int }

struct DirtyAsk: Equatable {
    enum Op: Equatable { case rename(path: String, newName: String), move(path: String, toParent: String), trash(String) }
    var op: Op
    var dirty: [String]
}

// MARK: Managing files (DESIGN.md §8.10): the rules are in SqueakMacCore (`FileOps`, `FileNameRule`, `PathMap`)

extension FilesModel {
    private func siblings(of parent: String) -> Set<String> {
        Set((children[parent] ?? []).map(\.name))
    }

    func isDirectory(_ path: String) -> Bool {
        children[FileTree.parent(of: path)]?.first { $0.path == path }?.isDirectory ?? false
    }

    /// Where "New file" goes from the header: the selected folder, else beside the selected file, else the root.
    func targetFolder() -> String {
        guard let s = selection else { return "" }
        return isDirectory(s) ? s : FileTree.parent(of: s)
    }

    private func fail(_ message: String) { note = message }

    /// Refreshes the tree and git's status letters after a change on disk.
    private func changed() async {
        await refreshTree()
        await afterChange?()
    }

    // Inline name field

    func beginCreate(in parent: String, folder: Bool) {
        note = nil; inlineError = nil; inlineName = ""
        if !parent.isEmpty, !expanded.contains(parent) { toggle(parent) }
        filter = ""
        inline = .create(parent: parent, folder: folder)
    }

    func beginRename(_ path: String) {
        guard !path.isEmpty else { return }
        if let why = FileOps.protectedReason(path) { fail(why); return }
        note = nil; inlineError = nil
        inlineName = ChangesPresentation.fileName(path)
        inline = .rename(path)
    }

    func cancelInline() { inline = nil; inlineError = nil }

    func commitInline() {
        guard let edit = inline else { return }
        switch edit {
        case .create(let parent, let folder):
            if let why = FileNameRule.validate(inlineName, siblings: siblings(of: parent)) { inlineError = why; return }
            let (root, name) = (root, inlineName)
            inline = nil; inlineError = nil
            Task {
                let r = await Task.detached(priority: .userInitiated) { FileOps.create(root: root, parent: parent, name: name, isFolder: folder) }.value
                switch r {
                case .success(let path):
                    await changed()
                    selection = path
                    if !folder { openFile(path) }
                case .failure(let e): fail(e.message)
                }
            }
        case .rename(let path):
            let parent = FileTree.parent(of: path)
            let own = ChangesPresentation.fileName(path)
            if let why = FileNameRule.validate(inlineName, siblings: siblings(of: parent), renaming: own) { inlineError = why; return }
            let name = FileNameRule.clean(inlineName)
            inline = nil; inlineError = nil
            if name != own { requestMove(.rename(path: path, newName: name)) }
        }
    }

    // Moving, renaming, deleting: unsaved edits are asked about first

    func moveByDrag(_ path: String, toFolder target: String) {
        note = nil
        if let why = FileOps.checkMove(from: path, toParent: target) { fail(why); return }
        requestMove(.move(path: path, toParent: target))
    }

    private func requestMove(_ op: DirtyAsk.Op) {
        let touched: String
        switch op {
        case .rename(let p, _): touched = p
        case .move(let p, _): touched = p
        case .trash(let p): touched = p
        }
        let dirty = PathMap.affected(open.filter(\.dirty).map(\.path), by: touched)
        if dirty.isEmpty { Task { await perform(op) } } else { dirtyAsk = DirtyAsk(op: op, dirty: dirty) }
    }

    /// The answer to "unsaved edits": save them, then go on.
    func resolveDirty(save: Bool) {
        guard let ask = dirtyAsk else { return }
        dirtyAsk = nil
        Task {
            for path in ask.dirty {
                guard let file = open.first(where: { $0.path == path }) else { continue }
                if save {
                    let (root, text, stamp) = (root, file.edited, file.stamp)
                    let outcome = await Task.detached { FileDisk.save(root: root, relative: path, text: text, opened: stamp, overwrite: false) }.value
                    guard case .saved(let s) = outcome else {
                        fail("\(file.name) couldn't be saved, so nothing was changed."); activePath = path; return
                    }
                    file.original = text; file.stamp = s
                } else {
                    file.edited = file.original
                }
            }
            await perform(ask.op)
        }
    }

    func cancelDirty() { dirtyAsk = nil }

    private func perform(_ op: DirtyAsk.Op) async {
        let root = root
        switch op {
        case .rename(let path, let newName):
            let r = await Task.detached { FileOps.move(root: root, from: path, toParent: FileTree.parent(of: path), newName: newName) }.value
            finishMove(r, from: path)
        case .move(let path, let parent):
            let name = ChangesPresentation.fileName(path)
            let r = await Task.detached { FileOps.move(root: root, from: path, toParent: parent, newName: name) }.value
            finishMove(r, from: path)
        case .trash(let path):
            let r = await Task.detached { FileOps.trash(root: root, path: path) }.value
            switch r {
            case .success:
                for p in PathMap.affected(open.map(\.path), by: path) { close(p, force: true) }
                if selection.map({ PathMap.isInside($0, of: path) }) == true { selection = nil }
            case .failure(let e): fail(e.message)
            }
        }
        await changed()
    }

    private func finishMove(_ r: Result<String, FileOpError>, from: String) {
        switch r {
        case .failure(let e): fail(e.message)
        case .success(let to):
            for f in open { f.path = PathMap.remap(f.path, from: from, to: to) }
            if let a = activePath { activePath = PathMap.remap(a, from: from, to: to) }
            if let s = selection { selection = PathMap.remap(s, from: from, to: to) }
            expanded = Set(expanded.map { PathMap.remap($0, from: from, to: to) })
            for key in children.keys where PathMap.isInside(key, of: from) { children[key] = nil }
            if let ask = closeAsk { closeAsk = PathMap.remap(ask, from: from, to: to) }
            reveal(to)
        }
    }

    func askDelete(_ path: String, isDirectory: Bool) {
        note = nil
        if let why = FileOps.protectedReason(path) { fail(why); return }
        let root = root
        Task {
            let n = isDirectory ? await Task.detached { FileOps.countItems(root: root, path: path) }.value : 0
            deleteAsk = DeleteAsk(path: path, isDirectory: isDirectory, items: n)
        }
    }

    func confirmDelete() {
        guard let ask = deleteAsk else { return }
        deleteAsk = nil
        requestMove(.trash(ask.path))
    }

    // Drops from Finder

    func copyIn(_ urls: [URL], toFolder target: String) {
        note = nil
        let root = root
        Task {
            let r = await Task.detached(priority: .userInitiated) { FileOps.copyIn(root: root, sources: urls, toParent: target) }.value
            if case .failure(let e) = r { fail(e.message) }
            if !target.isEmpty, !expanded.contains(target) { toggle(target) }
            await changed()
        }
    }

    // Copy path

    func copyPath(_ path: String, full: Bool) {
        let text = full ? URL(fileURLWithPath: root).appendingPathComponent(path).path : path
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(path.isEmpty && full ? root : text, forType: .string)
    }

    // Content search

    /// Greps the workspace for the filter text after a short pause; a newer keystroke cancels it.
    fileprivate func runContentSearch() {
        guard let query = ContentSearch.normalized(filter) else { hits = []; searching = false; return }
        let root = root
        searching = true
        searchTask = Task {
            try? await Task.sleep(for: .milliseconds(250))
            guard !Task.isCancelled else { return }
            let flag = CancelFlag()
            let found = await withTaskCancellationHandler {
                await Task.detached(priority: .userInitiated) {
                    ContentSearch.run(root: root, query: query, isCancelled: { flag.isSet })
                }.value
            } onCancel: { flag.set() }
            guard !Task.isCancelled else { return }
            hits = found
            searching = false
        }
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
