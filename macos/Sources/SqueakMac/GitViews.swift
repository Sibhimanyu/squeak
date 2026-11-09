import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md §8.10, git for a Squeak chat: the header's cluster (branch, ahead/behind, one action that follows the
// state, a menu with all of them), the inspector's PR tab, the merge confirm sheet and the ⌘⇧ shortcuts. The host
// reads the state and does the work; the primary choice is `GitPresentation.primary`.

/// Keeps one chat's git state fresh while the window shows it: every 10 s, and at once when its activity changed.
private struct GitRefresher: ViewModifier {
    let session: HostSession
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase

    func body(content: Content) -> some View {
        content
            .task(id: session.key.stringValue) {
                while !Task.isCancelled {
                    await model.refreshGit(session, visible: scenePhase != .background)
                    try? await Task.sleep(for: .seconds(GitPresentation.refreshInterval))
                }
            }
            .onChange(of: model.activity.count) {
                Task { await model.refreshGit(session, visible: scenePhase != .background, activityChanged: true) }
            }
    }
}

// MARK: Header

/// Branch chip with ahead/behind, then the one action, then the menu of them all. Not drawn for a chat that
/// has no Squeak workspace.
struct GitCluster: View {
    let session: HostSession
    /// The branch chip; the centre's breadcrumb carries the branch now, so the header turns it off.
    var showsBranch = true
    @Environment(AppModel.self) private var model
    @State private var checksOpen = false

    var body: some View {
        let status = model.gitStatus(session)
        HStack(spacing: Space.s) {
            if showsBranch { branchChip(status) }
            if let status {
                primary(status)
                actionsMenu(status)
            }
        }
        .modifier(GitRefresher(session: session))
    }

    private func branchChip(_ status: NativeGitStatus?) -> some View {
        let branch = status?.branch ?? session.branch
        return Group {
            if let branch, !branch.isEmpty {
                HStack(spacing: 4) {
                    Lucide(.gitBranch, size: 11, color: Theme.muted)
                    Text(verbatim: branch).font(Typo.code).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.middle)
                    if let status, let ab = GitPresentation.aheadBehind(status) {
                        Text(verbatim: ab).font(Typo.meta).monospacedDigit().foregroundStyle(Theme.subtle)
                            .help(GitPresentation.aheadBehindWords(status))
                    }
                }
                .padding(.horizontal, 7).frame(height: 22)
                .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Theme.lineStrong))
            }
        }
    }

    @ViewBuilder private func primary(_ status: NativeGitStatus) -> some View {
        switch GitPresentation.primary(status) {
        case .action(let kind)?:
            let busy = model.git.busy == kind
            // Secondary, never the duck: the composer's Send holds the one primary on screen (§8.10).
            Button { model.runGitAction(session, kind) } label: {
                HStack(spacing: 6) {
                    if busy { DotGridLoader(size: 12, quiet: true) }
                    Text(kind.title)
                }
                .font(Typo.label).foregroundStyle(Theme.ink)
                .padding(.horizontal, 10).frame(height: 24)
                .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.control))
                .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(model.git.busy != nil)
            .help(shortcutHelp(kind))
            .accessibilityLabel(kind.title)
        case .merged?:
            Text("Merged").font(Typo.body).foregroundStyle(Theme.muted)
        case .closed?:
            Text("Closed").font(Typo.body).foregroundStyle(Theme.muted)
        case nil:
            if let pr = status.pr, let mark = GitPresentation.checksMark(pr) { ChecksMarkView(mark: mark, words: GitPresentation.checksWords(pr)) }
        }
    }

    private func actionsMenu(_ status: NativeGitStatus) -> some View {
        Menu {
            ForEach(GitActionKind.menuOrder, id: \.self) { kind in
                Button(kind.title) { model.runGitAction(session, kind) }
                    .disabled(!GitPresentation.isEnabled(kind, status) || model.git.busy != nil)
            }
            Divider()
            Button("Open PR in browser") { model.openPullRequest(session) }.disabled(GitPresentation.prURL(status) == nil)
            // Checks left the panel's tabs: the pull request and its checks open from here.
            Button("Pull request and checks…") { checksOpen = true }
        } label: {
            Lucide(.chevronDown, size: 12, color: Theme.muted).frame(width: 24, height: 24).contentShape(Rectangle())
        }
        .popover(isPresented: $checksOpen, arrowEdge: .bottom) { PRTab(session: session).frame(width: 380, height: 420) }
        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
        .help(GitPresentation.note(status) ?? "Git actions")
        .accessibilityLabel("Git actions")
    }

    private func shortcutHelp(_ kind: GitActionKind) -> String {
        kind.shortcutKey.map { "\(kind.title) (⌘⇧\($0.uppercased()))" } ?? kind.title
    }
}

struct ChecksMarkView: View {
    let mark: GitPresentation.ChecksMark
    let words: String

    var body: some View {
        Group {
            switch mark {
            case .passing: Lucide(.circleCheck, size: 14, color: Theme.subtle)
            case .failing: Lucide(.circleX, size: 14, color: Theme.negative)
            case .running: DotGridLoader(size: 12)
            }
        }
        .frame(width: 16, height: 16)
        .help(words)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(words)
    }
}

// MARK: Shortcuts

/// ⌘⇧P create PR, ⌘⇧Y commit & push, ⌘⇧M merge, ⌘⇧X fix errors, ⌘⇧R review: Conductor's keys, live only for a Squeak
/// chat whose state allows the action (a disabled button never fires). Lives in the window's hidden button stack.
struct GitShortcuts: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let s = model.selectedSession, let status = model.gitStatus(s) {
            ForEach(GitActionKind.allCases.filter { $0.shortcutKey != nil }, id: \.self) { kind in
                Button(kind.title) { model.runGitAction(s, kind) }
                    .keyboardShortcut(KeyEquivalent(kind.shortcutKey!), modifiers: [.command, .shift])
                    .disabled(!GitPresentation.isEnabled(kind, status) || model.git.busy != nil)
            }
        }
    }
}

// MARK: Merge

struct MergeConfirmSheet: View {
    let confirm: MergeConfirm
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: Space.m) {
            Text("Merge #\(confirm.pr.number)?").font(Typo.heading).foregroundStyle(Theme.ink)
            Text(GitPresentation.mergeSentence(confirm.pr, base: confirm.base, method: confirm.method))
                .font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
            if let error = model.git.mergeError {
                Text(verbatim: error).font(Typo.body).foregroundStyle(Theme.negative).fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: Space.s) {
                Spacer(minLength: 0)
                Button("Cancel") { model.git.mergeConfirm = nil }.buttonStyle(SecondaryButtonStyle()).keyboardShortcut(.cancelAction)
                Button { model.confirmMerge() } label: {
                    HStack(spacing: 6) {
                        if model.git.merging { DotGridLoader(size: 12) }
                        Text("Merge")
                    }
                }
                .buttonStyle(PrimaryButtonStyle()).keyboardShortcut(.defaultAction).disabled(model.git.merging)
            }
        }
        .padding(Space.l).frame(width: 420)
        .background(Theme.surfaceRaised)
    }
}

// MARK: Inspector

/// Conductor's "PR status": the PR's number and own state word, the checks as a mark, the mergeable line and the
/// actions. Refreshes like Changes (10 s while on screen).
struct PRTab: View {
    let session: HostSession
    @Environment(AppModel.self) private var model

    var body: some View {
        let entry = model.hostId(session).map { model.git.entry($0) }
        ScrollView {
            VStack(alignment: .leading, spacing: Space.m) {
                if model.hostId(session) == nil {
                    quiet("Pull request status is for chats Squeak runs.")
                } else if let status = entry?.status {
                    content(status)
                } else {
                    quiet(entry?.loaded == true ? "No pull request to show for this chat." : "Reading the pull request…")
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Space.m)
        }
        .modifier(GitRefresher(session: session))
    }

    private func quiet(_ text: String) -> some View {
        Text(text).font(Typo.body).foregroundStyle(Theme.muted)
    }

    @ViewBuilder private func content(_ status: NativeGitStatus) -> some View {
        if let pr = status.pr {
            HStack(spacing: Space.s) {
                Text("Pull request #\(pr.number)").font(Typo.heading).foregroundStyle(Theme.ink)
                Text(GitPresentation.prWord(pr)).font(Typo.meta).foregroundStyle(Theme.muted)
                    .padding(.horizontal, 7).frame(height: 18)
                    .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Theme.lineStrong))
                Spacer(minLength: 0)
            }
            if pr.state == .open, let mark = GitPresentation.checksMark(pr) {
                HStack(spacing: 6) {
                    ChecksMarkView(mark: mark, words: GitPresentation.checksWords(pr))
                    Text("Checks").font(Typo.body).foregroundStyle(Theme.ink)
                }
            }
            if let line = GitPresentation.mergeableLine(status) { quiet(line) }
        } else {
            Text("Pull request").font(Typo.heading).foregroundStyle(Theme.ink)
            quiet(status.prMessage ?? "This branch has no pull request.")
        }
        branchLine(status)
        actions(status)
    }

    private func branchLine(_ status: NativeGitStatus) -> some View {
        let parts = [status.branch, GitPresentation.aheadBehind(status), status.dirty > 0 ? "\(status.dirty) uncommitted" : nil, "vs \(status.base)"]
        return Text(verbatim: parts.compactMap { $0 }.joined(separator: " · "))
            .font(Typo.meta).monospacedDigit().foregroundStyle(Theme.muted)
    }

    @ViewBuilder private func actions(_ status: NativeGitStatus) -> some View {
        let primary: GitActionKind? = if case .action(let k)? = GitPresentation.primary(status) { k } else { nil }
        let rest = GitActionKind.menuOrder.filter { $0 != primary && GitPresentation.isEnabled($0, status) }
        VStack(alignment: .leading, spacing: Space.s) {
            if let primary {
                Button(primary.title) { model.runGitAction(session, primary) }
                    .buttonStyle(SecondaryButtonStyle()).disabled(model.git.busy != nil)
            }
            ForEach(rest, id: \.self) { kind in
                Button(kind.title) { model.runGitAction(session, kind) }
                    .buttonStyle(QuietButtonStyle()).disabled(model.git.busy != nil)
            }
            if GitPresentation.prURL(status) != nil {
                Button("Open PR in browser") { model.openPullRequest(session) }.buttonStyle(QuietButtonStyle())
            }
        }
    }
}
