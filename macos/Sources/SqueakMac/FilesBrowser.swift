import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md §8.10, the inspector's Files tab: the workspace as a lazy tree for a chat with a local folder
// (folders first, `.git` and `.gitignore`d entries hidden unless "Show ignored"), changed files marked with their
// status letter, a filter field. A file opens in the centre (`FileViewer`). A chat with no folder keeps the
// changed-files list.

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

    var body: some View {
        let marks = FileChangeMarks(store.changes?.files ?? [])
        VStack(spacing: 0) {
            filterField
            Rectangle().fill(Theme.line).frame(height: 1)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if files.isFiltering {
                        if files.filtered.isEmpty {
                            Text("No file matches.").font(Typo.body).foregroundStyle(Theme.muted).padding(Space.m)
                        }
                        ForEach(files.filtered, id: \.self) { path in
                            FoundRow(files: files, path: path, status: marks.files[path])
                        }
                    } else {
                        let rows = files.rows
                        if rows.isEmpty {
                            Text(files.children[""] == nil ? "Reading the folder…" : "This folder is empty.")
                                .font(Typo.body).foregroundStyle(Theme.muted).padding(Space.m)
                        }
                        ForEach(rows) { row in TreeRow(files: files, row: row, marks: marks) }
                    }
                    if let note = files.note {
                        Text(verbatim: note).font(Typo.meta).foregroundStyle(Theme.subtle).padding(Space.m)
                    }
                }
                .padding(.vertical, Space.xs)
            }
        }
        .task(id: files.root) { await files.refreshTree() }
        .onChange(of: store.changes) { Task { await files.refreshTree() } }
        .onChange(of: files.showIgnored) { Task { await files.refreshTree() } }
        // Changed files appear in the tree from the Changes list: keep it fresh while this tab is up.
        .task(id: sessionKey) { await store.refresh(sessionKey: sessionKey, visible: true, activityChanged: true) }
    }

    private var filterField: some View {
        HStack(spacing: 6) {
            Lucide(.search, size: 13, color: Theme.muted)
            TextField("Filter files", text: Bindable(files).filter)
                .textFieldStyle(.plain).font(Typo.body).focused($filterFocused)
                .accessibilityLabel("Filter files")
                .onSubmit { if let first = files.filtered.first { files.openFile(first) } }
            if files.isFiltering {
                Button { files.filter = "" } label: { Lucide(.x, size: 12, color: Theme.muted).frame(width: 20, height: 20) }
                    .buttonStyle(.plain).accessibilityLabel("Clear the filter")
            }
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
    @State private var hovering = false

    var body: some View {
        let e = row.entry
        let open = files.activePath == e.path
        Button {
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
            .background(open || hovering ? Theme.selected : .clear, in: RoundedRectangle(cornerRadius: Radius.row))
            .padding(.horizontal, 4)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .contextMenu { FileContextMenu(files: files, path: e.path, isDirectory: e.isDirectory) }
        .accessibilityAddTraits(open ? .isSelected : [])
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

private struct FileContextMenu: View {
    let files: FilesModel
    let path: String
    let isDirectory: Bool

    var body: some View {
        if !isDirectory { Button("Open") { files.openFile(path) } }
        Button("Reveal in Finder") {
            if let url = files.url(for: path) { NSWorkspace.shared.activateFileViewerSelecting([url]) }
        }
        if !isDirectory {
            Button("Open in default app") { if let url = files.url(for: path) { NSWorkspace.shared.open(url) } }
        }
        Button("Copy path") {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(path, forType: .string)
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
