import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md §8.10, inspector: Changes (file rows, one file's diff open under its row) and Files (the changed files
// by folder; a full file browser is not built yet), and the header diffstat. All three read one ChangesStore.

/// `+142 −38 · 6 files`, tabular, in the toolbar. Drives its chat's polling while the window shows it.
struct HeaderDiffstat: View {
    let sessionKey: String
    let activityStamp: Int
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        let store = model.changesStore(for: sessionKey)
        Group {
            if let c = store.changes, !c.files.isEmpty {
                HStack(spacing: 6) {
                    Text("+\(c.added)").foregroundStyle(Theme.working)
                    Text("−\(c.removed)").foregroundStyle(Theme.negative)
                    Text("· \(c.files.count) \(c.files.count == 1 ? "file" : "files")").foregroundStyle(Theme.muted)
                }
                .font(Typo.code).monospacedDigit().lineLimit(1)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(c.added) lines added, \(c.removed) removed, \(c.files.count) files")
            }
        }
        .task(id: sessionKey) {
            while !Task.isCancelled {
                await store.refresh(sessionKey: sessionKey, visible: scenePhase != .background)
                try? await Task.sleep(for: .seconds(ChangesPresentation.refreshInterval))
            }
        }
        .onChange(of: activityStamp) {
            Task { await store.refresh(sessionKey: sessionKey, visible: scenePhase != .background, activityChanged: true) }
        }
    }
}

struct ChangesTab: View {
    let sessionKey: String
    let activityStamp: Int
    @Environment(AppModel.self) private var model

    var body: some View {
        let store = model.changesStore(for: sessionKey)
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if let c = store.changes {
                    if c.files.isEmpty {
                        Text("No changes against \(c.base ?? "HEAD") yet.").font(Typo.body).foregroundStyle(Theme.muted)
                    } else {
                        Text(ChangesPresentation.summary(c)).font(Typo.meta).monospacedDigit().foregroundStyle(Theme.muted)
                            .padding(.bottom, Space.s)
                        ForEach(c.files) { file in
                            ChangeRow(file: file, open: store.selectedPath == file.path) {
                                Task { await store.select(file.path, sessionKey: sessionKey) }
                            }
                            if store.selectedPath == file.path { DiffBody(store: store) }
                        }
                    }
                } else {
                    Text(store.phase == .loading ? "Reading the changes…" : "No changes to show for this chat.")
                        .font(Typo.body).foregroundStyle(Theme.muted)
                }
            }
            .padding(Space.m)
        }
        .task(id: sessionKey) { await store.refresh(sessionKey: sessionKey, visible: true, activityChanged: true) }
    }
}

struct FilesTab: View {
    let sessionKey: String
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
                Text("Showing the files this chat changed. A full file browser is not built yet.")
                    .font(Typo.meta).foregroundStyle(Theme.subtle).padding(.top, Space.m)
            }
            .padding(Space.m)
        }
        .task(id: sessionKey) { await store.refresh(sessionKey: sessionKey, visible: true, activityChanged: true) }
    }
}

private struct StatusLetter: View {
    let status: String
    var body: some View {
        Text(status).font(Typo.code).fontWeight(.semibold).foregroundStyle(color).frame(width: 14)
            .accessibilityLabel(word)
    }
    private var color: Color { status == "A" ? Theme.working : status == "D" ? Theme.negative : Theme.muted }
    private var word: String { ["A": "Added", "D": "Deleted", "R": "Renamed"][status] ?? "Modified" }
}

private struct ChangeRow: View {
    let file: DaemonChanges.File
    let open: Bool
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                StatusLetter(status: file.status)
                Text(verbatim: file.path).font(Typo.code).foregroundStyle(Theme.ink).lineLimit(1).truncationMode(.head)
                Spacer(minLength: 4)
                HStack(spacing: 4) {
                    if file.added > 0 { Text("+\(file.added)").foregroundStyle(Theme.working) }
                    if file.removed > 0 { Text("−\(file.removed)").foregroundStyle(Theme.negative) }
                }
                .font(Typo.meta).monospacedDigit()
            }
            .padding(.horizontal, 6).frame(height: 28)
            .background(open || hovering ? Theme.selected : .clear, in: RoundedRectangle(cornerRadius: Radius.row))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .accessibilityAddTraits(open ? .isSelected : [])
    }
}

/// The open file's diff: mono, added on a 12% tint of `working`, removed on 12% of `needs-you` (§8.10).
private struct DiffBody: View {
    let store: ChangesStore

    var body: some View {
        Group {
            if let patch = store.patch {
                let lines = DiffParser.lines(patch.patch)
                if lines.isEmpty {
                    note("No textual diff to show.")
                } else {
                    ScrollView(.horizontal, showsIndicators: false) {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(Array(lines.enumerated()), id: \.offset) { _, line in DiffLineView(line: line) }
                        }
                        .fixedSize(horizontal: true, vertical: false)
                        .frame(minWidth: 280, alignment: .leading)
                    }
                    if patch.truncated { note("Diff cut at 400 KB.").padding(.top, 4) }
                }
            } else {
                note(store.patchLoading ? "Reading the diff…" : "Could not read this file's diff.")
            }
        }
        .padding(.vertical, 6)
        .background(Theme.bg, in: RoundedRectangle(cornerRadius: Radius.control))
        .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
        .padding(.vertical, 4)
    }

    private func note(_ s: String) -> some View {
        Text(s).font(Typo.meta).foregroundStyle(Theme.subtle).padding(.horizontal, 8)
    }
}

private struct DiffLineView: View {
    let line: DiffLine

    var body: some View {
        HStack(spacing: 6) {
            Text(number).frame(width: 30, alignment: .trailing).foregroundStyle(Theme.subtle)
            Text(verbatim: line.text.isEmpty ? " " : line.text).foregroundStyle(textColor)
        }
        .font(Typo.code).monospacedDigit().lineLimit(1)
        .padding(.horizontal, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tint)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(kindWord) \(line.text)")
    }

    private var number: String { (line.newNumber ?? line.oldNumber).map(String.init) ?? "" }
    private var textColor: Color { line.kind == .hunk || line.kind == .note ? Theme.subtle : Theme.ink }
    private var tint: Color {
        switch line.kind {
        case .added: Theme.working.opacity(0.12)
        case .removed: Theme.negative.opacity(0.12)
        default: .clear
        }
    }
    private var kindWord: String {
        switch line.kind {
        case .added: "Added"
        case .removed: "Removed"
        default: ""
        }
    }
}
