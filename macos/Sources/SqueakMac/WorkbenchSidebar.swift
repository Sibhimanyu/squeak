import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md §8.10: the workbench sidebar. New chat and search, a Needs you group, then the Projects tree
// (project, workspace, chat), and at the foot the duck with one line of totals, Usage and Settings.
// Every list is newest first and the grouping is `SidebarTreeBuilder`'s (SqueakMacCore): this file only draws.

struct WorkbenchSidebar: View {
    @Environment(AppModel.self) private var model
    @FocusState private var searchFocused: Bool
    @State private var showConnection = false
    /// Folded projects and workspaces, kept across launches (newline-separated ids).
    @AppStorage("sidebarFolded") private var foldedRaw = ""

    private var folded: Set<String> { Set(foldedRaw.split(separator: "\n").map(String.init)) }

    private func toggleFold(_ id: String) {
        var set = folded
        if !set.insert(id).inserted { set.remove(id) }
        foldedRaw = set.sorted().joined(separator: "\n")
    }

    var body: some View {
        @Bindable var model = model
        let tree = model.sidebarTree
        VStack(alignment: .leading, spacing: 0) {
            Color.clear.frame(height: 44).background(WindowDragArea())
            VStack(spacing: Space.s) {
                Button { NewChatController.shared.show() } label: {
                    HStack(spacing: Space.s) {
                        Lucide(.plus, size: Metrics.iconSmall, color: Theme.muted)
                        Text("New chat")
                        Spacer(minLength: 0)
                        Text("⌘N").font(Typo.meta).foregroundStyle(Theme.subtle)
                    }
                }
                .buttonStyle(SecondaryButtonStyle())
                .accessibilityLabel("New chat")
                .help("New chat (⌘N)")
                SidebarSearchField(prompt: "Search chats…", text: $model.query, focused: $searchFocused, accessibilityLabel: "Search chats")
            }
            .padding(.horizontal, Space.m).padding(.bottom, Space.s)
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    if model.isSearching {
                        searchRows
                    } else {
                        if !tree.needsYou.isEmpty { needsYouGroup(tree) }
                        projects(tree)
                    }
                }
                .padding(.horizontal, Space.s).padding(.bottom, Space.m)
            }
            .scrollContentBackground(.hidden)
            footer(tree)
        }
        .frame(width: Metrics.workbenchSidebar)
        .frame(maxHeight: .infinity, alignment: .topLeading)
        .background(SidebarBackground())
        .task(id: model.hasLoaded) { await model.pollLiveSteps() }
        .background {
            // ⌘K focuses the search field, wherever focus is.
            Button("Search") { searchFocused = true }
                .keyboardShortcut("k", modifiers: .command)
                .opacity(0).accessibilityHidden(true)
        }
    }

    // MARK: Groups

    private func groupLabel(_ title: String, count: Int? = nil) -> some View {
        HStack(spacing: 6) {
            Text(title).font(Typo.meta).foregroundStyle(Theme.muted)
            if let count { Text("\(count)").font(Typo.meta).monospacedDigit().foregroundStyle(Theme.subtle) }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, Space.s).padding(.top, Space.m).padding(.bottom, 4)
        .accessibilityAddTraits(.isHeader)
    }

    private func needsYouGroup(_ tree: SidebarTree) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            groupLabel("Needs you", count: tree.needsYou.count)
            ForEach(tree.needsYou) { s in
                WorkbenchChatRow(session: s, metaOverride: Self.place(s, in: tree))
            }
        }
    }

    /// `repo · workspace` for a shortcut row, so the person can tell where the chat lives.
    private static func place(_ s: HostSession, in tree: SidebarTree) -> String {
        guard let p = tree.place(of: s.key) else { return HomeProjects.projectName(s) }
        return "\(p.project.name) · \(p.workspace.name)"
    }

    @ViewBuilder private func projects(_ tree: SidebarTree) -> some View {
        groupLabel("Projects")
        if tree.projects.isEmpty {
            Text("No chats yet").font(Typo.body).foregroundStyle(Theme.subtle).padding(.horizontal, Space.s).padding(.vertical, Space.s)
        }
        ForEach(tree.projects) { project in
            let projectFolded = folded.contains(project.id)
            FoldRow(
                title: project.name, folded: projectFolded, depth: 0, state: projectFolded ? project.topState : nil,
                tile: String(project.name.prefix(1)).uppercased(), time: project.lastActivityAt
            ) { toggleFold(project.id) }
            if !projectFolded {
                ForEach(project.workspaces) { workspace in
                    let wsFolded = folded.contains(workspace.id)
                    FoldRow(title: workspace.name, folded: wsFolded, depth: 1, state: wsFolded ? workspace.topState : nil, tile: nil,
                        subtitle: workspace.branchLabel, time: workspace.lastActivityAt) {
                        toggleFold(workspace.id)
                    }
                    if !wsFolded {
                        ForEach(workspace.chats) { s in WorkbenchChatRow(session: s, indent: 1) }
                    }
                }
            }
        }
    }

    @ViewBuilder private var searchRows: some View {
        let hits = model.searchHits
        if hits.isEmpty {
            Text("No matches. Search covers titles and messages Squeak has already opened on this Mac.")
                .font(Typo.body).foregroundStyle(Theme.muted).padding(Space.s)
        } else {
            ForEach(hits, id: \.key) { hit in
                if let s = model.session(hit.key) {
                    WorkbenchChatRow(session: s, metaOverride: hit.titleMatch ? nil : hit.snippet)
                }
            }
        }
    }

    // MARK: Footer

    private func footer(_ tree: SidebarTree) -> some View {
        HStack(spacing: Space.s) {
            Button { showConnection.toggle() } label: {
                HStack(spacing: Space.s) {
                    DuckMark(width: 28)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Squeak").font(Typo.label).foregroundStyle(Theme.ink)
                        Text(footerLine(tree)).font(Typo.meta).foregroundStyle(model.isConnected || !model.homeLoaded ? Theme.muted : Theme.offline).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Connection: \(model.homeConnectionText). \(footerLine(tree))")
            .popover(isPresented: $showConnection, arrowEdge: .trailing) { ConnectionPopover(dismiss: { showConnection = false }) }
            footerButton(.gauge, "Usage") { NewChatController.shared.hide(); model.closeSettings(); model.navFilter = .usage }
            footerButton(.settings, "Settings (⌘,)") { model.openSettings() }
        }
        .padding(.horizontal, Space.m).frame(height: 56)
        .overlay(alignment: .top) { Rectangle().fill(Theme.line).frame(height: 1) }
    }

    private func footerLine(_ tree: SidebarTree) -> String {
        if model.homeLoaded, !model.isConnected { return model.homeConnectionText }
        return tree.totals ?? "All quiet"
    }

    private func footerButton(_ name: LucideName, _ help: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Lucide(name, size: Metrics.icon + 2, color: Theme.muted).frame(width: 28, height: 28).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(help)
        .help(help)
    }
}

// MARK: - Rows

/// A project or workspace line: chevron, an optional neutral letter tile, the name, and while folded the one
/// dot for the highest-priority state inside (idle shows none).
private struct FoldRow: View {
    let title: String
    let folded: Bool
    let depth: Int
    let state: SessionSectionKind?
    let tile: String?
    var subtitle: String?
    var time: Date?
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Lucide(folded ? .chevronRight : .chevronDown, size: 11, color: Theme.subtle).frame(width: 12)
                if let tile {
                    Text(tile).font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.muted)
                        .frame(width: 18, height: 18)
                        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 5))
                        .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(Theme.line))
                } else {
                    Lucide(.gitBranch, size: 12, color: Theme.subtle).frame(width: 18)
                }
                Text(verbatim: title).font(depth == 0 ? Typo.label : Typo.body).foregroundStyle(depth == 0 ? Theme.ink : Theme.muted).lineLimit(1)
                if let subtitle, !subtitle.isEmpty {
                    Text(verbatim: subtitle).font(Typo.meta).foregroundStyle(Theme.subtle).lineLimit(1).truncationMode(.middle)
                        .layoutPriority(-1)
                }
                Spacer(minLength: 0)
                if let state { Circle().fill(Theme.color(for: Self.sessionState(state))).frame(width: 7, height: 7) }
                if let time { Text(RelativeAge.short(time)).font(Typo.meta).monospacedDigit().foregroundStyle(Theme.subtle) }
            }
            .padding(.leading, 6 + CGFloat(depth) * 14).padding(.trailing, Space.s)
            .frame(height: 28)
            .background(hovering ? Theme.selected.opacity(0.6) : .clear, in: RoundedRectangle(cornerRadius: Radius.control))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .accessibilityLabel("\(title), \(folded ? "folded" : "open")")
    }

    static func sessionState(_ k: SessionSectionKind) -> SessionState {
        switch k {
        case .needsYou: .blocked
        case .working: .working
        case .done: .finished
        case .error: .error
        case .idle: .idle
        }
    }
}

/// A chat, fixed at 40pt in every state so nothing jumps (§8.10): dot, title and age, then
/// `agent · state · what it is doing`, with the Conductor chip for Conductor's chats only.
struct WorkbenchChatRow: View {
    let session: HostSession
    var indent = 0
    var metaOverride: String?
    @Environment(AppModel.self) private var model
    @State private var hovering = false

    private var selected: Bool { model.selected == session.key && model.navFilter != .usage }

    private var meta: String {
        if let metaOverride { return metaOverride }
        let doing = session.state == .working ? model.liveStep(session.key) : nil
        return [SessionText.agent(session.agent), SessionText.stateWord(session), doing].compactMap { $0 }.joined(separator: " · ")
    }

    var body: some View {
        Button { model.select(session.key) } label: {
            HStack(alignment: .top, spacing: Space.s) {
                StateDot(state: session.state).frame(height: 18)
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 6) {
                        Text(verbatim: model.workbenchTitle(session)).font(Typo.label).foregroundStyle(Theme.ink).lineLimit(1)
                        Spacer(minLength: 0)
                        Text(RelativeAge.short(session.lastActivityAt)).font(Typo.meta).monospacedDigit().foregroundStyle(Theme.subtle)
                    }
                    .frame(height: 18)
                    HStack(spacing: 6) {
                        Text(verbatim: meta).font(Typo.meta).foregroundStyle(Theme.muted).lineLimit(1)
                        Spacer(minLength: 0)
                        if session.showsConductorBadge { ConductorChip() }
                    }
                    .frame(height: 15)
                }
            }
            .padding(.leading, Space.s + CGFloat(indent) * 14).padding(.trailing, Space.s)
            .frame(height: Metrics.chatRow)
            .background(selected ? Theme.selected : (hovering ? Theme.selected.opacity(0.6) : .clear), in: RoundedRectangle(cornerRadius: Radius.control))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .contextMenu {
            Button(model.pinned.contains(session.key) ? "Unpin" : "Pin to top") { model.togglePin(session.key) }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(model.workbenchTitle(session)), \(SessionText.stateWord(session))")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// The word "Conductor" as a tag (§8.10): `meta`, `radius-chip`, a `line-strong` border, `muted`.
struct ConductorChip: View {
    var body: some View {
        Text("Conductor").font(.system(size: 10)).foregroundStyle(Theme.muted)
            .padding(.horizontal, 5).frame(height: 15)
            .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Theme.lineStrong))
            .fixedSize()
    }
}

/// Lets a drag on empty chrome move the window (the toolbar is gone, so the title bar is ours).
struct WindowDragArea: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView { DragView() }
    func updateNSView(_ view: NSView, context: Context) {}
    private final class DragView: NSView {
        override var mouseDownCanMoveWindow: Bool { true }
    }
}
