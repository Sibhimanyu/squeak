import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md §8.10: the right zone always draws its tab strip. Beside a pond page the first tab is the pinned Pond tab
// (the morphing pond inspector), then Code / Files / shells; beside a stream it is the zone's own strip (`DockZoneStrip`)
// with its first panel pinned. Both end in the same "+". What is open is decided in `InspectorTabs.swift`; this draws.

/// The "+" : a click makes a terminal, the menu also offers Files and Code.
struct InspectorPlusMenu<Glyph: View>: View {
    let label: Glyph
    let perform: (InspectorPlusItem) -> Void

    var body: some View {
        Menu {
            ForEach(InspectorStrip.plusItems(context: .pond), id: \.self) { item in
                Button { perform(item) } label: { Label(item.title, systemImage: item.symbol) }
            }
        } label: { label } primaryAction: { perform(InspectorStrip.plusDefault) }
        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
        .help("New terminal").accessibilityLabel("Add a tab")
    }
}

@MainActor enum InspectorActions {
    /// Beside a duck's stream: a terminal in the chat's folder, or the Code panel (Files = its Files sub-tab) in the zone.
    static func stream(_ item: InspectorPlusItem, model: AppModel) {
        let dock = DockStore.shared
        switch item {
        case .newTerminal: NewTerminalAction.perform(model, in: .right)
        case .artifacts: break  // pond pages only: a duck's stream has no Artifacts strip
        case .files, .code:
            InspectorTabMemory.write(item == .files ? InspectorTab.files.rawValue : InspectorTab.changes.rawValue, workspace: model.focus.workspace)
            if dock.layout.zone(of: .code) == .right { dock.selectPanel(.code, in: .right) } else { dock.update { $0.move(.code, to: .right) } }
        }
    }

    /// Beside a pond page: terminals run in the pond's folder; Code and Files are tabs saved for that pond.
    static func pond(_ item: InspectorPlusItem, key: String, folder: String?, notice: ((String?) -> Void)? = nil) {
        switch item {
        case .newTerminal:
            guard let folder else { notice?(PondTerminal.noFolder); return }
            notice?(nil)
            NewTerminalAction.open(folder: folder, in: .right)
        case .files: open(.files, key: key)
        case .code: open(.code, key: key)
        case .artifacts: open(.artifacts, key: key)
        }
    }

    static func open(_ kind: InspectorTabKind, key: String) {
        let dock = DockStore.shared
        dock.deselectTerminals(.right)
        dock.update { l in var r = l.inspectorRecord(pond: key); r.open(kind); l.setInspectorRecord(r, pond: key) }
    }

    static func close(_ kind: InspectorTabKind, key: String) {
        DockStore.shared.update { l in var r = l.inspectorRecord(pond: key); r.close(kind); l.setInspectorRecord(r, pond: key) }
    }
}

/// Which ponds the inspector has shown since the app started.
@MainActor final class InspectorVisitsStore {
    static let shared = InspectorVisitsStore()
    var visits = InspectorVisits()
}

/// The right zone beside a pond page: the always-there strip (Pond pinned first), then the selected tab.
struct PondInspectorZone: View {
    let projectId: String
    let key: String
    let width: CGFloat
    @Environment(AppModel.self) private var model
    @Namespace private var indicator

    @State private var notice: String?

    private var folder: String? { PondsModel.pondTerminalFolder(key) }

    var body: some View {
        let dock = DockStore.shared
        let record = dock.layout.inspectorRecord(pond: key)
        let shells = folder.map { f in
            (folder: f, tabs: dock.activeFolder == f
                ? dock.activeTerminals.terminals(in: .right).compactMap { id in TerminalHost.shared.registry.tabs(f).first { $0.id == id } } : [])
        }
        // A remote pond has no code on this Mac: People and Recent only, no terminals, Files, Code or "+".
        let peopleOnly = PondsModel.shared.chrome(key: key).inspectorPeopleRecentOnly
        let strip = InspectorStrip.make(
            context: .pond, record: record, terminals: shells?.tabs.map(\.id) ?? [],
            selectedTerminal: dock.activeFolder == folder ? dock.activeTerminals.shown(in: .right) : nil, peopleOnly: peopleOnly)
        VStack(spacing: 0) {
            HStack(spacing: 0) {
                Color.clear.frame(width: Space.m + PaneToggle.size)
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 0) {
                        ForEach(strip.tabs, id: \.self) { tab in
                            if case .terminal(let id) = tab, let shells, let t = shells.tabs.first(where: { $0.id == id }) {
                                DockTerminalTab(tab: t, folder: shells.folder, zone: .right, selected: strip.selected == tab, height: Metrics.header, indicator: indicator)
                            } else if case .terminal = tab {
                                EmptyView()
                            } else {
                                tabView(tab, strip: strip)
                            }
                        }
                        if !peopleOnly {
                            InspectorPlusMenu(label: Lucide(.plus, size: 15, color: Theme.muted).frame(width: 28, height: 28).contentShape(Rectangle())) {
                                InspectorActions.pond($0, key: key, folder: folder) { notice = $0 }
                            }
                        }
                    }
                    .padding(.horizontal, Space.s)
                }
                .frame(minWidth: 0, maxWidth: .infinity)
            }
            .frame(height: Metrics.header).frame(maxWidth: .infinity).clipped()
            .overlay(alignment: .bottom) { Rectangle().fill(Theme.line).frame(height: 1) }
            .background(WindowDragArea())
            .animation(Motion.standard, value: strip.selected)
            if let notice {
                Text(verbatim: notice).font(Typo.body).foregroundStyle(Theme.muted)
                    .frame(maxWidth: .infinity, alignment: .leading).padding(Space.m)
                    .overlay(alignment: .bottom) { Rectangle().fill(Theme.line).frame(height: 1) }
                    .accessibilityLabel(notice)
            }
            content(strip.selected)
        }
        .onChange(of: key) { notice = nil }
        .frame(width: width).frame(maxHeight: .infinity).clipped()
        .background(Theme.bg.ignoresSafeArea())
        .overlay(alignment: .leading) { Rectangle().fill(Theme.line).frame(width: 1).ignoresSafeArea() }
        .task(id: key) { arrive() }
        .task(id: folder) {
            guard let f = folder else { return }
            dock.syncTerminals(folder: f, live: TerminalHost.shared.registry.tabs(f).map(\.id))
        }
    }

    /// The first visit to a pond this session selects its Pond tab; the open tabs stay.
    private func arrive() {
        let dock = DockStore.shared
        let saved = dock.layout.inspectorRecord(pond: key)
        let shown = InspectorVisitsStore.shared.visits.arrive(at: key, record: saved)
        dock.deselectTerminals(.right)
        if shown != saved { dock.update { $0.setInspectorRecord(shown, pond: key) } }
    }

    @ViewBuilder private func tabView(_ tab: RightTab, strip: InspectorStrip) -> some View {
        let selected = strip.selected == tab
        let pinned = strip.isPinned(tab)
        StripTab(selected: selected, height: Metrics.header, indicator: indicator, closeLabel: "Close \(tab.title)", showsClose: !pinned,
                 titleWidth: TabTitleMeasure.width(tab.title), close: { InspectorActions.close(tab.kind, key: key) }) {
            Image(systemName: tab.symbol).font(.system(size: 13)).foregroundStyle(selected ? Theme.ink : Theme.muted)
        } title: {
            Text(verbatim: tab.title).font(Typo.body).foregroundStyle(selected ? Theme.ink : Theme.muted).lineLimit(1)
        }
        .onTapGesture { InspectorActions.open(tab.kind, key: key) }
        .accessibilityLabel(tab.title).accessibilityAddTraits(.isButton).accessibilityAddTraits(selected ? .isSelected : [])
    }

    @ViewBuilder private func content(_ tab: RightTab) -> some View {
        switch tab {
        case .pond, .panel:
            RoomInspector(key: key, room: PondRoomStore.shared.model(for: projectId))
        case .code:
            CodePanelView(session: model.selectedSession, fixedTab: .changes)
        case .files:
            CodePanelView(session: model.selectedSession, fixedTab: .files)
        case .artifacts:
            ArtifactsTab(projectId: projectId)
        case .terminal(let id):
            TerminalPanelView(session: nil, shell: id, cwd: folder).id(id)
        }
    }
}
