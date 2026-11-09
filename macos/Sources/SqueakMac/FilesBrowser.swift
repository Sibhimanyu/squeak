import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md §8.10, the inspector's Files tab: the workspace as a lazy tree for a chat with a local folder
// (folders first, `.git` and `.gitignore`d entries hidden unless "Show ignored"), changed files marked with their
// status letter, a filter field (Names or Contents). A file opens in the centre (`FileViewer`). Files are managed
// here: new file/folder, rename, move by drag, Trash, copy path, drops from Finder (rules in `FileOps`). A chat with
// no folder keeps the changed-files list.

struct FilesTab: View {
    let session: HostSession
    @Environment(AppModel.self) private var model

    private var root: String? {
        guard let cwd = session.cwd, !cwd.isEmpty, FileManager.default.fileExists(atPath: cwd) else { return nil }
        return cwd
    }

    var body: some View {
        if let root, !model.demoMode {
            FilesBrowser(files: model.filesModel(root: root), store: model.changesStore(for: session.key.hostSessionId), sessionKey: session.key.hostSessionId)
        } else {
            ChangedFilesList(sessionKey: session.key.hostSessionId, note: model.demoMode ? nil : "This chat has no folder on this Mac.")
        }
    }
}

private struct FilesBrowser: View {
    let files: FilesModel
    let store: ChangesStore
    let sessionKey: String
    @FocusState private var filterFocused: Bool
    @FocusState private var treeFocused: Bool

    var body: some View {
        let marks = FileChangeMarks(store.changes?.files ?? [])
        VStack(spacing: 0) {
            filterField
            Rectangle().fill(Theme.line).frame(height: 1)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if files.isFiltering && files.searchMode == .contents {
                        contentResults
                    } else if files.isFiltering {
                        if files.filtered.isEmpty {
                            Text("No file matches.").font(Typo.body).foregroundStyle(Theme.muted).padding(Space.m)
                        }
                        ForEach(files.filtered, id: \.self) { path in
                            FoundRow(files: files, path: path, status: marks.files[path])
                        }
                    } else {
                        let rows = files.rows
                        if case .create(let parent, let folder)? = files.inline, parent.isEmpty {
                            InlineNameRow(files: files, depth: 0, isFolder: folder)
                        }
                        if rows.isEmpty, files.inline == nil {
                            Text(files.children[""] == nil ? "Reading the folder…" : "This folder is empty.")
                                .font(Typo.body).foregroundStyle(Theme.muted).padding(Space.m)
                        }
                        ForEach(rows) { row in
                            TreeRow(files: files, row: row, marks: marks, focus: $treeFocused)
                            if case .create(let parent, let folder)? = files.inline, parent == row.entry.path, row.expanded {
                                InlineNameRow(files: files, depth: row.depth + 1, isFolder: folder)
                            }
                        }
                    }
                    if let note = files.note {
                        Text(verbatim: note).font(Typo.meta).foregroundStyle(Theme.negative).padding(Space.m)
                            .accessibilityLabel(note)
                    }
                    Color.clear.frame(minHeight: 40)
                }
                .padding(.vertical, Space.xs)
                .contentShape(Rectangle())
                .contextMenu { FolderMenu(files: files, folder: "") }
            }
            .focusable().focused($treeFocused).focusEffectDisabled()
            .onKeyPress(.return) {
                guard !files.isFiltering, files.inline == nil, let sel = files.selection else { return .ignored }
                files.beginRename(sel); return .handled
            }
            .onKeyPress(keys: [.delete, .deleteForward]) { press in
                guard press.modifiers.contains(.command), !files.isFiltering, files.inline == nil, let sel = files.selection else { return .ignored }
                files.askDelete(sel, isDirectory: files.isDirectory(sel)); return .handled
            }
            .background(files.dropTarget == "" ? Theme.selected.opacity(0.5) : .clear)
            .onDrop(of: [.fileURL, .plainText], isTargeted: Binding(
                get: { files.dropTarget == "" }, set: { files.dropTarget = $0 ? "" : (files.dropTarget == "" ? nil : files.dropTarget) })
            ) { providers in FileDrop.handle(providers, files: files, into: "") }
        }
        .task(id: files.root) {
            files.afterChange = { await store.refresh(sessionKey: sessionKey, visible: true, activityChanged: true) }
            await files.refreshTree()
        }
        .onChange(of: store.changes) { Task { await files.refreshTree() } }
        .onChange(of: files.showIgnored) { Task { await files.refreshTree() } }
        // Changed files appear in the tree from the Changes list: keep it fresh while this tab is up.
        .task(id: sessionKey) { await store.refresh(sessionKey: sessionKey, visible: true, activityChanged: true) }
        .confirmationDialog(
            files.deleteAsk.map { "Move \(ChangesPresentation.fileName($0.path)) to the Trash?" } ?? "",
            isPresented: Binding(get: { files.deleteAsk != nil }, set: { if !$0 { files.deleteAsk = nil } }),
            titleVisibility: .visible, presenting: files.deleteAsk
        ) { _ in
            Button("Move to Trash", role: .destructive) { files.confirmDelete() }
            Button("Cancel", role: .cancel) { files.deleteAsk = nil }
        } message: { ask in
            Text(ask.isDirectory
                ? "It holds \(ask.items) \(ask.items == 1 ? "item" : "items"). You can put it back from the Trash."
                : "You can put it back from the Trash.")
        }
        .confirmationDialog(
            files.dirtyAsk.map { "\($0.dirty.count == 1 ? ChangesPresentation.fileName($0.dirty[0]) : "\($0.dirty.count) files") has unsaved edits" } ?? "",
            isPresented: Binding(get: { files.dirtyAsk != nil }, set: { if !$0 { files.cancelDirty() } }),
            titleVisibility: .visible
        ) {
            Button("Save and continue") { files.resolveDirty(save: true) }
            Button("Don't save", role: .destructive) { files.resolveDirty(save: false) }
            Button("Cancel", role: .cancel) { files.cancelDirty() }
        } message: {
            Text("Save them first, or they are lost.")
        }
    }

    @ViewBuilder private var contentResults: some View {
        if ContentSearch.normalized(files.filter) == nil {
            Text("Type at least two letters.").font(Typo.body).foregroundStyle(Theme.muted).padding(Space.m)
        } else if files.searching {
            Text("Searching…").font(Typo.body).foregroundStyle(Theme.muted).padding(Space.m)
        } else if files.hits.isEmpty {
            Text("No match in the files.").font(Typo.body).foregroundStyle(Theme.muted).padding(Space.m)
        } else {
            ForEach(files.hits) { hit in HitRow(files: files, hit: hit) }
            if files.hits.count >= ContentSearch.cap {
                Text("Showing the first \(ContentSearch.cap). Narrow the search to see more.")
                    .font(Typo.meta).foregroundStyle(Theme.subtle).padding(Space.m)
            }
        }
    }

    private var filterField: some View {
        HStack(spacing: 6) {
            Lucide(.search, size: 13, color: Theme.muted)
            TextField(files.searchMode == .names ? "Filter files" : "Search in files", text: Bindable(files).filter)
                .textFieldStyle(.plain).font(Typo.body).focused($filterFocused)
                .accessibilityLabel(files.searchMode == .names ? "Filter files" : "Search in files")
                .onSubmit {
                    if files.searchMode == .contents { if let h = files.hits.first { files.openFile(h.path, line: h.line) } } else if let first = files.filtered.first { files.openFile(first) }
                }
            if files.isFiltering {
                Button { files.filter = "" } label: { Lucide(.x, size: 12, color: Theme.muted).frame(width: 20, height: 20) }
                    .buttonStyle(.plain).accessibilityLabel("Clear the filter")
            }
            Button { files.searchMode = files.searchMode == .names ? .contents : .names } label: {
                Text(files.searchMode.rawValue).font(Typo.meta).foregroundStyle(Theme.muted)
                    .padding(.horizontal, 6).frame(height: 20)
                    .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.control))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain).help("Search file names or file contents")
            .accessibilityLabel("Search in \(files.searchMode.rawValue.lowercased())").accessibilityHint("Switches between names and contents")
            Menu {
                Button("New file") { files.beginCreate(in: files.targetFolder(), folder: false) }
                Button("New folder") { files.beginCreate(in: files.targetFolder(), folder: true) }
            } label: {
                Lucide(.plus, size: 14, color: Theme.muted).frame(width: 24, height: 24).contentShape(Rectangle())
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            .help("New file or folder").accessibilityLabel("New file or folder")
            Menu {
                Toggle("Show ignored", isOn: Bindable(files).showIgnored)
                Button("Refresh") { Task { await files.refreshTree() } }
            } label: {
                Lucide(.ellipsis, size: 14, color: Theme.muted).frame(width: 24, height: 24).contentShape(Rectangle())
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            .help("Show ignored, refresh").accessibilityLabel("File list options")
        }
        .padding(.horizontal, Space.m).frame(height: 36)
    }
}

private struct TreeRow: View {
    let files: FilesModel
    let row: FileRow
    let marks: FileChangeMarks
    var focus: FocusState<Bool>.Binding
    @State private var hovering = false

    var body: some View {
        let e = row.entry
        let open = files.activePath == e.path
        let target = e.isDirectory ? e.path : FileTree.parent(of: e.path)
        if files.inline == .rename(e.path) {
            InlineNameRow(files: files, depth: row.depth, isFolder: e.isDirectory)
        } else {
            Button {
                files.selection = e.path
                focus.wrappedValue = true
                if e.isDirectory { files.toggle(e.path) } else { files.openFile(e.path) }
            } label: {
                HStack(spacing: 5) {
                    Group {
                        if e.isDirectory { Lucide(row.expanded ? .chevronDown : .chevronRight, size: 11, color: Theme.subtle) } else { Color.clear }
                    }
                    .frame(width: 14)
                    Lucide(e.isDirectory ? .folder : .fileText, size: 13, color: row.ignored ? Theme.subtle : Theme.muted)
                    Text(verbatim: e.name).font(Typo.body).foregroundStyle(row.ignored ? Theme.subtle : Theme.ink).lineLimit(1).truncationMode(.middle)
                    Spacer(minLength: 4)
                    if let status = marks.status(of: e) {
                        StatusLetter(status: status)
                    } else if marks.holdsChange(e) {
                        Circle().fill(Theme.muted).frame(width: 5, height: 5).accessibilityLabel("Contains changes")
                    }
                }
                .padding(.leading, CGFloat(row.depth) * 12 + 8).padding(.trailing, Space.m)
                .frame(height: 24)
                .background(open || hovering || files.selection == e.path || files.dropTarget == target && e.isDirectory ? Theme.selected : .clear,
                            in: RoundedRectangle(cornerRadius: Radius.row))
                .padding(.horizontal, 4)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .onHover { hovering = $0 }
            .contextMenu { FileContextMenu(files: files, path: e.path, isDirectory: e.isDirectory) }
            .onDrag { NSItemProvider(object: FileDrop.token(root: files.root, path: e.path) as NSString) }
            .onDrop(of: [.fileURL, .plainText], isTargeted: Binding(
                get: { files.dropTarget == target }, set: { files.dropTarget = $0 ? target : (files.dropTarget == target ? nil : files.dropTarget) })
            ) { providers in FileDrop.handle(providers, files: files, into: target) }
            .accessibilityAddTraits(open || files.selection == e.path ? .isSelected : [])
            .accessibilityAction(named: "Rename") { files.beginRename(e.path) }
            .accessibilityAction(named: "Move to Trash") { files.askDelete(e.path, isDirectory: e.isDirectory) }
        }
    }
}

/// The inline name field for a new file or folder, or for a rename: Return commits, Esc cancels, a refusal is one
/// calm line under the field.
private struct InlineNameRow: View {
    let files: FilesModel
    let depth: Int
    let isFolder: Bool
    @FocusState private var focused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 5) {
                Color.clear.frame(width: 14)
                Lucide(isFolder ? .folder : .fileText, size: 13, color: Theme.muted)
                TextField(isFolder ? "Folder name" : "File name", text: Bindable(files).inlineName)
                    .textFieldStyle(.plain).font(Typo.body).foregroundStyle(Theme.ink)
                    .focused($focused)
                    .onSubmit { files.commitInline() }
                    .onExitCommand { files.cancelInline() }
                    .accessibilityLabel(isFolder ? "Folder name" : "File name")
                    .padding(.horizontal, 4).frame(height: 20)
                    .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.control))
                    .onChange(of: files.inlineName) { files.inlineError = nil }
            }
            .padding(.leading, CGFloat(depth) * 12 + 8).padding(.trailing, Space.m)
            if let error = files.inlineError {
                Text(verbatim: error).font(Typo.meta).foregroundStyle(Theme.negative)
                    .padding(.leading, CGFloat(depth) * 12 + 8 + 38).padding(.trailing, Space.m)
            }
        }
        .frame(minHeight: 24)
        .padding(.horizontal, 4)
        .onAppear {
            focused = true
            // A rename starts with the name, minus its extension, selected.
            DispatchQueue.main.async {
                guard case .rename = files.inline, let editor = NSApp.keyWindow?.firstResponder as? NSTextView else { return }
                let name = editor.string as NSString
                let stem = name.deletingPathExtension.count
                editor.setSelectedRange(NSRange(location: 0, length: stem > 0 ? stem : name.length))
            }
        }
    }
}

/// A content-search hit: the file and line, and the matching line's text.
private struct HitRow: View {
    let files: FilesModel
    let hit: ContentHit
    @State private var hovering = false

    var body: some View {
        Button { files.openFile(hit.path, line: hit.line) } label: {
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(verbatim: ChangesPresentation.fileName(hit.path)).font(Typo.body).foregroundStyle(Theme.ink).lineLimit(1)
                    Text(verbatim: ":\(hit.line)").font(Typo.meta).foregroundStyle(Theme.muted)
                    Text(verbatim: FileTree.parent(of: hit.path)).font(Typo.meta).foregroundStyle(Theme.subtle).lineLimit(1).truncationMode(.head)
                    Spacer(minLength: 0)
                }
                Text(verbatim: hit.snippet).font(Typo.code).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.tail)
            }
            .padding(.horizontal, Space.m).padding(.vertical, 4)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(hovering ? Theme.selected : .clear, in: RoundedRectangle(cornerRadius: Radius.row))
            .padding(.horizontal, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .accessibilityLabel("\(ChangesPresentation.fileName(hit.path)), line \(hit.line): \(hit.snippet)")
    }
}

/// Drags inside the tree (a move) and drops from Finder (a copy in).
enum FileDrop {
    static let prefix = "squeak-file:"
    static func token(root: String, path: String) -> String { "\(prefix)\(root)\n\(path)" }

    final class Box: @unchecked Sendable {
        private let lock = NSLock()
        private var urls: [URL] = [], moves: [String] = []
        func add(url: URL) { lock.lock(); urls.append(url); lock.unlock() }
        func add(move: String) { lock.lock(); moves.append(move); lock.unlock() }
        func take() -> ([URL], [String]) { lock.lock(); defer { lock.unlock() }; return (urls, moves) }
    }

    @MainActor static func handle(_ providers: [NSItemProvider], files: FilesModel, into target: String) -> Bool {
        let group = DispatchGroup(), box = Box(), root = files.root
        var any = false
        for p in providers {
            if p.canLoadObject(ofClass: URL.self) {
                any = true; group.enter()
                _ = p.loadObject(ofClass: URL.self) { url, _ in if let url { box.add(url: url) }; group.leave() }
            } else if p.canLoadObject(ofClass: String.self) {
                any = true; group.enter()
                _ = p.loadObject(ofClass: String.self) { text, _ in
                    if let text, text.hasPrefix(prefix) {
                        let parts = text.dropFirst(prefix.count).split(separator: "\n", maxSplits: 1).map(String.init)
                        if parts.count == 2, parts[0] == root { box.add(move: parts[1]) }
                    }
                    group.leave()
                }
            }
        }
        group.notify(queue: .main) {
            MainActor.assumeIsolated {
                let (urls, moves) = box.take()
                if !urls.isEmpty { files.copyIn(urls, toFolder: target) }
                for m in moves { files.moveByDrag(m, toFolder: target) }
            }
        }
        files.dropTarget = nil
        return any
    }
}

private struct FoundRow: View {
    let files: FilesModel
    let path: String
    let status: String?
    @State private var hovering = false

    var body: some View {
        Button { files.openFile(path) } label: {
            HStack(spacing: 6) {
                Lucide(.fileText, size: 13, color: Theme.muted)
                Text(verbatim: ChangesPresentation.fileName(path)).font(Typo.body).foregroundStyle(Theme.ink).lineLimit(1)
                Text(verbatim: FileTree.parent(of: path)).font(Typo.meta).foregroundStyle(Theme.subtle).lineLimit(1).truncationMode(.head)
                Spacer(minLength: 4)
                if let status { StatusLetter(status: status) }
            }
            .padding(.horizontal, Space.m).frame(height: 26)
            .background(hovering || files.activePath == path ? Theme.selected : .clear, in: RoundedRectangle(cornerRadius: Radius.row))
            .padding(.horizontal, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .contextMenu { FileContextMenu(files: files, path: path, isDirectory: false) }
    }
}

/// New file / New folder, for a folder row or the tree's background.
private struct FolderMenu: View {
    let files: FilesModel
    let folder: String

    var body: some View {
        Button("New file") { files.beginCreate(in: folder, folder: false) }
        Button("New folder") { files.beginCreate(in: folder, folder: true) }
    }
}

private struct FileContextMenu: View {
    let files: FilesModel
    let path: String
    let isDirectory: Bool

    var body: some View {
        if !isDirectory { Button("Open") { files.openFile(path) } }
        FolderMenu(files: files, folder: isDirectory ? path : FileTree.parent(of: path))
        Divider()
        Button("Rename") { files.beginRename(path) }
        Button("Move to Trash") { files.askDelete(path, isDirectory: isDirectory) }
        Divider()
        Button("Copy path") { files.copyPath(path, full: false) }
        Button("Copy full path") { files.copyPath(path, full: true) }
        Divider()
        Button("Reveal in Finder") {
            if let url = files.url(for: path) { NSWorkspace.shared.activateFileViewerSelecting([url]) }
        }
        if !isDirectory {
            Button("Open in default app") { if let url = files.url(for: path) { NSWorkspace.shared.open(url) } }
        }
    }
}

/// A chat with no folder on this Mac: the daemon's list of what it changed, by folder.
private struct ChangedFilesList: View {
    let sessionKey: String
    let note: String?
    @Environment(AppModel.self) private var model

    var body: some View {
        let store = model.changesStore(for: sessionKey)
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if let c = store.changes, !c.files.isEmpty {
                    ForEach(ChangesPresentation.byFolder(c.files), id: \.folder) { group in
                        HStack(spacing: 6) {
                            Lucide(.folder, size: 13, color: Theme.muted)
                            Text(group.folder.isEmpty ? "Workspace root" : group.folder).font(Typo.code).foregroundStyle(Theme.muted)
                                .lineLimit(1).truncationMode(.head)
                        }
                        .padding(.top, Space.s).padding(.bottom, 4)
                        ForEach(group.files) { file in
                            HStack(spacing: 8) {
                                StatusLetter(status: file.status)
                                Text(verbatim: ChangesPresentation.fileName(file.path)).font(Typo.code).foregroundStyle(Theme.ink).lineLimit(1)
                                Spacer(minLength: 0)
                            }
                            .padding(.leading, Space.m).frame(height: 24)
                        }
                    }
                } else {
                    Text(store.phase == .loading ? "Reading the files…" : "No changed files in this chat.")
                        .font(Typo.body).foregroundStyle(Theme.muted)
                }
                if let note { Text(verbatim: note).font(Typo.meta).foregroundStyle(Theme.subtle).padding(.top, Space.m) }
            }
            .padding(Space.m)
        }
        .task(id: sessionKey) { await store.refresh(sessionKey: sessionKey, visible: true, activityChanged: true) }
    }
}
