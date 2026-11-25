import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md 8.12: a Duck's chat has the same one top bar as the Dashboard and the Room (never a header row plus a strip row).
// Left to right: the Pond's icon and name (a way back to the Pond), the Duck's name and branch chip, a divider, the Pond's
// strip (Duck circles, item pills), the rules shield (only when the chat has rules), and one ⋯ menu.
// Flow per control: the Pond name takes the person back to the Pond; the circles and pills switch Duck or item; the
// shield lists what this chat may do without asking; the ⋯ menu holds the Duck's own actions (copy its branch, reveal its
// folder, share its chat with a shared Pond, open it in its app). There is no Git cluster: review-all carries merge and the PR.

struct DuckTopBar: View {
    let session: HostSession
    let workspace: PondWorkspace
    let strip: PondWorkspaceStrip
    let sidebarHidden: Bool
    @Environment(AppModel.self) private var model

    private var pondKey: String { workspace.pond }
    private var branch: String? { session.branch.flatMap { $0.isEmpty ? nil : $0 } }
    private var duckChrome: DuckHeaderChrome {
        let row = model.duckRow(session)
        return DuckHeaderChrome.of(branch: model.gitStatus(session)?.branch ?? row.branch, isMain: row.isMain, membership: model.focus.access)
    }
    private var sidebarClearance: CGFloat {
        sidebarHidden ? PaneToggle.clearance(fullScreen: true, revealed: model.fullScreenLightsRevealed) + PaneToggle.barPadding + PaneToggle.size : 0
    }

    var body: some View {
        let name = PondsModel.shared.name(key: pondKey)
        HStack(spacing: Space.m) {
            let inset = PondPageChrome.headerInset(sidebarClearance: Double(sidebarClearance))
            if inset > 0 { Color.clear.frame(width: CGFloat(inset)) }
            Button { WorkbenchNav.openProject(model, key: pondKey, resuming: false) } label: {
                HStack(spacing: Space.s) {
                    PondTile(name: name, pondId: PondsModel.shared.pond(key: pondKey)?.id, projectId: workspace.project.id, size: 28)
                    Text(verbatim: name).font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(1).fixedSize()
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain).pointerHand()
            .help(PondWords.breadcrumb(name)).accessibilityLabel(PondWords.breadcrumb(name))
            Lucide(.chevronRight, size: 12, color: Theme.subtle).accessibilityHidden(true)
            // The Duck's own title is user text: it is the one thing here that may shorten (the full title is its tooltip).
            Text(verbatim: model.workbenchTitle(session)).font(.system(size: 15, weight: .medium)).foregroundStyle(Theme.ink)
                .lineLimit(1).truncationMode(.tail).frame(maxWidth: 320, alignment: .leading).fixedSize(horizontal: true, vertical: false)
                .help(model.workbenchTitle(session))
            streamChips
            // Reads the Duck's changes now and then so the rail's badge and review-all stay current; draws nothing.
            HeaderDiffstat(sessionKey: session.key.hostSessionId, activityStamp: model.activity.count).hidden().frame(width: 0)
            if !strip.isEmpty { Rectangle().fill(Theme.line).frame(width: 1, height: 22).accessibilityHidden(true) }
            PondWorkspaceTabStrip(workspace: workspace, strip: strip, embedded: true).frame(maxWidth: .infinity)
            if strip.isEmpty { Spacer(minLength: 0) }
            ChatRulesButton(session: session, hidesWhenEmpty: true)
            moreMenu
        }
        .padding(.horizontal, Space.xl).frame(height: Metrics.header).background(WindowDragArea())
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.line).frame(height: 1) }
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
        } label: {
            Lucide(.ellipsis, size: 15, color: Theme.muted).frame(width: 28, height: 28).contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
        .accessibilityLabel("More for this duck").help("Copy the branch, reveal the folder, share the chat")
    }
}

/// One Stream chip in a Duck's top bar. Flow: the person sees which Stream the Duck works in and clicks the chip to read what
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
