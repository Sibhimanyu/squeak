import AppKit
import SqueakIcons
import SqueakMacCore
import Heresay
import SwiftUI

// DESIGN.md §8.10, the right panel (30% of the window until dragged, closed by default), split in two like the
// target's: the git primary action on a top row; the upper part's tabs (All files, Changes with its count, Review,
// then search, a tree/list toggle and ···); and the lower part's own tab row (a collapse chevron, Setup, Run,
// Terminal, +), where the terminal lives now. ⌘J shows and hides the lower part.

struct WorkbenchInspector: View {
    let session: HostSession?
    @Binding var tab: InspectorTab
    /// The Code view (files, changes, review, setup, run, terminal) instead of the Pond panel; remembered by the window.
    @Binding var codeView: Bool
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
    @State private var handleHover = false

    private var native: Bool { session?.source == .squeak }
    private var lowerTab: InspectorLowerTab { InspectorLowerTab.restored(lowerRaw, native: native) }
    private var shownLower: Double { TerminalPanelSizing.clamp(lowerHeight, column: columnHeight) }

    /// The duckling open for this chat: it replaces the panel's content until Back, Esc or another chat.
    private var openDuckling: DucklingRef? { DucklingRef.open(model.openDuckling, whenSelected: session?.key) }

    var body: some View {
        if let session, let ref = openDuckling {
            DucklingPanel(
                session: session, chip: model.ducklings(for: session)?.items.first { $0.id == ref.taskId }, taskId: ref.taskId,
                width: width)
                .id(ref.taskId)
        } else {
            panelBody
        }
    }

    private var panelBody: some View {
        VStack(spacing: 0) {
            gitRow
            VStack(spacing: 0) {
                if codeView {
                    tabRow
                    if searching && tab == .changes { searchField }
                    Rectangle().fill(Theme.line).frame(height: 1)
                    upper.frame(maxHeight: .infinity)
                } else {
                    Rectangle().fill(Theme.line).frame(height: 1)
                    if let session {
                        PondPanel(session: session, showChanges: { tab = .changes; codeView = true }).heresayPrivate().frame(maxHeight: .infinity)
                    } else {
                        Text("Open a thread to see its pond.").font(Typo.body).foregroundStyle(Theme.muted).padding(Space.l)
                        Spacer(minLength: 0)
                    }
                }
            }
            .frame(maxHeight: .infinity)
            if LowerPanelRules.isPresent(hasWorkspace: session != nil, codeView: codeView) { lower }
        }
        .frame(width: width)
        .frame(maxHeight: .infinity)
        .background(Theme.bg.ignoresSafeArea())
        .overlay(alignment: .leading) { Rectangle().fill(Theme.line).frame(width: 1).ignoresSafeArea() }
        .background(GeometryReader { g in
            Color.clear.onAppear { columnHeight = g.size.height }.onChange(of: g.size.height) { _, h in columnHeight = h }
        })
        .onChange(of: lowerOpen) { _, isOpen in
            if isOpen, lowerTab == .terminal { TerminalHost.shared.focusPending = true }
            KeyFocus.shared.setTerminalOpen(isOpen)
        }
        .onAppear { KeyFocus.shared.setTerminalOpen(lowerOpen) }
        .onDisappear { KeyFocus.shared.setTerminalOpen(false) }
        .onChange(of: tab) { _, new in if new != .changes { searching = false; query = "" } }
    }

    // MARK: Top

    /// The git primary action (Create PR with its dropdown) above the panel, as the target puts it.
    private var gitRow: some View {
        HStack(spacing: Space.s) {
            Color.clear.frame(width: PaneToggle.size, height: PaneToggle.size)   // the toggle (PaneToggleOverlay)
            viewButton("Pond", on: !codeView) { codeView = false }
            viewButton("Code", on: codeView) { codeView = true }.help(ShortcutRegistry.hint("Code tools", .toggleCode))
            Spacer(minLength: 0)
            if codeView, let session, native { GitCluster(session: session, showsBranch: false) }
        }
        .padding(.horizontal, Space.m).frame(height: Metrics.header).background(WindowDragArea())
    }

    private func viewButton(_ title: String, on: Bool, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title).font(.system(size: 14, weight: on ? .medium : .regular)).foregroundStyle(on ? Theme.ink : Theme.muted)
                .padding(.horizontal, 10).frame(height: 28)
                .background(on ? Theme.selected : .clear, in: RoundedRectangle(cornerRadius: Radius.control))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).accessibilityAddTraits(on ? .isSelected : [])
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
        SqueakMenu {
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
            Button(lowerOpen ? "Hide terminal (⌘J)" : "Show terminal (⌘J)") { lowerOpen.toggle() }
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
        case .changes: changesOrEmpty { ChangesTab(session: $0, activityStamp: model.activity.count, query: query, asTree: asTree).heresayPrivate() }
        case .files: changesOrEmpty { FilesTab(session: $0).heresayPrivate() }
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
            if lowerOpen { dragHandle } else { Rectangle().fill(Theme.line).frame(height: 1) }
            lowerRow
            Rectangle().fill(Theme.line).frame(height: 1).opacity(lowerOpen ? 1 : 0)
            // Kept in the tree while collapsed, so a terminal's view and process survive collapse and mode switches.
            lowerContent.frame(maxWidth: .infinity, maxHeight: lowerOpen ? .infinity : 0).clipped()
                .allowsHitTesting(lowerOpen).accessibilityHidden(!lowerOpen)
        }
        .frame(height: LowerPanelRules.frameHeight(collapsed: !lowerOpen, stored: lowerHeight, column: columnHeight) + (lowerOpen ? 0 : 1))
        .animation(Motion.standard, value: lowerOpen)
        .background(Theme.bg)
    }

    private var lowerRow: some View {
        HStack(spacing: 2) {
            Button { lowerOpen.toggle() } label: {
                Lucide(.chevronDown, size: 14, color: Theme.muted).rotationEffect(.degrees(lowerOpen ? 0 : 180))
                    .frame(width: 28, height: 28).contentShape(Rectangle())
            }
            .buttonStyle(.plain).padding(.leading, 4)
            .help(lowerOpen ? "Hide terminal (⌘J)" : "Show terminal (⌘J)")
            .accessibilityLabel(lowerOpen ? "Hide terminal" : "Show terminal")
            if let folder = TerminalWorkspace.availability(cwd: session?.cwd).folder, !TerminalHost.shared.registry.tabs(folder).isEmpty {
                let tabs = TerminalHost.shared.registry.tabs(folder)
                let current = TerminalHost.shared.registry.selected(folder)?.id
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 0) {
                        ForEach(tabs) { tab in
                            terminalTab(InspectorLowerTab.terminalTitle(number: tab.number), selected: lowerOpen && current == tab.id, select: {
                                TerminalHost.shared.select(workspace: folder, tab.id); lowerOpen = true
                            }, close: { TerminalHost.shared.requestClose(workspace: folder, tab.id) })
                        }
                    }
                }
                .fixedSize(horizontal: true, vertical: false)
            } else {
                terminalTab("Terminal", selected: lowerOpen, select: { lowerOpen = true }, close: nil)
            }
            Button { newTerminal() } label: {
                Lucide(.plus, size: 15, color: Theme.muted).frame(width: 28, height: 28).contentShape(Rectangle())
            }
            .buttonStyle(.plain).help(ShortcutFocus.newTerminalHint(in: KeyFocus.shared.region, terminalOpen: lowerOpen).replacingOccurrences(of: "  ", with: " ")).accessibilityLabel("New terminal")
            Spacer(minLength: 0)
            if let hint = ShortcutFocus.terminalTitleHint(in: KeyFocus.shared.region, terminalOpen: lowerOpen) {
                Text(verbatim: hint).font(.system(size: 11)).foregroundStyle(Theme.subtle).lineLimit(1).padding(.trailing, Space.m)
                    .accessibilityLabel("Terminal has the keys. Command T new terminal, Command W close terminal")
            }
        }
        .frame(height: 40)
    }

    private func terminalTab(_ title: String, selected: Bool, select: @escaping () -> Void, close: (() -> Void)?) -> some View {
        HStack(spacing: 4) {
            Text(title).font(.system(size: 14, weight: selected ? .medium : .regular))
                .foregroundStyle(selected ? Theme.ink : Theme.muted)
            if let close, selected {
                Button(action: close) { Lucide(.x, size: 11, color: Theme.muted).frame(width: 16, height: 16).contentShape(Rectangle()) }
                    .buttonStyle(.plain).help("Close this terminal").accessibilityLabel("Close \(title)")
            }
        }
        .padding(.horizontal, 10).frame(height: 40)
        .overlay(alignment: .bottom) { Rectangle().fill(selected ? Theme.ink : .clear).frame(height: 2) }
        .contentShape(Rectangle())
        .onTapGesture(perform: select)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }

    private func newTerminal() {
        guard let folder = TerminalWorkspace.availability(cwd: session?.cwd).folder else { return }
        lowerRaw = InspectorLowerTab.terminal.rawValue
        lowerOpen = true
        TerminalHost.shared.add(workspace: folder, folder: folder)
    }

    @ViewBuilder private var lowerContent: some View {
        if let session {
            TerminalPanel(session: session, column: 0, height: $lowerHeight, open: $lowerOpen, embedded: true)
        } else {
            Text("Open a chat to use its terminal.").font(Typo.body).foregroundStyle(Theme.muted).padding(Space.l)
        }
    }

    /// DESIGN.md §8.10, as `PaneResizeHandle`: an 8pt hit area centred on the 1pt line above the panel's tab row, the
    /// line a touch stronger while hovered or dragged, the resize cursor, a double click back to the default.
    private var dragHandle: some View {
        ZStack {
            Rectangle().fill(Color.clear)
            SplitDividerLine(vertical: false, hovering: handleHover, dragging: dragStart != nil)
        }
        .frame(height: Tokens.Divider.hit).contentShape(Rectangle())
        .splitDividerCursor(.resizeUpDown, hovering: $handleHover)
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
        .accessibilityElement().accessibilityLabel("Resize terminal")
    }
}
