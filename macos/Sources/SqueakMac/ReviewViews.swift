import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md §8.10, Review: every changed file's diff stacked, with a file list beside it, replacing the centre's
// content under the header (the chat tab strip stays; any chat tab closes it). The lines, the gutter's comment plus
// and the host's comments are the Changes tab's own (`DiffLinesBody`); nothing here parses a diff a second time.
// Everything is clipped: a big diff must never draw over the header or the tab strip.

struct ReviewView: View {
    let files: FilesModel
    let session: HostSession
    @Environment(AppModel.self) private var model

    var body: some View {
        let store = model.changesStore(for: session.key.hostSessionId)
        let list = store.changes?.files ?? []
        VStack(spacing: 0) {
            topBar(store, list)
            Rectangle().fill(Theme.line).frame(height: 1)
            if list.isEmpty {
                Text(store.phase == .loading ? "Reading the changes…" : "No changes against \(store.changes?.base ?? "HEAD") yet.")
                    .font(Typo.body).foregroundStyle(Theme.muted).padding(Space.l)
                    .frame(maxWidth: .infinity, alignment: .leading)
                Spacer(minLength: 0)
            } else {
                ScrollViewReader { proxy in
                    HStack(spacing: 0) {
                        fileList(list)
                        Rectangle().fill(Theme.line).frame(width: 1)
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: Space.m) {
                                ForEach(list) { f in
                                    DiffFileSection(store: store, session: session, path: f.path, collapsible: true, files: files).id(f.path)
                                }
                            }
                            .padding(Space.m)
                        }
                        .clipped()
                    }
                    .task { await scroll(proxy) }
                    .onChange(of: files.review.focus) { _, _ in Task { await scroll(proxy) } }
                }
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bg)
        .clipped()
        .task(id: session.key.hostSessionId) { await store.refresh(sessionKey: session.key.hostSessionId, visible: true, activityChanged: true) }
        // A file that is no longer changed has nothing to show.
        .onChange(of: store.changes) { _, c in if let c { files.pruneDiffs(changed: Set(c.files.map(\.path))) } }
    }

    private func scroll(_ proxy: ScrollViewProxy) async {
        guard let path = files.review.focus else { return }
        // Let the lazy stack lay out before jumping.
        try? await Task.sleep(nanoseconds: 60_000_000)
        withAnimation(nil) { proxy.scrollTo(path, anchor: .top) }
    }

    private func topBar(_ store: ChangesStore, _ list: [DaemonChanges.File]) -> some View {
        HStack(spacing: 10) {
            Button { files.closeReview() } label: {
                HStack(spacing: 5) {
                    Lucide(.arrowLeft, size: 13, color: Theme.ink)
                    Text("Back to chat")
                }
            }
            .buttonStyle(QuietButtonStyle())
            .keyboardShortcut(.cancelAction)
            .help("Back to chat (Esc)").accessibilityLabel("Back to chat")
            Text(ChangeListing.header(count: list.count)).font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
            if let c = store.changes {
                Text("+\(c.added)").foregroundStyle(Theme.success)
                Text("−\(c.removed)").foregroundStyle(Theme.negative)
            }
            Spacer(minLength: 8)
            Button("Fold all") { for f in list where !files.review.isFolded(f.path) { files.toggleDiffFold(f.path) } }
                .buttonStyle(QuietButtonStyle()).disabled(list.isEmpty)
            Button("Unfold all") { for f in list where files.review.isFolded(f.path) { files.toggleDiffFold(f.path) } }
                .buttonStyle(QuietButtonStyle()).disabled(list.isEmpty)
        }
        .font(.system(size: 12, design: .monospaced)).monospacedDigit()
        .padding(.horizontal, Space.m).frame(height: 40).clipped()
    }

    private func fileList(_ list: [DaemonChanges.File]) -> some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                ForEach(list) { f in
                    let parts = ChangeListing.split(f.path)
                    let selected = files.review.focus == f.path
                    Button { files.focusReview(f.path) } label: {
                        HStack(spacing: 7) {
                            StatusSquare(status: f.status)
                            VStack(alignment: .leading, spacing: 1) {
                                Text(verbatim: parts.name).font(Typo.code).foregroundStyle(Theme.ink).lineLimit(1).truncationMode(.middle)
                                if !parts.folder.isEmpty {
                                    Text(verbatim: parts.folder).font(Typo.meta).foregroundStyle(Theme.subtle).lineLimit(1).truncationMode(.head)
                                }
                            }
                            Spacer(minLength: 4)
                            VStack(alignment: .trailing, spacing: 0) {
                                Text("+\(f.added)").foregroundStyle(Theme.success)
                                Text("−\(f.removed)").foregroundStyle(Theme.negative)
                            }
                            .font(Typo.meta).monospacedDigit()
                        }
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(selected ? Theme.selected : .clear, in: RoundedRectangle(cornerRadius: Radius.control))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("\(f.path), +\(f.added) −\(f.removed)")
                    .accessibilityAddTraits(selected ? .isSelected : [])
                }
            }
            .padding(6)
        }
        .frame(width: 240)
        .clipped()
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
    private var folded: Bool { collapsible && files.review.isFolded(path) }
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
                            Text("+\(file.added)").foregroundStyle(Theme.success)
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
