import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md §8.10: the workbench sidebar. New chat and search, then the tree (project, workspace, chat) with no
// group headers, and at the foot the duck, "Squeak", Usage and Settings. A chat is one 28pt line: its title and
// a trailing slot that holds the age, or in its place the one mark (§8.1). No state words, no counts.
// Every list is newest first and the tree is `SidebarTreeBuilder`'s (SqueakMacCore): this file only draws.

struct WorkbenchSidebar: View {
    /// The pane's drawn width (the window owns it: remembered, clamped, dragged).
    var width: CGFloat = Metrics.workbenchSidebar
    @Environment(AppModel.self) private var model
    @FocusState private var searchFocused: Bool
    @State private var showConnection = false
    /// Folded projects and workspaces, kept across launches (newline-separated ids).
    @AppStorage("sidebarFolded") private var foldedRaw = ""

    /// Demo and capture runs keep their own folds (never the real ones), and start with one project folded so a
    /// capture shows a folded row's mark.
    @State private var demoFolded: Set<String> = ["atlas"]

    private var folded: Set<String> {
        model.demoMode ? demoFolded : Set(foldedRaw.split(separator: "\n").map(String.init))
    }

    private func toggleFold(_ id: String) {
        var set = folded
        if !set.insert(id).inserted { set.remove(id) }
        if model.demoMode { demoFolded = set } else { foldedRaw = set.sorted().joined(separator: "\n") }
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
                        projects(tree)
                    }
                }
                .padding(.horizontal, Space.s).padding(.bottom, Space.m)
            }
            .scrollContentBackground(.hidden)
            footer
        }
        .frame(width: width)
        .frame(maxHeight: .infinity, alignment: .topLeading)
        .background(SidebarBackground())
        .task(id: model.hasLoaded) { await model.pollLiveSteps() }
        .task(id: tree.projects.map(\.name)) { await model.refreshNativeProjects() }
        .background {
            // ⌘K focuses the search field, wherever focus is.
            Button("Search") { searchFocused = true }
                .keyboardShortcut("k", modifiers: .command)
                .opacity(0).accessibilityHidden(true)
        }
    }

    /// The host's project behind a project row, when Squeak runs chats there (the row's "+" appears only then).
    private func nativeProject(_ project: SidebarProject) -> NativeProject? {
        NativeWorkspaceMaking.project(named: project.name, in: model.native.projects)
    }

    // MARK: Tree

    @ViewBuilder private func projects(_ tree: SidebarTree) -> some View {
        if tree.projects.isEmpty {
            Text("No chats yet").font(Typo.body).foregroundStyle(Theme.subtle).padding(.horizontal, Space.s).padding(.vertical, Space.s)
        }
        ForEach(tree.projects) { project in
            let projectFolded = folded.contains(project.id)
            FoldRow(
                title: project.name, folded: projectFolded, depth: 0, mark: projectFolded ? project.foldedMark : nil,
                tile: String(project.name.prefix(1)).uppercased(), time: project.lastActivityAt,
                addWorkspace: nativeProject(project).map { p in { model.nativeMakeWorkspace(projectId: p.id) } },
                adding: nativeProject(project).map { model.native.makingWorkspaceIn == $0.id } ?? false
            ) { toggleFold(project.id) }
            if !projectFolded {
                ForEach(project.workspaces) { workspace in
                    let wsFolded = folded.contains(workspace.id)
                    FoldRow(title: workspace.name, folded: wsFolded, depth: 1, mark: wsFolded ? workspace.foldedMark : nil, tile: nil,
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
                    WorkbenchChatRow(session: s, snippet: hit.titleMatch ? nil : hit.snippet)
                }
            }
        }
    }

    // MARK: Footer

    private var footer: some View {
        HStack(spacing: Space.s) {
            Button { showConnection.toggle() } label: {
                HStack(spacing: Space.s) {
                    DuckMark(width: 28)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("Squeak").font(Typo.label).foregroundStyle(Theme.ink)
                        // Only an offline Squeak says anything more (§8.10): no counts, no "all quiet".
                        if model.homeLoaded, !model.isConnected {
                            Text(model.homeConnectionText).font(Typo.meta).foregroundStyle(Theme.offline).lineLimit(1)
                        }
                    }
                    Spacer(minLength: 0)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Connection: \(model.homeConnectionText)")
            .popover(isPresented: $showConnection, arrowEdge: .trailing) { ConnectionPopover(dismiss: { showConnection = false }) }
            footerButton(.gauge, "Usage") { NewChatController.shared.hide(); model.closeSettings(); model.navFilter = .usage }
            footerButton(.settings, "Settings (⌘,)") { model.openSettings() }
        }
        .padding(.horizontal, Space.m).frame(height: 56)
        .overlay(alignment: .top) { Rectangle().fill(Theme.line).frame(height: 1) }
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

/// A project or workspace line: chevron, an optional neutral letter tile, the name, and at the trailing edge the
/// age, or while folded the highest-priority mark inside in its place (only when a chat inside has one).
private struct FoldRow: View {
    let title: String
    let folded: Bool
    let depth: Int
    let mark: FoldedMark?
    let tile: String?
    var subtitle: String?
    var time: Date?
    /// A project row's "+" (new workspace), drawn over the age's slot on hover; nil on every other row.
    var addWorkspace: (() -> Void)?
    var adding = false
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        ZStack(alignment: .trailing) { row; plus }
            .onHover { hovering = $0 }
    }

    @ViewBuilder private var plus: some View {
        if let addWorkspace {
            Button(action: addWorkspace) {
                Group {
                    if adding { ProgressView().controlSize(.mini) } else { Lucide(.plus, size: 13, color: Theme.muted) }
                }
                .frame(width: 22, height: 22).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .opacity(hovering || adding ? 1 : 0)
            .disabled(adding)
            .padding(.trailing, 4)
            .help("New workspace in \(title)")
            .accessibilityLabel("New workspace in \(title)")
        }
    }

    private var row: some View {
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
                MarkSlot(mark: mark?.mark, words: mark?.words, age: time)
                    .opacity(addWorkspace != nil && (hovering || adding) ? 0 : 1)
            }
            .padding(.leading, 6 + CGFloat(depth) * 14).padding(.trailing, Space.s)
            .frame(height: 28)
            .background(hovering ? Theme.selected.opacity(0.6) : .clear, in: RoundedRectangle(cornerRadius: Radius.control))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel([title, folded ? "folded" : "open", mark?.words].compactMap { $0 }.joined(separator: ", "))
    }
}

/// A chat is one line, 28pt in every state (§8.2, §8.10): its title, the Conductor mark where Conductor holds it,
/// and the trailing slot, the age or in its place the one mark. A waiting or unread chat has its title in `ink`
/// semibold; every other is regular `muted`; the selected row is `ink`. The tooltip and VoiceOver carry the words.
struct WorkbenchChatRow: View {
    let session: HostSession
    var indent = 0
    /// A search hit's matched text, shown as the tooltip so the row stays one line.
    var snippet: String?
    @Environment(AppModel.self) private var model
    @State private var hovering = false

    private var selected: Bool { model.selected == session.key && model.navFilter != .usage }

    var body: some View {
        let mark = model.mark(for: session)
        let loud = mark?.kind == .waiting || mark?.kind == .unread
        Button { model.select(session.key) } label: {
            HStack(spacing: 6) {
                Text(verbatim: model.workbenchTitle(session)).font(loud ? Typo.label : Typo.body)
                    .foregroundStyle(selected || loud ? Theme.ink : Theme.muted).lineLimit(1)
                if session.showsConductorBadge { ConductorMarker() }
                Spacer(minLength: 0)
                MarkSlot(mark: mark, age: session.lastActivityAt)
            }
            .padding(.leading, Space.s + CGFloat(indent) * 14).padding(.trailing, Space.s)
            .frame(height: Metrics.chatRow)
            .background(selected ? Theme.selected : (hovering ? Theme.selected.opacity(0.6) : .clear), in: RoundedRectangle(cornerRadius: Radius.control))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .help(snippet ?? "")
        .contextMenu {
            Button(model.pinned.contains(session.key) ? "Unpin" : "Pin to top") { model.togglePin(session.key) }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel(SessionText.accessibility(title: model.workbenchTitle(session), mark: mark, last: session.lastActivityAt))
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

/// Conductor's own app icon (the bundled `agent-conductor.png`, the one the iPhone uses) after a title, 14pt,
/// where Conductor holds the chat. Tooltip "Conductor chat".
struct ConductorMarker: View {
    var size: CGFloat = 14

    var body: some View {
        AgentMark(.conductor, size: size).help("Conductor chat")
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
