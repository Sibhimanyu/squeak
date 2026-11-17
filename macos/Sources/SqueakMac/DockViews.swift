import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI
import UniformTypeIdentifiers

// The dock: panel tabs that look like the chat tabs, three zones that take them (centre, right, bottom), and the
// drag that moves a panel between them. The arrangement is `DockStore.shared.layout`; nothing here keeps its own.

// MARK: Drag payload

// A dock tab is dragged as plain text, `DockItemPayload`'s prefixed string. A chat tab now travels the same way, as a
// thread item, so a thread can be docked in the right or bottom zone. An item provider carrying only the abstract
// `public.data` type was never matched by a drop destination on macOS. A bare chat key from an older payload still
// decodes to nil here; the chat strip reads it itself.

/// Moves a file tab to a zone and keeps the file model's "shown in the centre" in step: a file leaving the centre
/// stops being the centre's file, one coming back is shown.
@MainActor func dockMoveFile(_ path: String, to zone: DockZone, before: String? = nil, model: AppModel) {
    DockStore.shared.moveFile(path, to: zone, before: before)
    for f in model.filesModels.values where f.open.contains(where: { $0.path == path }) {
        if zone == .centre { f.activePath = path } else if f.activePath == path { f.showChat() }
    }
}

/// Tells the store a panel drag has begun (a drag that starts on a panel tab) and ends it: AppKit's drag session gives
/// SwiftUI no start or end callback, so the mouse events around it do.
@MainActor enum DockDragMonitor {
    private static var token: Any?

    static func install() {
        guard token == nil else { return }
        token = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDragged, .leftMouseDown, .leftMouseUp, .mouseMoved]) { event in
            MainActor.assumeIsolated {
                let dock = DockStore.shared
                if event.type == .leftMouseDragged {
                    if dock.dragging == nil, let p = dock.hoveredTab { dock.dragging = p }
                } else if dock.dragging != nil {
                    dock.dragging = nil
                }
            }
            return event
        }
    }
}

// MARK: Drop targets

private struct DockDropModifier: ViewModifier {
    let zone: DockZone
    var before: DockItem?
    /// A whole zone washes; a strip or a tab only draws its drop line.
    var wash = true
    @State private var targeted = false
    @Environment(AppModel.self) private var model

    func body(content: Content) -> some View {
        content
            // A tab opens a gap before itself while a tab hovers it; a strip or zone washes instead.
            .padding(.leading, before != nil && targeted ? 16 : 0)
            .scopedDrop(.strip(zone), isTargeted: { targeted = $0 }) { text in
                guard let item = DockItemPayload.decode(text) else { return false }
                return performDockDrop(item, to: zone, before: before, model: model)
            }
            .overlay {
                if targeted {
                    if before != nil {
                        Capsule().fill(PondColour.accent).frame(width: 2).padding(.vertical, 8)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .allowsHitTesting(false).transition(.opacity)
                    } else {
                        ZStack {
                            if wash { Theme.selected.opacity(0.5) }
                            RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.lineStrong, lineWidth: 2).padding(wash ? 4 : 1)
                        }
                        .allowsHitTesting(false).transition(.opacity)
                    }
                }
            }
            .animation(Motion.standard, value: targeted)
    }
}

@MainActor func performDockDrop(_ item: DockItem, to zone: DockZone, before: DockItem?, model: AppModel) -> Bool {
    if case .thread(let key) = item {
        var b: String?
        if case .thread(let other)? = before { b = other }
        DockStore.shared.dragging = nil
        DockStore.shared.moveThread(key, to: zone, before: b)
        if zone != .centre { model.select(SessionKey(stringValue: key)) }
        return true
    }
    if case .file(let path) = item {
        var b: String?
        if case .file(let other)? = before { b = other }
        DockStore.shared.dragging = nil
        dockMoveFile(path, to: zone, before: b, model: model)
        return true
    }
    return DockStore.shared.drop(item, to: zone, before: before)
}

extension View {
    func dockDrop(_ zone: DockZone, before: DockItem? = nil, wash: Bool = true) -> some View {
        modifier(DockDropModifier(zone: zone, before: before, wash: wash))
    }
}

/// A thin strip at a window edge that exists only while a panel is dragged and that edge has no zone showing.
struct DockEdgeStrip: View {
    let zone: DockZone
    @State private var targeted = false
    @Environment(AppModel.self) private var model

    var body: some View {
        Rectangle().fill(targeted ? Theme.ink.opacity(0.12) : Theme.selected)
            .overlay(alignment: zone == .right ? .leading : .top) {
                Rectangle().fill(targeted ? Theme.ink : Theme.lineStrong)
                    .frame(width: zone == .right ? 2 : nil, height: zone == .bottom ? 2 : nil)
            }
            .frame(width: zone == .right ? 20 : nil, height: zone == .bottom ? 20 : nil)
            .contentShape(Rectangle())
            .scopedDrop(.edgeStrip(zone), isTargeted: { targeted = $0 }) { text in
                guard let item = DockItemPayload.decode(text) else { return false }
                return performDockDrop(item, to: zone, before: nil, model: model)
            }
            .animation(Motion.quick, value: targeted)
            .accessibilityLabel("Drop here to dock on the \(zone.title.lowercased())")
    }
}

// MARK: Tabs

// MARK: Shared tab chrome

private struct TabMaxWidthKey: EnvironmentKey { static let defaultValue: CGFloat = .infinity }
extension EnvironmentValues {
    /// The widest a tab in this strip may be (`ChatTabWidth.cap`): infinity while every tab fits at its natural width.
    var tabMaxWidth: CGFloat { get { self[TabMaxWidthKey.self] } set { self[TabMaxWidthKey.self] = newValue } }
}

/// Measures titles for `ChatTabWidth`, in the tab's own font.
enum TabTitleMeasure {
    static func width(_ title: String, semibold: Bool = false) -> Double {
        let font = NSFont.systemFont(ofSize: 13, weight: semibold ? .semibold : .regular)
        return Double((title as NSString).size(withAttributes: [.font: font]).width.rounded(.up))
    }
    /// The widest any tab of this strip may be, for these titles in `available` points.
    static func cap(titles: [String], available: Double) -> CGFloat {
        let c = ChatTabWidth.cap(naturals: titles.map { ChatTabWidth.natural(titleWidth: width($0)) }, available: available)
        return c.isFinite ? CGFloat(c) : .infinity
    }
}

/// The one tab look for every strip (centre chats, right, bottom): equal side padding, icon, title in the UI font, a
/// close that shows only on hover (its small slot is always reserved), a 2pt accent underline when selected. It hugs its
/// content and never pads out to a width. Callers add selection, drag and drop around it.
struct StripTab<Icon: View, Title: View>: View {
    let selected: Bool
    let height: CGFloat
    let indicator: Namespace.ID
    let closeLabel: String
    var showsClose = true
    /// The title's measured natural width (`TabTitleMeasure.width`): the tab is drawn exactly as wide as it needs.
    var titleWidth: Double = 0
    /// Room for anything beside the title (a badge).
    var titleExtra: Double = 0
    var dirty = false
    /// Working or needing you shows in the trailing slot (the hover close takes its place while the pointer is on the tab).
    var activity: TabActivity = .idle
    var onHover: (Bool) -> Void = { _ in }
    let close: () -> Void
    @ViewBuilder var icon: () -> Icon
    @ViewBuilder var title: () -> Title
    @State private var hovering = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.tabMaxWidth) private var maxWidth
    @Environment(AppModel.self) private var model

    var body: some View {
        HStack(spacing: 0) {
            icon().frame(width: ChatTabWidth.iconSlot).opacity(selected ? 1 : 0.8)
            title().frame(maxWidth: .infinity, alignment: .leading).padding(.leading, ChatTabWidth.iconGap)
            if dirty { Circle().fill(Theme.muted).frame(width: 6, height: 6).padding(.leading, 4).accessibilityLabel("Unsaved changes") }
            slot
        }
        .padding(.leading, ChatTabWidth.leadingPad).padding(.trailing, ChatTabWidth.trailingPad)
        // A fixed width from the measured title, so the tab hugs its content and the trailing slot never moves on hover.
        .frame(width: CGFloat(ChatTabWidth.width(titleWidth: titleWidth, extra: titleExtra + (dirty ? 10 : 0), cap: Double(maxWidth))),
               height: height, alignment: .leading)
        .onHover { inside in hovering = inside; onHover(inside) }
        .overlay(alignment: .bottom) {
            if selected { Rectangle().fill(PondColour.tabIndicator(PondColour.openPond(model.selectedSession))).frame(height: 2).matchedGeometryEffect(id: "tabIndicator", in: indicator) }
        }
        .contentShape(Rectangle())
    }
}

extension StripTab {
    /// The reserved trailing slot: the close button on hover, else the activity mark. Always 14pt wide.
    @ViewBuilder fileprivate var slot: some View {
        let content = TabSlotContent.of(activity, hovered: hovering)
        if showsClose {
            ZStack {
                if showsClose {
                    Button(action: close) {
                        Lucide(.x, size: 12, color: Theme.muted).frame(width: ChatTabWidth.closeSlot, height: ChatTabWidth.closeSlot).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .opacity(content.close ? 1 : 0).allowsHitTesting(content.close)
                    .help(closeLabel).accessibilityLabel(closeLabel)
                }
                Group {
                    if reduceMotion { TideGlyph.calm(color: Theme.working, grid: .micro) } else { TideGlyph(color: Theme.working, grid: .micro) }
                }.opacity(content.workingGlyph ? 1 : 0).accessibilityHidden(!content.workingGlyph).allowsHitTesting(false)
                StatusMark(kind: .waiting(count: nil), color: Theme.warning, size: 12)
                    .opacity(content.warning ? 1 : 0).accessibilityHidden(!content.warning).allowsHitTesting(false)
            }
            .frame(width: ChatTabWidth.closeSlot, height: ChatTabWidth.closeSlot)
            .padding(.leading, ChatTabWidth.closeGap)
            .animation(Motion.quick, value: content)
        }
    }
}

/// One dock tab (panel, file, shell, thread, duckling) on the shared `StripTab`; it drags, takes drops before it, and
/// has the Move to menu.
struct DockItemTab<Icon: View>: View {
    let item: DockItem
    let title: String
    let zone: DockZone
    let selected: Bool
    let height: CGFloat
    let indicator: Namespace.ID
    var dirty = false
    var activity: TabActivity = .idle
    /// The right zone's first tab: no close button, and it cannot be dragged out or moved.
    var pinned = false
    let select: () -> Void
    let close: () -> Void
    @ViewBuilder var icon: () -> Icon
    @Environment(AppModel.self) private var model

    var body: some View {
        if pinned { tab.onTapGesture(perform: select).accessibilityAddTraits(.isButton).accessibilityLabel(title).accessibilityAddTraits(selected ? .isSelected : []).help(title) }
        else { draggable }
    }

    private var tab: some View {
        let dock = DockStore.shared
        return StripTab(selected: selected, height: height, indicator: indicator, closeLabel: "Close \(title)", showsClose: !pinned,
                     titleWidth: TabTitleMeasure.width(title), dirty: dirty, activity: activity,
                     onHover: { inside in
                         guard !pinned else { return }
                         if inside { dock.hoveredTab = item } else if dock.hoveredTab == item { dock.hoveredTab = nil }
                     }, close: close, icon: icon) {
                Text(verbatim: title).font(Typo.body).foregroundStyle(selected ? Theme.ink : Theme.muted)
                    .lineLimit(1).truncationMode(.tail)
            }
    }

    private var draggable: some View {
        let dock = DockStore.shared
        return Group { tab }
        // Not a Button: a Button takes the mouse-down and the drag never starts.
        .onTapGesture(perform: select)
        .overlay(MiddleClick(action: close))
        .accessibilityAddTraits(.isButton)
        .opacity(dock.dragging == item ? 0.35 : 1)
        .animation(Motion.quick, value: dock.dragging == item)
        .onDrag { dragProvider(DockItemPayload.encode(item), kind: .of(item)) } preview: { DockTabDragPreview(title: title) }
        .dockDrop(zone, before: item, wash: false)
        .accessibilityLabel(title)
        .accessibilityAddTraits(selected ? .isSelected : [])
        .help(title)
        .squeakContextMenu {
            ForEach(DockZone.allCases.filter { $0 != zone && DragScope.allows(item, on: .strip($0)) }, id: \.self) { z in
                Button("Move to \(z.title)") {
                    switch item {
                    case .panel(let p): dock.update { $0.move(p, to: z) }
                    case .file(let path): dockMoveFile(path, to: z, model: model)
                    case .terminal(let id): dock.moveTerminal(id, to: z)
                    case .thread(let key): dock.moveThread(key, to: z)
                    case .duckling(let ref): dock.moveDuckling(ref, to: z)
                    }
                }
            }
            Divider()
            Button("Close tab", action: close)
        }
    }
}

/// What follows the pointer while a tab is dragged: its title on a raised surface with a soft shadow.
struct DockTabDragPreview: View {
    let title: String
    var body: some View {
        Text(verbatim: title).font(.system(size: 14)).foregroundStyle(Theme.ink).lineLimit(1)
            .padding(.horizontal, Space.m).frame(height: 30)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Theme.surfaceRaised))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.line, lineWidth: 1))
            .shadow(color: .black.opacity(0.28), radius: 10, y: 4)
            .padding(8)
    }
}

/// A docked thread's tab in a side zone. Closing it puts the thread back in the centre strip.
struct DockThreadTab: View {
    let session: HostSession
    let zone: DockZone
    let selected: Bool
    let height: CGFloat
    let indicator: Namespace.ID
    @Environment(AppModel.self) private var model

    var body: some View {
        let key = session.key.stringValue
        DockItemTab(item: .thread(key), title: model.workbenchTitle(session), zone: zone, selected: selected, height: height, indicator: indicator,
                    activity: TabSlotContent.activity(of: model.mark(for: session)?.kind),
                    select: { DockStore.shared.selectThread(key); model.select(session.key) },
                    close: { DockStore.shared.moveThread(key, to: .centre) }) {
            Image(systemName: "bubble.left").font(.system(size: 13)).foregroundStyle(selected ? Theme.ink : Theme.muted)
        }
    }
}

/// A duckling's tab: its task name, a loader while it runs (a check or cross once it ends), a close.
struct DockDucklingTab: View {
    let session: HostSession
    let ref: DucklingRef
    let zone: DockZone
    let selected: Bool
    let height: CGFloat
    let indicator: Namespace.ID
    @Environment(AppModel.self) private var model

    var body: some View {
        let chip = model.ducklings(for: session)?.items.first { $0.id == ref.taskId }
        DockItemTab(item: .duckling(ref), title: chip?.title ?? "Duckling", zone: zone, selected: selected, height: height, indicator: indicator,
                    activity: chip?.status == .running ? .working : .idle,
                    select: { DockStore.shared.selectDuckling(ref); if zone == .centre { model.select(ref.session) } },
                    close: {
                        let wasShown = DockStore.shared.ducklings.selected[zone] == ref
                        DockStore.shared.closeDuckling(ref)
                        let back = PondOrigin.shared.closed(tab: PondOrigin.ducklingTab(ref))
                        // Closing the open one in the centre returns to the pond it was opened from, else the thread it came from.
                        if zone == .centre, wasShown {
                            if let back { PondOrigin.shared.goBack(to: back) } else { model.select(ref.session) }
                        }
                    }) {
            if let chip { DucklingStatusMark(duckling: chip) } else { Lucide(.circleCheck, size: 11, color: Theme.subtle) }
        }
    }
}

/// A panel's tab.
struct DockPanelTab: View {
    let panel: DockPanel
    let zone: DockZone
    let selected: Bool
    let height: CGFloat
    let indicator: Namespace.ID
    var pinned = false
    let select: () -> Void

    var body: some View {
        DockItemTab(item: .panel(panel), title: panel.title, zone: zone, selected: selected, height: height, indicator: indicator,
                    pinned: pinned, select: select, close: { DockStore.shared.update { $0.close(panel) } }) {
            Image(systemName: panel.symbol).font(.system(size: 13)).foregroundStyle(selected ? Theme.ink : Theme.muted)
        }
    }
}

/// An open file's tab, in whichever zone it sits. The centre's selection is the file model's `activePath`.
struct DockFileTab: View {
    let files: FilesModel
    let file: OpenFile
    let zone: DockZone
    let selected: Bool
    let height: CGFloat
    let indicator: Namespace.ID
    let select: () -> Void

    var body: some View {
        DockItemTab(item: .file(file.path), title: file.name, zone: zone, selected: selected, height: height, indicator: indicator,
                    dirty: file.dirty, select: select, close: { files.close(file.path) }) {
            Lucide(.fileText, size: 13, color: selected ? Theme.ink : Theme.muted)
        }
    }
}

/// A shell's tab, in whichever zone it sits.
struct DockTerminalTab: View {
    let tab: TerminalTab
    let folder: String
    let zone: DockZone
    let selected: Bool
    let height: CGFloat
    let indicator: Namespace.ID
    var host: TerminalHost { TerminalHost.shared }

    var body: some View {
        DockItemTab(item: .terminal(tab.id), title: host.tabTitle(of: tab), zone: zone, selected: selected, height: height, indicator: indicator,
                    activity: host.isBusy(tab.id) ? .working : .idle,
                    select: { DockStore.shared.selectTerminal(tab.id); host.focusPending = true },
                    close: { TerminalActions.close(tab.id, folder: folder) }) {
            Lucide(.terminal, size: 13, color: selected ? Theme.ink : Theme.muted)
        }
    }
}

/// The terminal tabs a zone holds for the chat's folder, in order.
@MainActor func dockTerminalTabs(in zone: DockZone, session: HostSession?) -> (folder: String, tabs: [TerminalTab])? {
    guard let folder = TerminalWorkspace.availability(cwd: session?.cwd).folder else { return nil }
    let all = TerminalHost.shared.registry.tabs(folder)
    let tabs = DockStore.shared.activeTerminals.terminals(in: zone).compactMap { id in all.first { $0.id == id } }
    return (folder, tabs)
}

/// A side zone's tab strip: its panels as tabs, then "+", with room for leading and trailing controls. The whole
/// strip is a drop target that appends; each tab is one that inserts before it.
struct DockZoneStrip<Leading: View, Trailing: View>: View {
    let zone: DockZone
    let height: CGFloat
    let session: HostSession?
    /// The trailing accessory's width: it is dropped when the tabs do not all fit beside it (0 = never dropped).
    var trailingWidth: Double = 0
    var leadingWidth: Double = 40
    @ViewBuilder var leading: () -> Leading
    @ViewBuilder var trailing: () -> Trailing
    @Environment(AppModel.self) private var model
    @Namespace private var indicator
    @State private var stripWidth: Double = 0

    var body: some View {
        let dock = DockStore.shared
        let layout = dock.layout
        let state = layout[zone]
        let fileModel = session?.cwd.flatMap { $0.isEmpty ? nil : model.filesModel(root: $0) }
        let placed = fileModel.map { fm in dock.files.files(in: zone).compactMap { p in fm.open.first { $0.path == p } } } ?? []
        let shownFile = dock.files.selected[zone]
        let shownTerminal = dock.activeTerminals.shown(in: zone)
        let shells = dockTerminalTabs(in: zone, session: session)
        let duckRefs = session.map { s in dock.ducklings.ducklings(in: zone).filter { $0.session == s.key } } ?? []
        let titles: [String] = state.panels.filter { $0 != .terminal && !InspectorStash.hides($0) }.map(\.title)
            + duckRefs.map { ref in session.flatMap { model.ducklings(for: $0)?.items.first { $0.id == ref.taskId }?.title } ?? "Duckling" }
            + dock.threads.threads(in: zone).compactMap { k in model.allSessions.first { $0.key.stringValue == k }.map { model.workbenchTitle($0) } }
            + placed.map(\.name) + (shells?.tabs.map { TerminalHost.shared.tabTitle(of: $0) } ?? [])
        let cap = TabTitleMeasure.cap(titles: titles, available: stripWidth - leadingWidth - 36 - trailingWidth)
        HStack(spacing: 0) {
            leading()
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 0) {
                    ForEach(state.panels.filter { $0 != .terminal && !InspectorStash.hides($0) }, id: \.self) { p in
                        DockPanelTab(panel: p, zone: zone, selected: state.selected == p && !state.collapsed && shownFile == nil && dock.ducklings.selected[zone] == nil && shownTerminal == nil, height: height, indicator: indicator,
                                     pinned: zone == .right && p == state.panels.first(where: { $0 != .terminal && !InspectorStash.hides($0) })) {
                            dock.selectPanel(p, in: zone)
                        }
                    }
                    if let session {
                        ForEach(dock.ducklings.ducklings(in: zone).filter { $0.session == session.key }, id: \.self) { ref in
                            DockDucklingTab(session: session, ref: ref, zone: zone, selected: dock.ducklings.selected[zone] == ref && !state.collapsed, height: height, indicator: indicator)
                        }
                    }
                    ForEach(dock.threads.threads(in: zone), id: \.self) { key in
                        if let t = model.allSessions.first(where: { $0.key.stringValue == key }) {
                            DockThreadTab(session: t, zone: zone, selected: dock.threads.selected[zone] == key && !state.collapsed, height: height, indicator: indicator)
                        }
                    }
                    if let fileModel {
                        ForEach(placed) { f in
                            DockFileTab(files: fileModel, file: f, zone: zone, selected: shownFile == f.path && !state.collapsed, height: height, indicator: indicator) {
                                dock.selectFile(f.path)
                            }
                        }
                    }
                    if let shells {
                        ForEach(shells.tabs) { t in
                            DockTerminalTab(tab: t, folder: shells.folder, zone: zone, selected: shownTerminal == t.id && !state.collapsed, height: height, indicator: indicator)
                        }
                    }
                    DockPlusButton(zone: zone)
                }
                .environment(\.tabMaxWidth, cap)
                .padding(.horizontal, Space.s)
            }
            // The scroller takes only the room the strip has (never its content's width): tabs shrink to their floor,
            // then it scrolls, so a tab is never pushed past the zone's edge.
            .frame(minWidth: 0, maxWidth: .infinity)
            if trailingWidth == 0 || TabStripFit.showsAccessory(
                strip: stripWidth, tabs: state.panels.filter { $0 != .terminal && !InspectorStash.hides($0) }.count + dock.threads.threads(in: zone).count + dock.ducklings.ducklings(in: zone).count + placed.count + (shells?.tabs.count ?? 0),
                leading: leadingWidth, accessory: trailingWidth) {
                trailing()
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: height)
        .clipped()
        .background(GeometryReader { g in Color.clear.onAppear { stripWidth = g.size.width }.onChange(of: g.size.width) { _, w in stripWidth = w } })
        .dockDrop(zone, wash: false)
        .animation(Motion.standard, value: state.selected)
        .animation(Motion.standard, value: shownFile)
        .animation(Motion.standard, value: shownTerminal)
        .overlay(alignment: .bottom) { Rectangle().fill(Theme.line).frame(height: 1) }
        .contextMenu { WindowPanelMenuItems(includeReset: true) }
    }
}

/// The strip's "+": a new terminal when a terminal is the zone's tab, otherwise a menu of the closed panels.
struct DockPlusButton: View {
    let zone: DockZone
    @Environment(AppModel.self) private var model

    var body: some View {
        if zone == .right {
            InspectorPlusMenu(label: plus) { item in InspectorActions.stream(item, model: model) }
        } else { legacy }
    }

    @ViewBuilder private var legacy: some View {
        switch DockPlusAction.of(zone: zone, layout: DockStore.shared.layout, terminals: DockStore.shared.activeTerminals) {
        case .newTerminal:
            Button { NewTerminalAction.perform(model, in: zone) } label: { plus }
                .buttonStyle(.plain).help("New terminal").accessibilityLabel("New terminal")
        case .showHidden(let hidden):
            Menu {
                ForEach(hidden.filter { !($0 == .pond && zone == .centre) }, id: \.self) { p in
                    Button { DockStore.shared.update { $0.move(p, to: zone) } } label: { Label(p.title, systemImage: p.symbol) }
                }
            } label: { plus }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().accessibilityLabel("Show a panel here")
        case .newChat, .none:
            EmptyView()
        }
    }

    var plus: some View {
        Lucide(.plus, size: 15, color: Theme.muted).frame(width: 28, height: 28).contentShape(Rectangle())
    }
}

// MARK: Zones

/// What a side zone shows: its selected panel, as a drop target that appends.
struct DockZoneBody: View {
    let zone: DockZone
    let session: HostSession?
    @Environment(AppModel.self) private var model

    var body: some View {
        let fileModel = session?.cwd.flatMap { $0.isEmpty ? nil : model.filesModel(root: $0) }
        let file = DockStore.shared.files.selected[zone].flatMap { path in fileModel?.open.first { $0.path == path } }
        let shell = DockStore.shared.activeTerminals.shown(in: zone)
        Group {
            if let ref = DockStore.shared.ducklings.selected[zone], let session, ref.session == session.key {
                DucklingPanel(session: session, chip: model.ducklings(for: session)?.items.first { $0.id == ref.taskId }, taskId: ref.taskId)
                    .id(ref.taskId)
            } else if let shell {
                TerminalPanelView(session: session, shell: shell)
            } else if let key = DockStore.shared.threads.selected[zone], let t = model.allSessions.first(where: { $0.key.stringValue == key }) {
                if model.selected == t.key {
                    SessionDetail(session: t).id(t.key)
                } else {
                    Button("Open “\(model.workbenchTitle(t))” here") { model.select(t.key) }.buttonStyle(.plain)
                        .font(Typo.label).foregroundStyle(Theme.muted)
                }
            } else if let fileModel, let file {
                FileViewer(files: fileModel, file: file).id(file.path)
            } else if let p = DockStore.shared.layout[zone].selected.flatMap({ InspectorStash.hides($0) ? DockStore.shared.layout[zone].panels.first { $0 != .terminal && !InspectorStash.hides($0) } : $0 }) {
                DockPanelContent(panel: p, session: session)
            } else {
                Color.clear
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bg)
    }
}

/// The right zone: a header-height tab strip (room on its left for the pane toggle), a hairline, the selected panel.
struct DockRightColumn: View {
    let session: HostSession?
    let width: CGFloat
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 0) {
            DockZoneStrip(zone: .right, height: Metrics.header, session: session) {
                Color.clear.frame(width: Space.m + PaneToggle.size)
            } trailing: {
                EmptyView()
            }
            .background(WindowDragArea())
            DockZoneBody(zone: .right, session: session)
        }
        .frame(width: width)
        .frame(maxHeight: .infinity)
        .clipped()
        .background(Theme.bg.ignoresSafeArea())
        .overlay(alignment: .leading) { Rectangle().fill(Theme.line).frame(width: 1).ignoresSafeArea() }
    }
}

/// The bottom zone: a drag handle, a 40pt strip with the fold chevron, the selected panel. Folded, only the strip shows
/// and the panel stays in the tree so a terminal's view survives.
struct DockBottomZone: View {
    let session: HostSession?
    let columnHeight: Double
    @State private var dragStart: Double?
    @State private var handleHover = false

    var body: some View {
        let dock = DockStore.shared
        let state = dock.layout.bottom
        let open = !state.collapsed
        let stored = state.size ?? TerminalPanelSizing.defaultHeight
        VStack(spacing: 0) {
            if open { dragHandle(stored: stored) } else { Rectangle().fill(Theme.line).frame(height: 1) }
            DockZoneStrip(zone: .bottom, height: CGFloat(LowerPanelRules.headerHeight), session: session, trailingWidth: 270, leadingWidth: 44) {
                Button { dock.update { $0.setCollapsed(open, for: .bottom) } } label: {
                    Lucide(.chevronDown, size: 14, color: Theme.muted).rotationEffect(.degrees(open ? 0 : 180))
                        .frame(width: 28, height: 28).contentShape(Rectangle())
                }
                .buttonStyle(.plain).padding(.leading, 4)
                .help(open ? "Fold this zone (⌘J for the terminal)" : "Unfold this zone")
                .accessibilityLabel(open ? "Fold bottom zone" : "Unfold bottom zone")
            } trailing: {
                if DockStore.shared.activeTerminals.shown(in: .bottom) != nil, let hint = ShortcutFocus.terminalTitleHint(in: KeyFocus.shared.region, terminalOpen: open) {
                    Text(verbatim: hint).font(.system(size: 11)).foregroundStyle(Theme.subtle).lineLimit(1).padding(.trailing, Space.m)
                }
            }
            DockZoneBody(zone: .bottom, session: session)
                .frame(maxWidth: .infinity, maxHeight: open ? .infinity : 0).clipped()
                .allowsHitTesting(open).accessibilityHidden(!open)
        }
        .frame(height: LowerPanelRules.frameHeight(collapsed: !open, stored: stored, column: columnHeight) + (open ? 0 : 1))
        .animation(Motion.standard, value: open)
        .background(Theme.bg)
    }

    private func dragHandle(stored: Double) -> some View {
        ZStack {
            Rectangle().fill(Color.clear)
            SplitDividerLine(vertical: false, hovering: handleHover, dragging: dragStart != nil)
        }
        .frame(height: Tokens.Divider.hit).contentShape(Rectangle())
        .splitDividerCursor(.resizeUpDown, hovering: $handleHover)
        .gesture(
            DragGesture(minimumDistance: 1, coordinateSpace: .global)
                .onChanged { v in
                    let from = dragStart ?? TerminalPanelSizing.clamp(stored, column: columnHeight)
                    dragStart = from
                    let h = TerminalPanelSizing.dragged(start: from, translation: v.translation.height, column: columnHeight)
                    DockStore.shared.update { $0.setSize(h, for: .bottom) }
                }
                .onEnded { _ in dragStart = nil }
        )
        .onTapGesture(count: 2) { DockStore.shared.update { $0.setSize(nil, for: .bottom) } }
        .accessibilityElement().accessibilityLabel("Resize bottom zone")
    }
}

// MARK: Workspaces

/// The workspace picker's items: the View menu and the window's picker share them.
struct DockWorkspaceMenuItems: View {
    var body: some View {
        let dock = DockStore.shared
        let active = dock.workspaces.active
        ForEach(dock.workspaces.workspaces) { w in
            Button {
                dock.edit { $0.switchTo(id: w.id) }
            } label: {
                if w.id == active.id { Label(w.name, systemImage: "checkmark") } else { Text(verbatim: w.name) }
            }
        }
        Divider()
        Button(WindowMenu.resetTitle(workspace: active.name)) { dock.edit { $0.resetActive() } }
        Button(WindowMenu.newWorkspaceTitle) { DockPrompts.saveAs() }
        Button("Update “\(active.name)”") { dock.edit { $0.overwriteActive() } }.disabled(active.builtIn)
        Button(WindowMenu.deleteWorkspaceTitle) { DockPrompts.confirmDelete() }.disabled(active.builtIn)
    }
}

/// Window menu's panel list (also a tab strip's right-click menu): a checkmark when open, a choice opens or closes it.
struct WindowPanelMenuItems: View {
    var includeReset = false
    // Menus (Commands) have no environment, so the model is the shared one, never `@Environment`: reading it there crashed at launch.
    private var model: AppModel { AppModel.shared }

    var body: some View {
        let dock = DockStore.shared
        ForEach(WindowMenu.items(layout: dock.layout, terminalShowing: dock.isTerminalShowing)) { item in
            Button {
                switch WindowMenu.perform(item.id, on: dock.layout, terminalShowing: dock.isTerminalShowing) {
                case .layout(let l): dock.update { $0 = l }
                case .toggleTerminal: TerminalActions.toggle(model)
                }
            } label: {
                if item.checked { Label(item.title, systemImage: "checkmark") } else { Text(verbatim: item.title) }
            }
            .registryShortcutIfAny(item.shortcut)
        }
        if includeReset {
            Divider()
            Button(WindowMenu.resetTitle(workspace: dock.workspaces.active.name)) { dock.edit { $0.resetActive() } }
        }
    }
}

extension View {
    @ViewBuilder func registryShortcutIfAny(_ id: ShortcutID?) -> some View {
        if let id { registryShortcut(id) } else { self }
    }
}

/// The window's quiet picker, at the centre strip's trailing edge.
struct DockWorkspacePicker: View {
    var body: some View {
        Menu { DockWorkspaceMenuItems() } label: {
            Image(systemName: "rectangle.3.group").font(.system(size: 14)).foregroundStyle(Theme.muted)
                .frame(width: 28, height: 28).contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
        .help("Workspace layout: \(DockStore.shared.workspaces.active.name)")
        .accessibilityLabel("Workspace layout")
    }
}

@MainActor enum DockPrompts {
    static func saveAs() {
        let alert = NSAlert()
        alert.messageText = "Save Workspace As"
        alert.informativeText = "Saves where the panels are now under a name you can switch back to."
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 240, height: 24))
        field.placeholderString = "Name"
        alert.accessoryView = field
        alert.addButton(withTitle: "Save")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        DockStore.shared.edit { $0.saveNew(name: field.stringValue) }
    }

    static func confirmDelete() {
        let active = DockStore.shared.workspaces.active
        guard !active.builtIn else { return }
        let alert = NSAlert()
        alert.messageText = "Delete “\(active.name)”?"
        alert.informativeText = "Its saved layout goes away. Default comes back."
        alert.alertStyle = .warning
        alert.addButton(withTitle: "Delete")
        alert.addButton(withTitle: "Cancel")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        DockStore.shared.edit { $0.delete(id: active.id) }
    }
}

/// A middle click on the view it overlays (a tab) runs `action`. The overlay never takes hits, so clicks, drags and the
/// context menu reach the tab; a local monitor watches for the middle button inside its bounds.
struct MiddleClick: NSViewRepresentable {
    let action: () -> Void
    func makeNSView(context: Context) -> NSView { Catcher(action: action) }
    func updateNSView(_ view: NSView, context: Context) { (view as? Catcher)?.action = action }

    final class Catcher: NSView {
        var action: () -> Void
        private var monitor: Any?
        init(action: @escaping () -> Void) { self.action = action; super.init(frame: .zero) }
        required init?(coder: NSCoder) { fatalError() }
        override func hitTest(_ point: NSPoint) -> NSView? { nil }
        override func viewDidMoveToWindow() {
            if let monitor { NSEvent.removeMonitor(monitor); self.monitor = nil }
            guard window != nil else { return }
            monitor = NSEvent.addLocalMonitorForEvents(matching: .otherMouseUp) { [weak self] event in
                guard let self, event.buttonNumber == 2, event.window === self.window else { return event }
                if self.bounds.contains(self.convert(event.locationInWindow, from: nil)) { self.action(); return nil }
                return event
            }
        }
    }
}
