import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md 8.12: inside a Duck, the one top bar stays (Pond, switch, tabs) and this single subheader sits under it. Left to
// right: the Duck's Streams or branch chips, the Git actions (commit and push, create PR, merge), the rules shield (only
// when the chat has rules) and the ⋯ menu. There is no separate Duck header.
// Flow per control: a Stream chip opens the rail's Changes list narrowed to that Stream; the Git cluster commits, pushes,
// opens a pull request or merges; the shield lists what this chat may do without asking; the ⋯ menu holds Open in, sharing
// the chat with a shared Pond, Off duty and Delete Duck.

struct DuckSubheader: View {
    static let height: CGFloat = 40
    let session: HostSession
    let workspace: PondWorkspace
    @Environment(AppModel.self) private var model

    private var pondKey: String { workspace.pond }
    private var branch: String? { session.branch.flatMap { $0.isEmpty ? nil : $0 } }
    private var duckChrome: DuckHeaderChrome {
        let row = model.duckRow(session)
        return DuckHeaderChrome.of(branch: model.gitStatus(session)?.branch ?? row.branch, isMain: row.isMain, membership: model.focus.access)
    }

    var body: some View {
        HStack(spacing: Space.m) {
            streamChips
            // Reads the Duck's changes now and then so the rail's badge and review-all stay current; draws nothing.
            HeaderDiffstat(sessionKey: session.key.hostSessionId, activityStamp: model.activity.count).hidden().frame(width: 0)
            Spacer(minLength: Space.m)
            if session.source == .squeak, model.focus.access.showsCode, !model.ducksMode || duckChrome.showsCreatePR {
                GitCluster(session: session, showsBranch: false)
            }
            ChatRulesButton(session: session, hidesWhenEmpty: true)
            moreMenu
        }
        .padding(.horizontal, Space.xl).frame(height: Self.height)
    }

    /// The Streams this Duck is in, from the host's roster (join order).
    private var duckStreams: [RoomStream] { workspace.roster.ducks?.first { $0.id == session.duckId }?.streams ?? [] }

    /// One chip per Stream (its branch), or "Pond" for a Duck in none. A chat begun before Streams that still sits on a branch
    /// keeps its plain branch chip.
    @ViewBuilder private var streamChips: some View {
        let streams = duckStreams
        if !model.focus.access.showsCode {
            EmptyView() // a remote Pond keeps no code chrome
        } else if streams.isEmpty, duckChrome.chip != nil, !duckChrome.readOnly {
            DuckBranchChip(chrome: duckChrome).fixedSize().layoutPriority(-1)
        } else {
            HStack(spacing: Space.xs) {
                ForEach(DuckStreams.chips(streams)) { chip in StreamChip(chip: chip) }
            }
            .fixedSize().layoutPriority(-1)
        }
    }

    /// ⋯: the Duck's own actions. Items appear only when they serve a flow here.
    private var moreMenu: some View {
        let pond = PondsModel.shared.pond(key: pondKey)
        let detail = pond.flatMap { PondsModel.shared.details[$0.id] }
        let role = detail?.myRole ?? pond?.role ?? .owner
        let hostId = model.hostId(session)
        let canShare = ShareDuckRule.offered(
            sharedPond: pond.map { !$0.local } ?? false, canMessage: role.canMessage, hostId: hostId,
            sharedSessionIds: Set((detail?.threads ?? []).compactMap(\.sessionId)))
        return SqueakMenu {
            Button("Copy branch name") {
                if let b = branch { NSPasteboard.general.clearContents(); NSPasteboard.general.setString(b, forType: .string) }
            }.disabled(branch == nil)
            Button("Reveal folder in Finder") {
                if let p = session.cwd, FileManager.default.fileExists(atPath: p) { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: p)]) }
            }.disabled(session.cwd == nil)
            if canShare, let pond, let hostId {
                Divider()
                // Flow: the person is in this Duck's chat and wants the flock to see it. Not on the Dashboard: it has no Duck.
                SqueakMenu(ShareDuckWords.menu) {
                    Button(ShareDuckWords.withPond) { Task { await PondsModel.shared.share(pond: pond.id, sessionId: hostId) } }
                    Button(ShareDuckWords.privately) { Task { await PondsModel.shared.share(pond: pond.id, sessionId: hostId, isPrivate: true) } }
                }
            }
            if OpenInItems.isOffered(session, model: model) {
                Divider()
                OpenInItems(session: session)
            }
            if model.hasDuckLife(session) {
                Divider()
                // Flow: resting a Duck is a choice made here; closing its tab never changes duty.
                if model.isOnDuty(session) { Button("Off duty") { model.setDuty(session, on: false) } }
                else { Button(RoomRoster.bringBackTitle) { model.setDuty(session, on: true) } }
                Button("Delete Duck\u{2026}", role: .destructive) { model.confirmDeleteDuck(session) }
            }
        } label: {
            Lucide(.ellipsis, size: 15, color: Theme.muted).frame(width: 28, height: 28).contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
        .accessibilityLabel("More for this duck").help("Open in, share the chat, Off duty, Delete Duck")
    }
}

/// One Stream chip in a Duck's subheader. Flow: the person sees which Stream the Duck works in and clicks the chip to read what
/// changed there: the rail's Changes list opens narrowed to that Stream ("Pond": the Pond's own folder). The label is never cut.
private struct StreamChip: View {
    let chip: DuckStreamChip
    @Environment(AppModel.self) private var model
    @State private var hovering = false

    var body: some View {
        Button {
            if WorkPaneActions.showRail(.changes, model: model) {
                RailPopoverState.shared.showChanges(chip.workspaceId.map(RailChangeFilter.stream) ?? .pond)
            }
        } label: {
            HStack(spacing: 4) {
                if !chip.isPond { Lucide(.gitBranch, size: 11, color: Theme.muted) }
                Text(verbatim: chip.label).font(Typo.code).foregroundStyle(Theme.muted).fixedSize()
            }
            .padding(.horizontal, 7).frame(height: 22)
            .background(hovering ? Theme.selected : .clear, in: RoundedRectangle(cornerRadius: Radius.chip))
            .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Theme.lineStrong))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).pointerHand().onHover { hovering = $0 }
        .help(DuckStreams.chipHelp(chip))
        .accessibilityLabel(chip.isPond ? "Pond. Shows its changes" : "Stream \(chip.label). Shows its changes")
    }
}
