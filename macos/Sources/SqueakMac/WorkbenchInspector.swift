import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md §8.10, the right panel (30% of the window until dragged, closed by default), split in two like the
// target's: the git primary action on a top row; the upper part's tabs (All files, Changes with its count, Review,
// then search, a tree/list toggle and ···); and the lower part's own tab row (a collapse chevron, Setup, Run,
// Terminal, +), where the terminal lives now. ⌘J shows and hides the lower part.

struct WorkbenchInspector: View {
    let session: HostSession?
    @Binding var tab: InspectorTab
    var width: CGFloat = Metrics.workbenchInspector
    @Environment(AppModel.self) private var model
    @AppStorage("terminalOpen") private var lowerOpen = false
    @AppStorage("inspectorLowerTab") private var lowerRaw = InspectorLowerTab.terminal.rawValue
    @AppStorage("terminalPanelHeight") private var lowerHeight = TerminalPanelSizing.defaultHeight
    @AppStorage("changesAsTree") private var asTree = false
    @State private var searching = false
    @State private var query = ""
    @State private var columnHeight: Double = 800
    @State private var dragStart: Double?

    private var native: Bool { session?.source == .squeak }
    private var lowerTab: InspectorLowerTab { InspectorLowerTab.restored(lowerRaw, native: native) }
    private var shownLower: Double { TerminalPanelSizing.clamp(lowerHeight, column: columnHeight) }

    var body: some View {
        VStack(spacing: 0) {
            gitRow
            tabRow
            if searching && tab == .changes { searchField }
            Rectangle().fill(Theme.line).frame(height: 1)
            upper.frame(maxHeight: .infinity)
            lower
        }
        .frame(width: width)
        .frame(maxHeight: .infinity)
        .background(Theme.bg.ignoresSafeArea())
        .overlay(alignment: .leading) { Rectangle().fill(Theme.line).frame(width: 1).ignoresSafeArea() }
        .background(GeometryReader { g in
            Color.clear.onAppear { columnHeight = g.size.height }.onChange(of: g.size.height) { _, h in columnHeight = h }
        })
        .onChange(of: lowerOpen) { _, isOpen in if isOpen, lowerTab == .terminal { TerminalHost.shared.focusPending = true } }
        .onChange(of: tab) { _, new in if new != .changes { searching = false; query = "" } }
    }

    // MARK: Top

    /// The git primary action (Create PR with its dropdown) above the panel, as the target puts it.
    private var gitRow: some View {
        HStack(spacing: Space.s) {
            Color.clear.frame(width: PaneToggle.size, height: PaneToggle.size)   // the toggle (PaneToggleOverlay)
            Spacer(minLength: 0)
            if let session, native { GitCluster(session: session, showsBranch: false) }
        }
        .padding(.horizontal, Space.m).frame(height: Metrics.header).background(WindowDragArea())
    }

    private var changeCount: Int? {
        guard let session, let c = model.changesStore(for: session.key.hostSessionId).changes, !c.files.isEmpty else { return nil }
        return c.files.count
    }

    private var tabRow: some View {
        HStack(spacing: 2) {
            ForEach(InspectorTab.available(native: native)) { t in
                Button { tab = t } label: {
                    HStack(spacing: 5) {
                        Text(t.title).font(.system(size: 14, weight: tab == t ? .medium : .regular))
                            .foregroundStyle(tab == t ? Theme.ink : Theme.muted)
                        if t == .changes, let n = changeCount {
                            Text("\(n)").font(.system(size: 12)).monospacedDigit().foregroundStyle(Theme.subtle)
                        }
                    }
                    .padding(.horizontal, 10).frame(height: 30)
                    .background(tab == t ? Theme.selected : .clear, in: RoundedRectangle(cornerRadius: Radius.control))
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(tab == t ? .isSelected : [])
            }
            Spacer(minLength: 0)
            if tab == .changes {
                iconButton(.search, searching ? "Close search" : "Search changed files", on: searching) { searching.toggle(); if !searching { query = "" } }
                iconButton(asTree ? .list : .folderTree, asTree ? "Show as a list" : "Show as a tree") { asTree.toggle() }
            }
            moreMenu
        }
        .padding(.horizontal, Space.s).frame(height: 40)
    }

    private func iconButton(_ name: LucideName, _ help: String, on: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Lucide(name, size: 15, color: on ? Theme.ink : Theme.muted).frame(width: 28, height: 28).contentShape(Rectangle())
        }
        .buttonStyle(.plain).help(help).accessibilityLabel(help)
    }

    private var moreMenu: some View {
        Menu {
            Button("Refresh changes") {
                if let session { Task { await model.changesStore(for: session.key.hostSessionId).refresh(sessionKey: session.key.hostSessionId, visible: true, activityChanged: true) } }
            }
            Button("Copy changed file paths") {
                if let session, let files = model.changesStore(for: session.key.hostSessionId).changes?.files {
                    NSPasteboard.general.clearContents()
                    NSPasteboard.general.setString(files.map(\.path).joined(separator: "\n"), forType: .string)
                }
            }
            .disabled(changeCount == nil)
            Divider()
            Button(lowerOpen ? "Hide terminal and scripts (⌘J)" : "Show terminal and scripts (⌘J)") { lowerOpen.toggle() }
        } label: {
            Lucide(.ellipsisVertical, size: 15, color: Theme.muted).frame(width: 28, height: 28).contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
        .accessibilityLabel("More")
    }

    private var searchField: some View {
        HStack(spacing: 8) {
            Lucide(.search, size: 13, color: Theme.muted)
            TextField("Filter changed files", text: $query).textFieldStyle(.plain).font(.system(size: 13))
            if !query.isEmpty {
                Button { query = "" } label: { Lucide(.x, size: 11, color: Theme.muted) }.buttonStyle(.plain).accessibilityLabel("Clear")
            }
        }
        .padding(.horizontal, 10).frame(height: 30)
        .background(Theme.bg, in: RoundedRectangle(cornerRadius: Radius.control))
        .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
        .padding(.horizontal, Space.m).padding(.bottom, 8)
    }

    // MARK: Upper

    @ViewBuilder private var upper: some View {
        switch tab {
        case .review: changesOrEmpty { ReviewTab(session: $0) }
        case .changes: changesOrEmpty { ChangesTab(session: $0, activityStamp: model.activity.count, query: query, asTree: asTree) }
        case .files: changesOrEmpty { FilesTab(session: $0) }
        }
    }

    @ViewBuilder private func changesOrEmpty<V: View>(@ViewBuilder _ content: (HostSession) -> V) -> some View {
        if let session {
            content(session)
        } else {
            Text("Open a chat to see what it changed.").font(Typo.body).foregroundStyle(Theme.muted).padding(Space.l)
        }
    }

    // MARK: Lower

    @ViewBuilder private var lower: some View {
        VStack(spacing: 0) {
            if lowerOpen { dragHandle }
            Rectangle().fill(Theme.line).frame(height: 1)
            lowerRow
            if lowerOpen {
                Rectangle().fill(Theme.line).frame(height: 1)
                lowerContent.frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .frame(height: lowerOpen ? shownLower : nil)
        .background(Theme.bg)
    }

    private var lowerRow: some View {
        HStack(spacing: 2) {
            Button { lowerOpen.toggle() } label: {
                Lucide(.chevronDown, size: 14, color: Theme.muted).rotationEffect(.degrees(lowerOpen ? 0 : 180))
                    .frame(width: 28, height: 28).contentShape(Rectangle())
            }
            .buttonStyle(.plain).padding(.leading, 4)
            .help(lowerOpen ? "Hide terminal and scripts (⌘J)" : "Show terminal and scripts (⌘J)")
            .accessibilityLabel(lowerOpen ? "Hide terminal and scripts" : "Show terminal and scripts")
            ForEach(InspectorLowerTab.available(native: native)) { t in
                let selected = lowerOpen && lowerTab == t
                Button { lowerRaw = t.rawValue; lowerOpen = true } label: {
                    Text(t.title).font(.system(size: 14, weight: selected ? .medium : .regular))
                        .foregroundStyle(selected ? Theme.ink : Theme.muted)
                        .padding(.horizontal, 10).frame(height: 40)
                        .overlay(alignment: .bottom) { Rectangle().fill(selected ? Theme.ink : .clear).frame(height: 2) }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(selected ? .isSelected : [])
            }
            Button { newTerminal() } label: {
                Lucide(.plus, size: 15, color: Theme.muted).frame(width: 28, height: 28).contentShape(Rectangle())
            }
            .buttonStyle(.plain).help("New terminal").accessibilityLabel("New terminal")
            Spacer(minLength: 0)
        }
        .frame(height: 40)
    }

    private func newTerminal() {
        guard let folder = TerminalWorkspace.availability(cwd: session?.cwd).folder else { return }
        lowerRaw = InspectorLowerTab.terminal.rawValue
        lowerOpen = true
        TerminalHost.shared.add(workspace: folder, folder: folder)
    }

    @ViewBuilder private var lowerContent: some View {
        if let session {
            switch lowerTab {
            case .setup: SetupTab(session: session)
            case .run: RunTab(session: session)
            case .terminal: TerminalPanel(session: session, column: 0, height: $lowerHeight, open: $lowerOpen, embedded: true)
            }
        } else {
            Text("Open a chat to use its terminal.").font(Typo.body).foregroundStyle(Theme.muted).padding(Space.l)
        }
    }

    /// The 5pt hit area over the lower part's top edge; dragging up makes it taller.
    private var dragHandle: some View {
        Rectangle().fill(Color.clear).frame(height: 5).contentShape(Rectangle())
            .onHover { inside in if inside { NSCursor.resizeUpDown.push() } else { NSCursor.pop() } }
            .gesture(
                DragGesture(minimumDistance: 1, coordinateSpace: .global)
                    .onChanged { v in
                        let from = dragStart ?? shownLower
                        dragStart = from
                        lowerHeight = TerminalPanelSizing.dragged(start: from, translation: v.translation.height, column: columnHeight)
                    }
                    .onEnded { _ in dragStart = nil }
            )
            .onTapGesture(count: 2) { lowerHeight = TerminalPanelSizing.defaultHeight }
            .accessibilityElement().accessibilityLabel("Resize terminal and scripts")
    }
}
