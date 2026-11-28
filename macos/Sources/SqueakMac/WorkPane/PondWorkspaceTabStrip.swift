import SqueakIcons
import SqueakMacCore
import SwiftUI

/// Opens a Duck or an item in the centre. The overflow list offers the same destinations when the strip scrolls.
/// `embedded` is the one top bar's strip (DESIGN.md 8.12): low oval tabs filling the rest of the bar's row, with no row
/// of its own. Not embedded (a chat that is not a Duck view) it draws its own row.
struct PondWorkspaceTabStrip: View {
    let workspace: PondWorkspace
    let strip: PondWorkspaceStrip
    var leadingInset: CGFloat = 0
    var embedded = false
    @Environment(AppModel.self) private var model
    @Environment(\.workbenchVisible) private var visible
    private var live: PondLiveTabs { PondLiveTabsModel.shared.live(workspace.project.id) }
    @State private var overflow = PondStripOverflow(contentStart: 0, contentEnd: 0, viewport: 0)
    @State private var showingList = false
    @Namespace private var viewport

    var body: some View {
        VStack(spacing: 0) {
            if !strip.isEmpty {
                if embedded {
                    stripRow.frame(height: CGFloat(PondBarMetrics.rowHeight))
                } else {
                    stripRow
                        .padding(.horizontal, Space.m)
                        .frame(height: DuckRowMetrics.height)
                        .background(WindowDragArea())
                        .overlay(alignment: .bottom) { Rectangle().fill(Theme.line).frame(height: 1) }
                }
            }
        }
        .task(id: visible ? workspace.project.id : nil) { if visible { workspace.roster.keepFresh(host: model.nativeHost) } }
        .onChange(of: workspace.threads) { workspace.roster.refreshSoon(host: model.nativeHost) }
        // Live tabs: an open diff, file or artifact is read again every few seconds, so a pill you are not on can say
        // "updated" and a tab whose source is gone can say so.
        .task(id: visible ? workspace.project.id : nil) {
            guard visible else { return }
            while !Task.isCancelled {
                await PondLiveTabsModel.shared.refresh(workspace: workspace, model: model)
                try? await Task.sleep(for: .seconds(3))
            }
        }
    }

    private var stripRow: some View {
        HStack(spacing: Space.s) {
            if leadingInset > 0 { Color.clear.frame(width: leadingInset) }
            scroller
            if overflow.isOverflowing || showingList {
                // Flow: the strip is wider than the bar; this lists every Duck and item so one can be picked without scrolling.
                Button { showingList.toggle() } label: {
                    Lucide(.ellipsis, size: 16, color: Theme.muted)
                        .frame(width: 28, height: 28).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .help("Show all tabs").accessibilityLabel("Show all tabs")
                .popover(isPresented: $showingList, arrowEdge: .bottom) { tabList }
            }
        }
        .accessibilityElement(children: .contain).accessibilityLabel("Pond tabs")
    }

    /// The open Duck's current step: only that Duck's chat is loaded here, so only its tab can say "editing auth.ts".
    private var tabs: [PondStripTab] {
        let working = model.activity.isEmpty ? nil : ChatTimeline.workingLabel(model.activity)
        // A Duckling's pill reads the host's record of it (its parent chat's set), so it keeps saying "Done" after it ends.
        var records: [TabItem: Duckling] = [:]
        for item in strip.items {
            guard let source = item.ducklingSource, let key = SessionKey(stringValue: source.session), let parent = model.session(key),
                  let record = model.ducklings(for: parent)?.items.first(where: { $0.id == source.task }) else { continue }
            records[item] = record
        }
        return strip.tabs(activity: working, ducklings: records)
    }

    private var selected: TabItem? { strip.currentItem ?? strip.row.selectedDuck.map(TabItem.duck) }

    private var scroller: some View {
        PondTabsRow(
            tabs: tabs, selected: selected, height: embedded ? PondBarMetrics.height : DuckRowMetrics.height,
            label: { label(for: $0) }, updated: { live.isUpdated($0) }, gone: { live.goneState($0) != nil },
            select: select, close: close, overflow: $overflow)
    }

    private var tabList: some View {
        ScrollView([.horizontal, .vertical]) {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(tabs) { tab in
                    if let duck = tab.duck {
                        listRow(tab.item, title: tab.title ?? duck.name) { ThreadDuckView(id: duck.colourSeed, size: 16) }
                            .disabled(!duck.opensChat).help(tab.help ?? "")
                    } else {
                        let label = label(for: tab.item)
                        listRow(tab.item, title: label.title) { label.icon }.help(label.help)
                    }
                }
            }
            .padding(Space.s)
        }
        .frame(width: 300, height: 250)
        .accessibilityLabel("All Pond tabs")
    }

    private func listRow<Icon: View>(_ tab: TabItem, title: String, @ViewBuilder icon: () -> Icon) -> some View {
        Button {
            showingList = false
            select(tab)
        } label: {
            HStack(spacing: Space.s) {
                icon().frame(width: 16)
                Text(verbatim: title).lineLimit(1).fixedSize()
                if tab == selected { Lucide(.check, size: 12, color: Theme.muted) }
            }
            .padding(.horizontal, Space.s)
            .frame(minWidth: 276, minHeight: 26, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(tab == selected ? .isSelected : [])
    }

    /// Flow: an item tab closes its item; a Closed Duck's tab (open only while its chat shows) closes back to the Room.
    /// Closing never opens or closes the duck.
    private func close(_ tab: PondStripTab) {
        guard tab.closable else { return }
        if tab.duck == nil { model.closePondItem(tab.item); return }
        RoomViewPref.shared.set(.room, for: workspace.pond)
        model.openPondHome(workspace.pond)
    }

    private func select(_ tab: TabItem) {
        PondLiveTabsModel.shared.visit(tab, pond: workspace.project.id)
        model.selectPondTab(tab, in: workspace, strip: strip)
    }

    private func label(for item: TabItem) -> PondItemLabel {
        PondItemLabel(item: item, workspace: workspace, model: model)
    }
}

struct PondItemLabel {
    let title: String
    let symbol: String
    let help: String
    let colourSeed: String?

    init(title: String, symbol: String, help: String? = nil, colourSeed: String? = nil) {
        self.title = title; self.symbol = symbol; self.help = help ?? title; self.colourSeed = colourSeed
    }

    @MainActor init(item: TabItem, workspace: PondWorkspace, model: AppModel) {
        let source = item.diffSource.flatMap { SessionKey(stringValue: $0.session) }.flatMap { model.session($0) }
        let nativeId = source.flatMap(NativeAdapter.nativeId)
        let duck = workspace.roster.ducks?.first { $0.id == source?.duckId || (nativeId != nil && $0.currentSessionId == nativeId) }
        let duckName = duck?.name ?? source.map { model.workbenchTitle($0) }
        colourSeed = item.diffSource == nil ? nil : (duck?.colourSeed ?? source.map { TabItem.duckID(of: $0) })
        switch item.kind {
        case .file:
            let path = item.fileSource?.path ?? item.id
            title = ChangesPresentation.fileName(path)
            help = item.fileSource.map { $0.path.hasPrefix("/") ? $0.path : "\($0.root)/\($0.path)" } ?? path
            symbol = "doc.text"
        case .diff:
            let path = item.diffSource?.path ?? item.id
            title = ChangesPresentation.fileName(path)
            help = [duckName, item.diffSource?.stream?.branch, path].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
            symbol = "plus.forwardslash.minus"
        case .reviewAll:
            // A Duck in two Streams has two review tabs: the branch tells them apart.
            let streamBranch = item.diffSource?.stream?.branch
            let branch = (streamBranch?.isEmpty ?? true) ? nil : streamBranch
            title = duckName.map { "Review \($0)" + (branch.map { " · \($0)" } ?? "") } ?? "Review all changes"
            help = title
            symbol = "square.stack"
        case .artifact:
            let path = ArtifactTabID.parse(item.id)?.path ?? item.id
            let artifact = ArtifactsStore.shared.model(for: workspace.project.id).items.first { $0.path == path }
            title = artifact?.name ?? ChangesPresentation.fileName(path)
            help = path
            symbol = "photo.on.rectangle"
        case .notebook:
            title = "Notebook"
            help = "Pond Notebook"
            symbol = "book.closed"
        case .duckling:
            title = "Duckling"
            help = title
            symbol = "bubble.left"
        case .duck:
            title = item.id
            help = title
            symbol = "bubble.left"
        }
    }

    var icon: some View {
        Image(systemName: symbol).font(.system(size: 12)).foregroundStyle(Theme.muted).accessibilityHidden(true)
    }
}

/// The translucent fills of the one top surface (spec, "Top area as one surface"): borderless tabs and the glass switch lie on
/// the Pond's quiet tint, so they are plain white or black veils rather than opaque `surface` colours.
enum TopSurfaceGlass {
    private static func veil(dark: CGFloat, light: CGFloat, darkWhite: Bool = true) -> Color {
        Color(nsColor: NSColor(name: nil) { a in
            a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
                ? NSColor(white: 1, alpha: dark) : NSColor(white: 0, alpha: light)
        })
    }
    /// A tab at rest: borderless, barely there.
    static let tab = veil(dark: 0.06, light: 0.045)
    static let tabHover = veil(dark: 0.11, light: 0.08)
    /// The selected tab is the only raised one: a brighter veil (white in light) with a soft drop shadow, never a border.
    static let tabSelected = Color(nsColor: NSColor(name: nil) { a in
        a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(white: 1, alpha: 0.17) : NSColor(white: 1, alpha: 0.85)
    })
    static let tabShadow = veil(dark: 0.30, light: 0.10).opacity(1)
    /// The Dashboard | Room switch: a glass track with a brighter pill.
    static let switchTrack = veil(dark: 0.08, light: 0.06)
    static let switchPill = Color(nsColor: NSColor(name: nil) { a in
        a.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua ? NSColor(white: 1, alpha: 0.18) : NSColor(white: 1, alpha: 0.9)
    })
}

/// One low oval tab (DESIGN.md 8.12). A Duck's has two compact lines: its chat's title, then the glyph (animated only while
/// working; the amber triangle when it needs you) and what it is doing. An item's has an icon and its name. The selected
/// tab is raised: `surface-raised` fill and a `lineStrong` border (no shadow inside the window). Labels may shorten, with the
/// full text as the tooltip; they never wrap.
struct PondOvalTab: View {
    let tab: PondStripTab
    let label: PondItemLabel?
    let selected: Bool
    /// The tab changed since the person last looked (a quiet dot); `gone` dims it, its page says why.
    let updated: Bool
    let gone: Bool
    let select: () -> Void
    let close: () -> Void
    @Environment(\.colorScheme) private var scheme
    @State private var hovering = false

    static let height = CGFloat(PondBarMetrics.controlHeight)

    var body: some View {
        let isDuck = tab.duck != nil || tab.item.kind == .duckling
        content.contentShape(Rectangle())
            .onTapGesture { if tab.duck?.opensChat != false { select() } }
            .frame(minWidth: isDuck ? nil : CGFloat(PondBarMetrics.itemTabWidth.lowerBound), alignment: .leading)
            .frame(maxWidth: CGFloat(isDuck ? PondBarMetrics.duckTabMaxWidth : PondBarMetrics.itemTabWidth.upperBound), alignment: .leading)
            .fixedSize(horizontal: true, vertical: false)
            .frame(height: Self.height)
            // The close control floats over the tab's trailing edge on hover and reserves no room of its own, so a tab is as
            // wide as its content.
            .overlay(alignment: .trailing) {
                if tab.closable, hovering {
                    Button(action: close) {
                        Lucide(.x, size: 12, color: Theme.muted).frame(width: 22, height: 22)
                            .background(TopSurfaceGlass.tabHover, in: Circle()).contentShape(Rectangle())
                    }
                    .buttonStyle(.plain).padding(.trailing, 6)
                    .help("Close").accessibilityLabel("Close \(tab.title ?? label?.title ?? "tab")")
                }
            }
            // Borderless translucent tabs on the top surface; only the selected one is raised (brighter veil and a soft shadow).
            .background {
                Capsule().fill(selected ? TopSurfaceGlass.tabSelected : (hovering ? TopSurfaceGlass.tabHover : TopSurfaceGlass.tab))
                    .shadow(color: selected ? TopSurfaceGlass.tabShadow : .clear, radius: 3, y: 1)
            }
            .opacity(gone || (tab.duck.map { !$0.isOpen } ?? false) ? 0.7 : 1)
            .onHover { hovering = $0 }
            .help(help)
            .accessibilityElement(children: .combine)
            .accessibilityLabel(help.replacingOccurrences(of: "\n", with: ", "))
            .accessibilityValue(updated ? "updated" : "")
            .accessibilityAddTraits(selected ? [.isSelected, .isButton] : .isButton)
            .accessibilityAction(named: Text("Close tab")) { if tab.closable { close() } }
    }

    private var help: String { tab.help ?? label?.help ?? "" }

    @ViewBuilder private var content: some View {
        if let duck = tab.duck {
            HStack(spacing: 8) {
                ThreadDuckView(id: duck.colourSeed, size: 20).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: tab.title ?? duck.name).font(Typo.label).foregroundStyle(Theme.ink)
                        .lineLimit(1).truncationMode(.tail)
                    HStack(spacing: 4) {
                        if duck.showsWorkingGlyph {
                            WorkingGlyph(slot: 12, alignment: .center, grid: .micro).scaleEffect(0.8).frame(width: 12, height: 12)
                        } else if duck.needsYou {
                            Lucide(.triangleAlert, size: 10, color: Theme.warning).frame(width: 12, height: 12)
                        }
                        Text(verbatim: tab.status ?? "").font(.system(size: 11)).foregroundStyle(Theme.muted)
                            .lineLimit(1).truncationMode(.tail)
                    }
                }
            }
            .padding(.horizontal, 12)
        } else if tab.item.kind == .duckling {
            HStack(spacing: 8) {
                DucklingView(parentId: tab.item.parentDuck ?? tab.item.id, parentSize: 20).accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: tab.title ?? "Duckling").font(Typo.label).foregroundStyle(Theme.ink).lineLimit(1).truncationMode(.tail)
                    Text(verbatim: tab.status ?? "").font(.system(size: 11)).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.tail)
                }
            }
            .padding(.horizontal, 12)
        } else if let label {
            HStack(spacing: 6) {
                label.icon
                Text(verbatim: label.title).font(Typo.label).lineLimit(1).truncationMode(.middle)
                if updated { Circle().fill(Theme.info).frame(width: 6, height: 6).accessibilityHidden(true) }
                if let seed = label.colourSeed {
                    let rgb = ThreadDuck.rgb(for: seed, dark: scheme == .dark)
                    Circle().fill(Color(red: rgb.r, green: rgb.g, blue: rgb.b)).frame(width: 6, height: 6).accessibilityHidden(true)
                }
            }
            .foregroundStyle(selected ? Theme.ink : Theme.muted)
            .padding(.horizontal, 14)
        }
    }
}

/// The tab row: oval tabs at their natural width (a Duck's up to 280pt, an item's between 96 and 200), scrolling only when the
/// bar is really full. Data in, taps out, so the offscreen snapshots draw the same row the app does.
struct PondTabsRow: View {
    let tabs: [PondStripTab]
    let selected: TabItem?
    var height = CGFloat(PondBarMetrics.height)
    let label: (TabItem) -> PondItemLabel
    var updated: (TabItem) -> Bool = { _ in false }
    var gone: (TabItem) -> Bool = { _ in false }
    var select: (TabItem) -> Void = { _ in }
    var close: (PondStripTab) -> Void = { _ in }
    @Binding var overflow: PondStripOverflow
    @Namespace private var viewport

    var body: some View {
        GeometryReader { geometry in
            ScrollViewReader { proxy in
                ScrollView(.horizontal) {
                    HStack(spacing: CGFloat(PondBarMetrics.tabGap)) {
                        ForEach(tabs) { tab in
                            PondOvalTab(tab: tab, label: tab.duck == nil ? label(tab.item) : nil, selected: selected == tab.item,
                                        updated: updated(tab.item) && selected != tab.item, gone: gone(tab.item),
                                        select: { select(tab.item) }, close: { close(tab) })
                                .id(tab.item)
                        }
                    }
                    // A little room each side so the first and last outlines are never clipped by the scroll view.
                    .padding(.horizontal, 2)
                    .frame(height: height)
                    .fixedSize(horizontal: true, vertical: false)
                    .background {
                        GeometryReader { content in
                            let frame = content.frame(in: .named(viewport))
                            let edges = PondStripOverflow(contentStart: frame.minX, contentEnd: frame.maxX, viewport: geometry.size.width)
                            Color.clear.onChange(of: edges, initial: true) { _, value in overflow = value }
                        }
                    }
                }
                .coordinateSpace(name: viewport)
                .scrollIndicators(.hidden)
                .mask {
                    HStack(spacing: 0) {
                        if overflow.leading { LinearGradient(colors: [.clear, .black], startPoint: .leading, endPoint: .trailing).frame(width: 8) }
                        Rectangle()
                        if overflow.trailing { LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing).frame(width: 8) }
                    }
                }
                .onChange(of: selected, initial: true) { _, tab in
                    if let tab { proxy.scrollTo(tab) }
                }
            }
        }
        // The strip is as wide as its tabs, so a bar with room leaves the rest empty rather than stretching tabs.
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
