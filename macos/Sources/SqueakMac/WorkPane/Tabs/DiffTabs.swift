import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md 8.12, diff tabs. Two item tabs share one header (Duck, branch, "Ask <Duck> to fix…"):
// a diff tab for one file, and the review-all tab for everything a Duck changed, which also carries the
// merge and PR controls (the Git cluster) that the classic layout keeps in the inspector and header.
// Line comments are the Changes tab's own: a comment collects in the tray and "Send to <Duck>" sends one message.

/// One file of one Duck's changes. Named flow: a person picks a changed file in the rail and reads its diff here.
struct PondDiffTab: View {
    let session: HostSession
    let path: String
    let files: FilesModel
    let close: () -> Void
    @Environment(AppModel.self) private var model

    var body: some View {
        let key = session.key.hostSessionId
        let store = model.changesStore(for: key)
        VStack(spacing: 0) {
            DiffTabHeaderBar(session: session, path: path, fileCount: 1, showsGit: false)
            Rectangle().fill(Theme.line).frame(height: 1)
            // A merged, deleted or reverted file says so; the tab never closes by itself.
            if let changes = store.changes, !changes.files.contains(where: { $0.path == path }) {
                DiffTabGone(message: "This file no longer has a diff.", close: close)
            } else {
                ScrollView { DiffFileSection(store: store, session: session, path: path, collapsible: false, files: files) }.clipped()
            }
            if !store.tray.isEmpty { CommentTray(store: store, session: session) }
        }
        .task(id: key) { await store.refresh(sessionKey: key, visible: true, activityChanged: true) }
    }
}

/// All of one Duck's changes in one tab, with the merge and PR controls.
/// Named flow: a person finishing a review reads every file, comments, then merges or opens the PR without leaving the tab.
struct PondReviewAllTab: View {
    let session: HostSession
    let files: FilesModel
    @Environment(AppModel.self) private var model

    var body: some View {
        let store = model.changesStore(for: session.key.hostSessionId)
        VStack(spacing: 0) {
            DiffTabHeaderBar(session: session, path: nil, fileCount: store.changes?.files.count ?? 0, showsGit: true)
            Rectangle().fill(Theme.line).frame(height: 1)
            ReviewView(files: files, session: session, showsBackButton: false)
            if !store.tray.isEmpty { CommentTray(store: store, session: session) }
        }
    }
}

/// The shared header: Duck, branch, what the tab shows, then "Ask <Duck> to fix…" and (review-all) Git controls.
private struct DiffTabHeaderBar: View {
    let session: HostSession
    let path: String?
    let fileCount: Int
    let showsGit: Bool
    @Environment(AppModel.self) private var model
    @State private var asking = false
    @State private var words = ""
    @State private var sending = false
    @State private var note: String?
    @FocusState private var focused: Bool

    var body: some View {
        let status = model.gitStatus(session)
        let header = DiffTabHeader(duck: model.composerDuckName(session), branch: status?.branch ?? session.branch,
                                   path: path, fileCount: fileCount)
        VStack(spacing: 0) {
            HStack(spacing: Space.s) {
                Text(verbatim: header.duck).font(Typo.label).foregroundStyle(Theme.ink).lineLimit(1).fixedSize()
                if let branch = header.branch {
                    HStack(spacing: 4) {
                        Lucide(.gitBranch, size: 11, color: Theme.muted)
                        Text(verbatim: branch).font(Typo.code).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.middle)
                    }
                    .padding(.horizontal, 7).frame(height: 22)
                    .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Theme.lineStrong))
                }
                if path != nil {
                    Text(verbatim: header.title).font(Typo.code).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.middle)
                }
                Spacer(minLength: Space.s)
                // Flow: the person sees something wrong and tells the Duck without switching to its chat.
                Button { asking.toggle() } label: { Text(header.askLabel).lineLimit(1).fixedSize() }
                    .buttonStyle(QuietButtonStyle())
                    .accessibilityLabel(header.askLabel)
                if showsGit, session.source == .squeak,
                   ReviewAllControls.shows(isSqueakChat: true, canSeeCode: model.focus.access.showsCode,
                                           isMain: status?.main ?? false, hasHistory: status?.noHistory == nil) {
                    GitCluster(session: session, showsBranch: false)
                }
            }
            .padding(.horizontal, Space.m).frame(height: 40).clipped()
            if asking { askBox(header) }
        }
        .background(Theme.bg)
    }

    private func askBox(_ header: DiffTabHeader) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            TextField(header.askPlaceholder, text: $words, axis: .vertical)
                .lineLimit(1...5).textFieldStyle(.plain).font(Typo.body).focused($focused)
                .padding(8)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.control))
                .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.lineStrong))
                .onSubmit { send(header) }
                .onExitCommand { asking = false }
                .accessibilityLabel(header.askPlaceholder)
            HStack(spacing: Space.s) {
                if let note { Text(verbatim: note).font(Typo.meta).foregroundStyle(Theme.negative) }
                Spacer(minLength: 0)
                Button("Cancel") { asking = false }.buttonStyle(QuietButtonStyle()).fixedSize()
                Button { send(header) } label: {
                    HStack(spacing: 6) {
                        if sending { TideGlyph(color: Theme.muted, grid: .mini) }
                        Text("Send to \(header.duck)").lineLimit(1)
                    }
                    .fixedSize()
                }
                .buttonStyle(PrimaryButtonStyle()).disabled(sending || header.askMessage(words) == nil)
            }
        }
        .padding(.horizontal, Space.m).padding(.bottom, Space.s)
        .onAppear { focused = true }
    }

    private func send(_ header: DiffTabHeader) {
        guard !sending, let text = header.askMessage(words) else { return }
        sending = true; note = nil
        Task {
            let result = await model.send(text, to: session.key, mode: .queue, clearsDraft: false)
            sending = false
            switch result {
            case .accepted?: words = ""; asking = false
            case .uncertain?: note = "Squeak can't tell whether that was sent."
            case .refused(let reason)?, .notSent(let reason)?: note = reason
            case nil: break
            }
        }
    }
}

private struct DiffTabGone: View {
    let message: String
    let close: () -> Void

    var body: some View {
        VStack(spacing: Space.s) {
            Text(verbatim: message).font(Typo.body).foregroundStyle(Theme.muted)
            // Flow: the source is gone (merged, reverted); the person closes the tab themselves.
            Button("Close tab", action: close).buttonStyle(SecondaryButtonStyle()).fixedSize()
        }
        .padding(Space.l).frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
