import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md §8.10, inspector: Changes (file rows, one file's diff open under its row, review comments on its lines)
// and the header diffstat; the Files tab is in FilesBrowser.swift. All read one ChangesStore.

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
    let session: HostSession
    let activityStamp: Int
    /// The panel's search words and its list or tree choice.
    var query = ""
    var asTree = false
    @Environment(AppModel.self) private var model
    private var sessionKey: String { session.key.hostSessionId }

    var body: some View {
        let store = model.changesStore(for: sessionKey)
        VStack(spacing: 0) {
            changesList(store)
            if !store.tray.isEmpty { CommentTray(store: store, session: session) }
        }
        .task(id: sessionKey) { await store.refresh(sessionKey: sessionKey, visible: true, activityChanged: true) }
    }

    private func changesList(_ store: ChangesStore) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                if let c = store.changes {
                    if c.files.isEmpty {
                        Text("No changes against \(c.base ?? "HEAD") yet.").font(Typo.body).foregroundStyle(Theme.muted).padding(Space.m)
                    } else {
                        // "850 files changed" with the totals at the right, then one row per file.
                        HStack {
                            Text(ChangeListing.header(count: c.files.count)).font(.system(size: 16)).foregroundStyle(Theme.ink)
                            Spacer(minLength: 8)
                            HStack(spacing: 6) {
                                Text("+\(c.added)").foregroundStyle(Theme.working)
                                Text("−\(c.removed)").foregroundStyle(Theme.negative)
                            }
                            .font(.system(size: 12, design: .monospaced)).monospacedDigit()
                        }
                        .padding(.horizontal, Space.m).padding(.vertical, 10)
                        let files = ChangeListing.filter(c.files, query: query)
                        if files.isEmpty {
                            Text("No changed file matches.").font(Typo.body).foregroundStyle(Theme.muted).padding(.horizontal, Space.m)
                        } else if asTree {
                            ForEach(ChangesPresentation.byFolder(files), id: \.folder) { group in
                                if !group.folder.isEmpty {
                                    Text(verbatim: group.folder + "/").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.muted)
                                        .padding(.horizontal, Space.m).padding(.top, 8).padding(.bottom, 2)
                                }
                                rows(group.files, showsFolder: false, store: store)
                            }
                        } else {
                            rows(files, showsFolder: true, store: store)
                        }
                    }
                } else {
                    Text(store.phase == .loading ? "Reading the changes…" : "No changes to show for this chat.")
                        .font(Typo.body).foregroundStyle(Theme.muted).padding(Space.m)
                }
            }
            .padding(.bottom, Space.m)
        }
    }

    @ViewBuilder private func rows(_ files: [DaemonChanges.File], showsFolder: Bool, store: ChangesStore) -> some View {
        ForEach(files) { file in
            ChangeRow(file: file, open: store.selectedPath == file.path, showsFolder: showsFolder) {
                Task { await store.select(file.path, sessionKey: sessionKey) }
            }
            if store.selectedPath == file.path { DiffBody(store: store).padding(.horizontal, Space.s) }
        }
    }
}

struct StatusLetter: View {
    let status: String
    var body: some View {
        Text(status).font(Typo.code).fontWeight(.semibold).foregroundStyle(color).frame(width: 14)
            .accessibilityLabel(word)
    }
    private var color: Color { status == "A" ? Theme.working : status == "D" ? Theme.negative : Theme.muted }
    private var word: String { ["A": "Added", "D": "Deleted", "R": "Renamed"][status] ?? "Modified" }
}

/// One changed file: the folder dimmed and the name bright, then +n (and −n) and a small status square at the right.
private struct ChangeRow: View {
    let file: DaemonChanges.File
    let open: Bool
    var showsFolder = true
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        let parts = ChangeListing.split(file.path)
        Button(action: action) {
            HStack(spacing: 8) {
                HStack(spacing: 0) {
                    if showsFolder, !parts.folder.isEmpty {
                        Text(verbatim: parts.folder).foregroundStyle(Theme.subtle).lineLimit(1).truncationMode(.head).layoutPriority(-1)
                    }
                    Text(verbatim: parts.name).foregroundStyle(Theme.ink).lineLimit(1).truncationMode(.middle)
                }
                .font(.system(size: 14))
                Spacer(minLength: 4)
                HStack(spacing: 5) {
                    if file.added > 0 { Text("+\(file.added)").foregroundStyle(Theme.working) }
                    if file.removed > 0 { Text("−\(file.removed)").foregroundStyle(Theme.negative) }
                }
                .font(.system(size: 12, design: .monospaced)).monospacedDigit().fixedSize()
                StatusSquare(status: file.status)
            }
            .padding(.horizontal, Space.m).frame(height: 38)
            .background(open || hovering ? Theme.selected.opacity(open ? 1 : 0.5) : .clear)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(file.path), +\(file.added) −\(file.removed)")
        .accessibilityAddTraits(open ? .isSelected : [])
    }
}

/// A 14pt outlined square: "+" added (green), "−" deleted (red), a dot for modified or renamed.
struct StatusSquare: View {
    let status: String
    var body: some View {
        let color: Color = status == "A" ? Theme.working : status == "D" ? Theme.negative : Theme.muted
        RoundedRectangle(cornerRadius: 3).strokeBorder(color, lineWidth: 1).frame(width: 14, height: 14)
            .overlay {
                if status == "A" { Lucide(.plus, size: 9, color: color) }
                else if status == "D" { Rectangle().fill(color).frame(width: 6, height: 1.2) }
                else { Circle().fill(color).frame(width: 4, height: 4) }
            }
            .accessibilityLabel(["A": "Added", "D": "Deleted", "R": "Renamed"][status] ?? "Modified")
    }
}

/// The open file's diff: mono, added on a 12% tint of `working`, removed on 12% of `needs-you` (§8.10). A click on a
/// line's gutter opens a comment box under it (shift-click extends to a range); comments sit under their last line.
private struct DiffBody: View {
    let store: ChangesStore

    var body: some View {
        Group {
            if let patch = store.patch {
                let lines = DiffParser.lines(patch.patch)
                if lines.isEmpty {
                    note("No textual diff to show.")
                } else {
                    let path = store.selectedPath ?? patch.path
                    let draft = store.draft?.path == path ? store.draft : nil
                    let placed = Dictionary(grouping: store.trayComments(in: path), by: { DiffComments.anchorIndex(of: $0, in: lines) ?? -1 })
                    let hosted = Dictionary(grouping: store.hostComments.filter { $0.file == path }, by: { DiffComments.anchorIndex(ofHost: $0, in: lines) ?? -1 })
                    ScrollView(.horizontal, showsIndicators: false) {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(Array(lines.enumerated()), id: \.offset) { i, line in
                                DiffLineView(
                                    line: line, selected: draft?.range.contains(i) == true, commented: placed[i] != nil || hosted[i] != nil,
                                    onGutter: { extend in store.gutterClick(path: path, index: i, extend: extend) })
                                ForEach(hosted[i] ?? []) { c in HostCommentCard(comment: c, store: store) }
                                ForEach(placed[i] ?? []) { c in DiffCommentCard(comment: c, store: store) }
                                if let draft, draft.range.upperBound == i { DiffCommentComposer(store: store, lines: lines, range: draft.range) }
                            }
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
    let selected: Bool
    let commented: Bool
    let onGutter: (Bool) -> Void
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 6) {
            gutter
            Text(verbatim: line.text.isEmpty ? " " : line.text).foregroundStyle(textColor)
        }
        .font(Typo.code).monospacedDigit().lineLimit(1)
        .padding(.horizontal, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(tint)
        .overlay { if selected { Theme.selected.opacity(0.7).allowsHitTesting(false) } }
        .onHover { hovering = $0 }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(kindWord) \(line.text)")
    }

    private var commentable: Bool { DiffComments.isCommentable(line) }

    /// The line number; on hover a plus, and a click comments on the line (shift-click extends the selection).
    @ViewBuilder private var gutter: some View {
        if commentable {
            Button { onGutter(NSEvent.modifierFlags.contains(.shift)) } label: {
                ZStack(alignment: .trailing) {
                    if hovering || selected {
                        Lucide(.plus, size: 11, color: Theme.ink).frame(width: 30, alignment: .trailing)
                    } else if commented {
                        Lucide(.messageSquare, size: 11, color: Theme.muted).frame(width: 30, alignment: .trailing)
                    } else {
                        Text(number).foregroundStyle(Theme.subtle).frame(width: 30, alignment: .trailing)
                    }
                }
                .frame(width: 30, alignment: .trailing).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Comment on this line (shift-click another line for a range)")
            .accessibilityLabel("Comment on line \(number)")
        } else {
            Text(number).frame(width: 30, alignment: .trailing).foregroundStyle(Theme.subtle)
        }
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

// MARK: Review comments

/// The box under the selected lines: words, then Comment. Return adds it, Esc cancels.
private struct DiffCommentComposer: View {
    let store: ChangesStore
    let lines: [DiffLine]
    let range: ClosedRange<Int>
    @FocusState private var focused: Bool

    var body: some View {
        let label = range.upperBound < lines.count ? DiffComments.rangeLabel(Array(lines[range])) : "?"
        VStack(alignment: .leading, spacing: 6) {
            Text("Comment on line \(label)").font(Typo.meta).foregroundStyle(Theme.muted)
            TextField("Say what to change", text: Bindable(store).draftText, axis: .vertical)
                .lineLimit(1...6).textFieldStyle(.plain).font(Typo.body).focused($focused)
                .padding(8)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.control))
                .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.lineStrong))
                .onSubmit { store.commitDraft(lines: lines) }
                .onExitCommand { store.cancelDraft() }
                .accessibilityLabel("Review comment")
            HStack(spacing: Space.s) {
                Spacer(minLength: 0)
                Button("Cancel") { store.cancelDraft() }.buttonStyle(QuietButtonStyle())
                Button("Comment") { store.commitDraft(lines: lines) }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(store.draftText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(8).frame(width: 280, alignment: .leading)
        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.control))
        .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
        .padding(.leading, 40).padding(.vertical, 4)
        .onAppear { focused = true }
    }
}

/// An open comment from the host under its line: the person's, or an agent's (marked), resolved with the check.
private struct HostCommentCard: View {
    let comment: NativeComment
    let store: ChangesStore

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            Lucide(.messageSquare, size: 11, color: Theme.muted).padding(.top, 2)
            VStack(alignment: .leading, spacing: 2) {
                if comment.isAgent { Text("Agent").font(Typo.meta).foregroundStyle(Theme.muted) }
                Text(verbatim: comment.body).font(Typo.body).foregroundStyle(Theme.ink)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            Button { store.resolveHostComment(comment.id) } label: {
                Lucide(.check, size: 11, color: Theme.muted).frame(width: 18, height: 18).contentShape(Rectangle())
            }
            .buttonStyle(.plain).help("Resolve this comment").accessibilityLabel("Resolve comment")
        }
        .padding(8).frame(width: 280, alignment: .leading)
        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.control))
        .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
        .padding(.leading, 40).padding(.vertical, 4)
    }
}

/// A saved comment under its line, until it is sent or removed.
private struct DiffCommentCard: View {
    let comment: DiffComment
    let store: ChangesStore

    var body: some View {
        HStack(alignment: .top, spacing: 6) {
            Lucide(.messageSquare, size: 11, color: Theme.muted).padding(.top, 2)
            Text(verbatim: comment.text).font(Typo.body).foregroundStyle(Theme.ink)
                .fixedSize(horizontal: false, vertical: true).frame(maxWidth: .infinity, alignment: .leading)
            Button { store.removeComment(comment.id) } label: {
                Lucide(.x, size: 11, color: Theme.muted).frame(width: 18, height: 18).contentShape(Rectangle())
            }
            .buttonStyle(.plain).help("Remove this comment").accessibilityLabel("Remove comment")
        }
        .padding(8).frame(width: 280, alignment: .leading)
        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.control))
        .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
        .padding(.leading, 40).padding(.vertical, 4)
    }
}

/// The comments waiting to be sent, under the file list: "Send to chat" sends them as one message and clears them.
struct CommentTray: View {
    let store: ChangesStore
    let session: HostSession
    /// The Review tab shows the list open and as tall as it needs; under Changes it starts folded.
    var startsOpen = false
    @Environment(AppModel.self) private var model
    @State private var expanded: Bool

    init(store: ChangesStore, session: HostSession, startsOpen: Bool = false) {
        self.store = store; self.session = session; self.startsOpen = startsOpen
        _expanded = State(initialValue: startsOpen)
    }

    var body: some View {
        let count = store.tray.count
        VStack(spacing: 0) {
            Rectangle().fill(Theme.line).frame(height: 1)
            if expanded {
                ScrollView {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(store.tray.comments) { c in
                            HStack(alignment: .top, spacing: 6) {
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(verbatim: "\(c.path):\(c.label)").font(Typo.code).foregroundStyle(Theme.muted)
                                        .lineLimit(1).truncationMode(.head)
                                    Text(verbatim: c.text).font(Typo.body).foregroundStyle(Theme.ink).lineLimit(3)
                                }
                                Spacer(minLength: 4)
                                Button { store.removeComment(c.id) } label: {
                                    Lucide(.x, size: 11, color: Theme.muted).frame(width: 18, height: 18).contentShape(Rectangle())
                                }
                                .buttonStyle(.plain).accessibilityLabel("Remove comment")
                            }
                        }
                    }
                    .padding(Space.m)
                }
                .frame(maxHeight: startsOpen ? .infinity : 160)
            }
            HStack(spacing: Space.s) {
                Button { expanded.toggle() } label: {
                    HStack(spacing: 5) {
                        Lucide(expanded ? .chevronDown : .chevronRight, size: 11, color: Theme.muted)
                        Text("\(count) review \(count == 1 ? "comment" : "comments")").font(Typo.label).foregroundStyle(Theme.ink)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                Spacer(minLength: 0)
                Button("Clear") { store.clearTray() }.buttonStyle(QuietButtonStyle()).disabled(store.sending)
                Button { send() } label: {
                    HStack(spacing: 6) {
                        if store.sending { DotGridLoader(size: 12) }
                        Text("Send to chat")
                    }
                }
                .buttonStyle(PrimaryButtonStyle()).disabled(store.sending)
                .help("Sends the comments to this chat as one message")
            }
            .padding(.horizontal, Space.m).frame(height: 40)
            if let note = store.sendNote {
                Text(verbatim: note).font(Typo.meta).foregroundStyle(Theme.negative)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, Space.m).padding(.bottom, Space.s)
            }
        }
        .background(Theme.sidebar)
    }

    /// One message to the chat (queued behind a turn in progress, like any send). The composer's own draft is left
    /// alone, and the comments stay unless the send was accepted.
    private func send() {
        guard !store.sending else { return }
        let text = store.tray.message
        store.sending = true
        store.sendNote = nil
        Task {
            let result = await model.send(text, to: session.key, mode: .queue, clearsDraft: false)
            store.sending = false
            switch result {
            case .accepted?: store.clearTray()
            case .uncertain?: store.sendNote = "Squeak can't tell whether that was sent. Check the chat before sending again."
            case .refused(let reason)?, .notSent(let reason)?: store.sendNote = reason
            case nil: break
            }
        }
    }
}
