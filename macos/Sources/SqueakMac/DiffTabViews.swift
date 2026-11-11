import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md §8.10, diff tabs: a changed file's whole diff against the workspace's base, or every changed file
// stacked, as a tab in the centre's strip. The lines, the gutter's comment plus and the host's comments are the
// Changes tab's own (`DiffLinesBody`); nothing here parses a diff a second time.

/// The tab chip in the strip: closes like a chat tab (its x, the context menu, ⇧⌘W) and is reopenable (⇧⌘T).
struct DiffTabChip: View {
    let files: FilesModel
    let target: DiffTabs.Target

    var body: some View {
        let selected = files.diffs.active == target
        HStack(spacing: 4) {
            Button { files.showDiff(target) } label: {
                HStack(spacing: 5) {
                    Lucide(target == .all ? .layers : .fileText, size: 12, color: Theme.muted)
                    Text(verbatim: title).font(Typo.code).foregroundStyle(selected ? Theme.ink : Theme.muted).lineLimit(1)
                    Text("diff").font(Typo.meta).foregroundStyle(Theme.subtle)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            Button { files.closeDiff(target) } label: {
                Lucide(.x, size: 11, color: Theme.muted).frame(width: 18, height: 18).contentShape(Rectangle())
            }
            .buttonStyle(.plain).help("Close \(title) diff").accessibilityLabel("Close \(title) diff")
        }
        .padding(.leading, 10).padding(.trailing, 4).frame(height: 28).frame(maxWidth: 240)
        .background(selected ? Theme.selected : .clear, in: RoundedRectangle(cornerRadius: Radius.control))
        .accessibilityAddTraits(selected ? .isSelected : [])
        .squeakContextMenu {
            Button("Close tab") { files.closeDiff(target) }
            Button("Reopen closed tab") { files.reopenDiff() }.disabled(!files.diffs.hasClosed)
        }
    }

    private var title: String {
        switch target {
        case .all: "All changes"
        case .file(let path): ChangesPresentation.fileName(path)
        }
    }
}

/// The centre while a diff tab shows.
struct DiffTabView: View {
    let files: FilesModel
    let target: DiffTabs.Target
    let session: HostSession
    @Environment(AppModel.self) private var model

    var body: some View {
        let store = model.changesStore(for: session.key.hostSessionId)
        VStack(spacing: 0) {
            switch target {
            case .file(let path): DiffFileSection(store: store, session: session, path: path, collapsible: false, files: files)
            case .all: AllChangesView(store: store, session: session, files: files)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bg)
        .task(id: session.key.hostSessionId) { await store.refresh(sessionKey: session.key.hostSessionId, visible: true, activityChanged: true) }
        // A file that is no longer changed has nothing to show.
        .onChange(of: store.changes) { _, c in if let c { files.pruneDiffs(changed: Set(c.files.map(\.path))) } }
    }
}

/// Every changed file's diff, stacked: a header with the totals and a "Jump to file" index, then one collapsible
/// section per file, each read when it scrolls into view.
private struct AllChangesView: View {
    let store: ChangesStore
    let session: HostSession
    let files: FilesModel

    var body: some View {
        let list = store.changes?.files ?? []
        VStack(spacing: 0) {
            ScrollViewReader { proxy in
                header(list, proxy: proxy)
                Rectangle().fill(Theme.line).frame(height: 1)
                if list.isEmpty {
                    Text(store.phase == .loading ? "Reading the changes…" : "No changes against \(store.changes?.base ?? "HEAD") yet.")
                        .font(Typo.body).foregroundStyle(Theme.muted).padding(Space.l)
                    Spacer(minLength: 0)
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: Space.m) {
                            ForEach(list) { f in
                                DiffFileSection(store: store, session: session, path: f.path, collapsible: true, files: files).id(f.path)
                            }
                        }
                        .padding(Space.m)
                    }
                }
            }
        }
    }

    private func header(_ list: [DaemonChanges.File], proxy: ScrollViewProxy) -> some View {
        HStack(spacing: 10) {
            Lucide(.layers, size: 14, color: Theme.muted)
            Text(ChangeListing.header(count: list.count)).font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.ink)
            if let c = store.changes {
                Text("+\(c.added)").foregroundStyle(Theme.working)
                Text("−\(c.removed)").foregroundStyle(Theme.negative)
            }
            Spacer(minLength: 8)
            SqueakMenu {
                ForEach(list) { f in
                    Button("\(f.path)   +\(f.added) −\(f.removed)") { withAnimation(nil) { proxy.scrollTo(f.path, anchor: .top) } }
                }
            } label: {
                HStack(spacing: 5) { Text("Jump to file"); Lucide(.chevronDown, size: 11, color: Theme.muted) }
            }
            .menuStyle(.borderlessButton).fixedSize().disabled(list.isEmpty)
            .accessibilityLabel("Jump to file")
            Button("Fold all") { for f in list where !files.diffs.isFolded(f.path) { files.toggleDiffFold(f.path) } }
                .buttonStyle(QuietButtonStyle()).disabled(list.isEmpty)
            Button("Unfold all") { for f in list where files.diffs.isFolded(f.path) { files.toggleDiffFold(f.path) } }
                .buttonStyle(QuietButtonStyle()).disabled(list.isEmpty)
        }
        .font(.system(size: 12, design: .monospaced)).monospacedDigit()
        .padding(.horizontal, Space.m).frame(height: 40)
    }
}

/// One file: the path with its +n −n, then its diff. In the stacked view the header folds the section.
struct DiffFileSection: View {
    let store: ChangesStore
    let session: HostSession
    let path: String
    let collapsible: Bool
    let files: FilesModel
    @State private var lines: [DiffLine] = []
    @State private var truncated = false
    @State private var state: Load = .loading
    enum Load { case loading, ready, failed }

    private var file: DaemonChanges.File? { store.changes?.files.first { $0.path == path } }
    private var folded: Bool { collapsible && files.diffs.isFolded(path) }
    private var stamp: String { file.map { "\($0.status)/\($0.added)/\($0.removed)" } ?? "" }

    var body: some View {
        let parts = ChangeListing.split(path)
        VStack(alignment: .leading, spacing: 0) {
            Button { if collapsible { files.toggleDiffFold(path) } } label: {
                HStack(spacing: 8) {
                    if collapsible { Lucide(folded ? .chevronRight : .chevronDown, size: 11, color: Theme.muted) }
                    if let file { StatusSquare(status: file.status) }
                    HStack(spacing: 0) {
                        if !parts.folder.isEmpty {
                            Text(verbatim: parts.folder).foregroundStyle(Theme.subtle).lineLimit(1).truncationMode(.head).layoutPriority(-1)
                        }
                        Text(verbatim: parts.name).foregroundStyle(Theme.ink).lineLimit(1).truncationMode(.middle)
                    }
                    .font(.system(size: 13, design: .monospaced))
                    Spacer(minLength: 8)
                    if let file {
                        HStack(spacing: 5) {
                            Text("+\(file.added)").foregroundStyle(Theme.working)
                            Text("−\(file.removed)").foregroundStyle(Theme.negative)
                        }
                        .font(.system(size: 12, design: .monospaced)).monospacedDigit()
                    }
                }
                .padding(.horizontal, Space.m).frame(height: 36).contentShape(Rectangle())
            }
            .buttonStyle(.plain).disabled(!collapsible)
            .accessibilityLabel("\(path), +\(file?.added ?? 0) −\(file?.removed ?? 0)\(collapsible ? (folded ? ", folded" : ", open") : "")")
            if !folded {
                Rectangle().fill(Theme.line).frame(height: 1)
                switch state {
                case .loading: DiffNote(text: "Reading the diff…").padding(8)
                case .failed: DiffNote(text: "Could not read this file's diff.").padding(8)
                case .ready:
                    if lines.isEmpty { DiffNote(text: "No textual diff to show.").padding(8) }
                    else { DiffLinesBody(store: store, path: path, lines: lines, truncated: truncated, capped: true).padding(.vertical, 6) }
                }
            }
        }
        .background(collapsible ? Theme.surface : Theme.bg, in: RoundedRectangle(cornerRadius: collapsible ? Radius.card : 0))
        .overlay { if collapsible { RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Theme.line) } }
        .task(id: stamp + (folded ? "f" : "o")) {
            guard !folded else { return }
            if let read = await store.patch(for: path, sessionKey: session.key.hostSessionId) {
                lines = DiffParser.lines(read.patch); truncated = read.truncated; state = .ready
            } else if lines.isEmpty { state = .failed }
        }
    }
}
