import SqueakIcons
import SqueakMacCore
import SwiftUI

/// Opens a Duck or an item in the centre. The overflow list offers the same destinations when the strip scrolls.
struct PondWorkspaceTabStrip: View {
    let workspace: PondWorkspace
    let strip: PondWorkspaceStrip
    var leadingInset: CGFloat = 0
    @Environment(AppModel.self) private var model
    @Environment(\.workbenchVisible) private var visible
    @State private var overflow = PondStripOverflow(contentStart: 0, contentEnd: 0, viewport: 0)
    @State private var showingList = false
    @Namespace private var viewport

    var body: some View {
        VStack(spacing: 0) {
            if !strip.isEmpty {
                HStack(spacing: Space.s) {
                    if leadingInset > 0 { Color.clear.frame(width: leadingInset) }
                    scroller
                    if overflow.isOverflowing || showingList {
                        Button { showingList.toggle() } label: {
                            Lucide(.ellipsis, size: 16, color: Theme.muted)
                                .frame(width: 28, height: 28).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .help("Show all tabs").accessibilityLabel("Show all tabs")
                        .popover(isPresented: $showingList, arrowEdge: .bottom) { tabList }
                    }
                }
                .padding(.horizontal, Space.m)
                .frame(height: DuckRowMetrics.height)
                .background(WindowDragArea())
                .overlay(alignment: .bottom) { Rectangle().fill(Theme.line).frame(height: 1) }
                .accessibilityElement(children: .contain).accessibilityLabel("Pond tabs")
            }
        }
        .task(id: visible ? workspace.threads : nil) {
            guard visible else { return }
            try? await Task.sleep(for: .milliseconds(250))
            if !Task.isCancelled { await workspace.roster.refresh(host: model.nativeHost) }
        }
        .task(id: visible) {
            guard visible else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(6))
                if !Task.isCancelled { await workspace.roster.refresh(host: model.nativeHost) }
            }
        }
    }

    private var selected: TabItem? { strip.currentItem ?? strip.row.selectedDuck.map(TabItem.duck) }

    private var scroller: some View {
        GeometryReader { geometry in
            ScrollViewReader { proxy in
                ScrollView(.horizontal) {
                    HStack(spacing: 8) {
                        ForEach(strip.row.ducks) { duck in
                            let tab = TabItem.duck(duck.id)
                            PondDuckCircle(duck: duck, selected: selected == tab) { select(tab) }.id(tab)
                        }
                        if !strip.row.isEmpty && !strip.items.isEmpty {
                            Rectangle().fill(Theme.line).frame(width: 1, height: 22).accessibilityHidden(true)
                        }
                        ForEach(strip.items, id: \.self) { item in
                            PondItemPill(label: label(for: item), selected: selected == item,
                                         select: { select(item) }, close: { model.closePondItem(item) })
                                .id(item)
                        }
                    }
                    .padding(.horizontal, 8)
                    .frame(height: DuckRowMetrics.height)
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
    }

    private var tabList: some View {
        ScrollView([.horizontal, .vertical]) {
            VStack(alignment: .leading, spacing: 2) {
                ForEach(strip.row.ducks) { duck in
                    let tab = TabItem.duck(duck.id)
                    listRow(tab, title: duck.name) { ThreadDuckView(id: duck.colourSeed, size: 16) }
                        .disabled(!duck.opensChat)
                }
                if !strip.row.isEmpty && !strip.items.isEmpty { Divider() }
                ForEach(strip.items, id: \.self) { item in
                    let label = label(for: item)
                    listRow(item, title: label.title) { label.icon }
                        .help(label.help)
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

    private func select(_ tab: TabItem) { model.selectPondTab(tab, in: workspace, strip: strip) }

    private func label(for item: TabItem) -> PondItemLabel {
        PondItemLabel(item: item, workspace: workspace, model: model)
    }
}

struct PondItemLabel {
    let title: String
    let symbol: String
    let help: String
    let colourSeed: String?

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
            help = [duckName, path].compactMap { $0 }.joined(separator: " · ")
            symbol = "plus.forwardslash.minus"
        case .reviewAll:
            title = duckName.map { "Review \($0)" } ?? "Review all changes"
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
        case .duck, .duckling:
            title = item.id
            help = title
            symbol = "bubble.left"
        }
    }

    var icon: some View {
        Image(systemName: symbol).font(.system(size: 12)).foregroundStyle(Theme.muted).accessibilityHidden(true)
    }
}

private struct PondItemPill: View {
    let label: PondItemLabel
    let selected: Bool
    let select: () -> Void
    let close: () -> Void
    @Environment(\.colorScheme) private var scheme
    @State private var hovering = false

    var body: some View {
        HStack(spacing: 0) {
            Button(action: select) {
                HStack(spacing: 6) {
                    label.icon
                    Text(verbatim: label.title).font(Typo.label).lineLimit(1).fixedSize()
                    if let seed = label.colourSeed {
                        let rgb = ThreadDuck.rgb(for: seed, dark: scheme == .dark)
                        Circle().fill(Color(red: rgb.r, green: rgb.g, blue: rgb.b))
                            .frame(width: 6, height: 6).accessibilityHidden(true)
                    }
                }
                .foregroundStyle(selected ? Theme.ink : Theme.muted)
                .padding(.leading, 10).padding(.trailing, 4)
                .frame(height: 28).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(label.help)
            .accessibilityAddTraits(selected ? .isSelected : [])
            .accessibilityAction(named: Text("Close tab"), close)
            Button(action: close) {
                Lucide(.x, size: 12, color: Theme.muted).frame(width: 22, height: 28).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help("Close \(label.title)").accessibilityLabel("Close \(label.title)")
            .opacity(hovering ? 1 : 0)
            .disabled(!hovering).accessibilityHidden(!hovering)
        }
        .padding(.trailing, 3)
        .background(selected ? Theme.selected : Theme.surface, in: Capsule())
        .overlay { Capsule().strokeBorder(selected ? Theme.lineStrong : Theme.line).allowsHitTesting(false) }
        .onHover { hovering = $0 }
    }
}

private struct PondDuckCircle: View {
    let duck: DuckRowAvatar
    let selected: Bool
    let action: () -> Void
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let rgb = ThreadDuck.rgb(for: duck.colourSeed, dark: scheme == .dark)
        let colour = Color(red: rgb.r, green: rgb.g, blue: rgb.b)
        Button(action: action) {
            Circle().fill(selected ? Theme.selected : Theme.surfaceRaised)
                .overlay { Circle().fill(colour.opacity(0.18)) }
                .overlay { Circle().strokeBorder(selected ? Theme.lineStrong : .clear, lineWidth: 2) }
                .frame(width: DuckRowMetrics.avatar, height: DuckRowMetrics.avatar)
                .overlay { ThreadDuckView(id: duck.colourSeed, size: 22) }
                .overlay(alignment: .bottomTrailing) {
                    if duck.showsWorkingGlyph {
                        WorkingGlyph(slot: 12, alignment: .center, grid: .micro)
                            .scaleEffect(0.8).frame(width: 15, height: 15)
                            .background(Theme.bg, in: Circle()).offset(x: 3, y: 3)
                    }
                }
                .overlay(alignment: .topTrailing) {
                    if duck.needsYou {
                        Lucide(.triangleAlert, size: 10, color: Theme.warning).frame(width: 15, height: 15)
                            .background(Theme.bg, in: Circle()).offset(x: 3, y: -3)
                    }
                }
                .opacity(duck.onDuty ? 1 : 0.6)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .disabled(!duck.opensChat)
        .help(duck.opensChat ? "\(duck.name) · \(duck.presenceLine)" : "\(duck.name) has no chat yet")
        .accessibilityLabel("\(duck.name), \(duck.presenceLine)")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}
