import SqueakIcons
import SqueakMacCore
import SwiftUI

/// The menu-bar panel, compact and collapsible. The header holds the duck, a quiet New chat and an
/// overflow that opens Settings, Check for Updates and Quit in place. Search sits under it. One band
/// scrolls between them and the footer: what needs you and errors, then Finished (with what is new),
/// Working, and Idle folded away by default; then Keep Mac awake and Usage details, also folded.
/// Opening a band, the overflow or the awake menu keeps the panel open; the destinations close it first,
/// so focus moves with nothing left behind. Taps on a session open its quick message, with its context.
struct PopoverView: View {
    @Environment(AppModel.self) private var model
    @State private var idleOpen = false
    @State private var usageOpen = false
    @State private var overflowOpen = false
    /// Each section's order as it was when the pointer entered the list, so a row does not jump
    /// under the pointer. Nil when the pointer is off the list, and then the live order shows.
    @State private var frozenOrder: [SessionSectionKind: [SessionKey]]?
    @State private var contentHeight: CGFloat = 0
    @State private var chromeHeight: CGFloat = 0
    @State private var footerHeight: CGFloat = 0
    /// The usable height of the screen this panel's window is on; nil until it is in a window.
    @State private var hostScreenHeight: CGFloat?

    /// Offline captures pin the screen height to show a short screen. Live, the panel always draws its
    /// own 24pt surface, and `MenuPanel`'s window shadow follows it.
    var drawsOwnSurface = true
    var screenHeightOverride: CGFloat?

    static let width = PopoverMetrics.width
    /// Used until the panel is attached to a window.
    private static let fallbackScreenHeight: CGFloat = 800
    private static let minBand: CGFloat = 96
    private static let emptyHeight: CGFloat = 220
    /// The separator between the top of the panel and the band.
    private static let separator: CGFloat = 1

    /// What the panel as a whole may take: the 620pt cap, or the screen less its margin if that is less.
    private var panelCap: CGFloat {
        let screen = screenHeightOverride ?? hostScreenHeight ?? Self.fallbackScreenHeight
        return max(0, min(PopoverMetrics.maxHeight, screen - PopoverMetrics.screenMargin))
    }

    /// The footer plus the separator (1pt, 4pt above) that sits over it.
    private var footerTotal: CGFloat { footerHeight + 5 }

    /// The most the top part (header, search, banners, overflow) may take while the band keeps its
    /// minimum. A long banner or an open overflow past this scrolls inside the top part, so the panel
    /// never exceeds the cap even on a short screen.
    private var topCap: CGFloat { max(0, panelCap - footerTotal - Self.separator - Self.minBand) }

    /// The top part's height: its content, or the cap when the content does not fit. Nil until measured,
    /// so the first layout is natural.
    private var topHeight: CGFloat? { chromeHeight > 0 ? min(chromeHeight, topCap) : nil }

    /// What the band may take: the panel's cap less the top part, the separator and the footer.
    private var bandCap: CGFloat { max(0, panelCap - (topHeight ?? chromeHeight) - Self.separator - footerTotal) }

    /// The band's own height: its content, clamped to the cap, so the panel is only as tall as it needs.
    private var bandHeight: CGFloat { min(max(contentHeight, Self.minBand), bandCap) }

    var body: some View {
        @Bindable var model = model
        VStack(spacing: 0) {
            ScrollView(.vertical) {
                VStack(spacing: 0) {
                    header
                    if overflowOpen { overflowRows }
                    SearchField(text: $model.query)
                        .padding(.horizontal, PopoverMetrics.inset)
                        .padding(.bottom, Space.m)
                    banners
                }
                .measuredAsChrome()
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(height: topHeight)
            InsetSeparator()
            ScrollView(.vertical) {
                VStack(spacing: 0) {
                    list
                    InsetSeparator()
                    usage
                }
                .background(GeometryReader { Color.clear.preference(key: PopoverHeightKey.self, value: $0.size.height) })
            }
            .scrollBounceBehavior(.basedOnSize)
            .scrollIndicators(.automatic)
            .onPreferenceChange(PopoverHeightKey.self) { contentHeight = $0 }
            .frame(height: bandHeight)
            .onHover { setHovering($0) }
            InsetSeparator().padding(.top, 4)
            footer.measuredAsFooter()
        }
        .frame(width: Self.width)
        .background(ScreenHeightReader { hostScreenHeight = $0 })
        .modifier(OptionalPanelSurface(enabled: drawsOwnSurface))
        .background(escapeToClose)
        .onPreferenceChange(PopoverChromeKey.self) { chromeHeight = $0 }
        .onPreferenceChange(PopoverFooterKey.self) { footerHeight = $0 }
        .task(id: model.hasLoaded) { await model.pollLiveSteps() }
        .task {
            while !Task.isCancelled {
                await model.refreshMenuPreviews()
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }

    // MARK: Closing

    /// Hides the panel. Drafts live in the composer and the search text in the model, so nothing is lost.
    private func dismissMenu() { model.dismissMenuBar?() }

    /// Escape closes the panel. A hidden cancel-action button carries the shortcut.
    private var escapeToClose: some View {
        Button("Close", action: dismissMenu)
            .keyboardShortcut(.cancelAction)
            .opacity(0)
            .frame(width: 0, height: 0)
            .accessibilityHidden(true)
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: Space.s) {
            LogoLockup(height: 22)
            Spacer(minLength: Space.s)
            if model.health != nil, !model.isConnected {
                HStack(spacing: 5) {
                    Circle().fill(Theme.offline).frame(width: 9, height: 9)
                    Text(model.connectionTitle).font(.system(size: 12)).foregroundStyle(Theme.muted).lineLimit(1)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Connection: \(model.connectionTitle)")
            }
            Button {
                dismissMenu()
                NewChatController.shared.show()
            } label: {
                Text("New chat")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(Theme.ink)
                    .padding(.horizontal, 10)
                    .frame(height: 26)
                    .background(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).fill(Theme.ink.opacity(0.06)))
                    .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(Theme.line))
            }
            .buttonStyle(.plain)
            Button { overflowOpen.toggle() } label: {
                Lucide(.ellipsis, size: 16, label: "More", color: Theme.muted)
                    .frame(width: 26, height: 26)
                    .background(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).fill(Theme.ink.opacity(overflowOpen ? 0.09 : 0.06)))
                    .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(Theme.line))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityValue(overflowOpen ? "expanded" : "collapsed")
        }
        .padding(.horizontal, PopoverMetrics.inset)
        .padding(.top, 14)
        .padding(.bottom, Space.m)
    }

    /// The overflow, opened in place: the three things that are not a session.
    private var overflowRows: some View {
        VStack(spacing: 0) {
            MenuRow(title: "Settings…", hint: "⌘,") {
                dismissMenu()
                model.openSettings()
            }
            .keyboardShortcut(",")
            MenuRow(title: "Check for Updates…", disabled: !model.updater.canCheck) {
                dismissMenu()
                model.updater.checkForUpdates()
            }
            MenuRow(title: "Quit Squeak", hint: "⌘Q") { QuitIntent.shared.quitCompletely() }
                .keyboardShortcut("q")
        }
        .padding(.bottom, Space.xs)
    }

    private func updateRow(_ text: String, action: String, perform: @escaping () -> Void) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.s) {
            Text(text).font(.system(size: 11.5)).foregroundStyle(Theme.muted)
            Spacer(minLength: 0)
            Button(action, action: perform).buttonStyle(.plain)
                .font(.system(size: 11.5, weight: .medium)).foregroundStyle(Theme.ink)
        }
    }

    @ViewBuilder private var banners: some View {
        let showHelp = model.health != nil && model.connectionHelp != nil
        let updater = model.updater
        let showUpdate = updater.readyVersion != nil || updater.availableVersion != nil || model.updateNote != nil
        if showHelp || model.launchOfferPending || showUpdate {
            VStack(alignment: .leading, spacing: Space.s) {
                if let ready = updater.readyVersion {
                    updateRow("Update \(ready) is ready", action: "Restart to update") { updater.installNow() }
                    UpdateNotesDisclosure(notes: updater.readyNotes)
                } else if let available = updater.availableVersion {
                    updateRow("Update \(available) available", action: "Install") { dismissMenu(); updater.checkForUpdates() }
                    UpdateNotesDisclosure(notes: updater.availableNotes)
                }
                if let note = model.updateNote {
                    updateRow(note, action: "Dismiss") { model.dismissUpdateNote() }
                }
                if showHelp, let help = model.connectionHelp {
                    HStack(alignment: .top, spacing: Space.s) {
                        Text(help).font(.system(size: 11.5)).foregroundStyle(Theme.muted).lineLimit(3)
                            .fixedSize(horizontal: false, vertical: true)
                        Button("Check again") { model.recheck() }.buttonStyle(.plain)
                            .font(.system(size: 11.5, weight: .medium)).foregroundStyle(Theme.ink)
                    }
                }
                LaunchOfferBanner()
            }
            .padding(.horizontal, PopoverMetrics.inset)
            .padding(.bottom, Space.m)
        }
    }

    // MARK: Sessions

    /// The sections in attention order: what needs you, then errors, finished, working and idle.
    /// While the pointer is on the list, each session keeps the section and place it had when the pointer
    /// arrived, so nothing moves under the pointer; its row content still updates. A session that is new
    /// meanwhile joins its live section at the end.
    private var sections: [MenuSection] {
        let live = model.grouped
        let order: [SessionSectionKind] = [.needsYou, .error, .done, .working, .idle]
        guard let frozen = frozenOrder else {
            return order.compactMap { kind in
                live.first(where: { $0.kind == kind }).map { MenuSection(kind: kind, sessions: $0.sessions) }
            }
        }
        let liveByKey = Dictionary(uniqueKeysWithValues: live.flatMap(\.sessions).map { ($0.key, $0) })
        let frozenKeys = Set(frozen.values.flatMap { $0 })
        return order.compactMap { kind in
            let kept = (frozen[kind] ?? []).compactMap { liveByKey[$0] }
            let joined = (live.first(where: { $0.kind == kind })?.sessions ?? []).filter { !frozenKeys.contains($0.key) }
            let rows = kept + joined
            return rows.isEmpty ? nil : MenuSection(kind: kind, sessions: rows)
        }
    }

    /// Takes the membership and order of every section when the pointer enters the list; drops it on exit.
    private func setHovering(_ hovering: Bool) {
        if hovering {
            frozenOrder = Dictionary(uniqueKeysWithValues: model.grouped.map { ($0.kind, $0.sessions.map(\.key)) })
        } else {
            frozenOrder = nil
        }
    }

    @ViewBuilder private var list: some View {
        if model.sessions.isEmpty {
            emptyState
        } else if model.isSearching {
            searchResults
        } else {
            let sections = sections
            let quiet = !sections.contains { $0.kind == .needsYou || $0.kind == .working }
            VStack(alignment: .leading, spacing: 0) {
                if quiet { allQuiet }
                ForEach(Array(sections.enumerated()), id: \.element.id) { i, section in
                    if i > 0, section.kind != .idle { InsetSeparator().padding(.vertical, Space.xs) }
                    sectionView(section)
                }
            }
        }
    }

    @ViewBuilder private var emptyState: some View {
        VStack {
            if model.health == nil {
                EmptyStateView(symbol: .ellipsis, title: "Connecting…", message: "Looking for the Squeak service on this Mac.")
            } else if !model.isConnected {
                EmptyStateView(symbol: .zapOff, title: "No sessions to show", message: "Squeak can't reach its service yet, so there is nothing to list.")
            } else {
                EmptyStateView(symbol: .inbox, title: "No sessions yet", message: "Start a chat in Conductor and it shows up here, with its replies.")
            }
        }
        .frame(maxWidth: .infinity)
        .frame(height: Self.emptyHeight)
    }

    private var searchResults: some View {
        let hits = model.searchHits
        return Group {
            if hits.isEmpty {
                EmptyStateView(symbol: .search, title: "No matches", message: "Search looks at titles and messages Squeak has already opened on this Mac.")
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, Space.l)
            } else {
                VStack(spacing: 0) {
                    ForEach(hits, id: \.key) { hit in
                        if let s = model.session(hit.key) {
                            sessionRow(s, detail: hit.titleMatch ? nil : hit.snippet)
                        }
                    }
                }
                .padding(.vertical, Space.xs)
            }
        }
    }

    private var allQuiet: some View {
        VStack(spacing: Space.xs) {
            Text("All quiet").font(Typo.label).foregroundStyle(Theme.ink)
            Text("Nothing needs you right now.").font(Typo.body).foregroundStyle(Theme.muted)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, Space.l)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private func sectionView(_ section: MenuSection) -> some View {
        switch section.kind {
        case .needsYou:
            VStack(alignment: .leading, spacing: Space.xs) {
                MenuSectionHeader(title: "Needs you", count: section.sessions.count)
                ForEach(section.sessions) { sessionRow($0) }
            }
            .padding(.vertical, Space.xs)
        case .error:
            VStack(alignment: .leading, spacing: Space.xs) {
                MenuSectionHeader(title: "Errors", count: section.sessions.count)
                ForEach(section.sessions) { sessionRow($0, detail: model.menuReplyPreviews[$0.key]) }
            }
            .padding(.vertical, Space.xs)
        case .done:
            let unread = section.sessions.filter { model.hasUnreadUpdate(for: $0.key) }.count
            VStack(alignment: .leading, spacing: Space.xs) {
                MenuSectionHeader(title: "Finished", count: section.sessions.count, note: unread > 0 ? "\(unread) new" : nil)
                ForEach(section.sessions) { s in
                    sessionRow(s, detail: model.menuReplyPreviews[s.key], unread: model.hasUnreadUpdate(for: s.key))
                }
            }
            .padding(.vertical, Space.xs)
        case .working:
            VStack(alignment: .leading, spacing: Space.xs) {
                MenuSectionHeader(title: "Working", count: section.sessions.count)
                ForEach(section.sessions) { sessionRow($0) }
            }
            .padding(.vertical, Space.xs)
        case .idle:
            MenuDisclosure(title: "Idle", count: section.sessions.count, expanded: $idleOpen) {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(section.sessions) { sessionRow($0) }
                }
                .padding(.bottom, Space.xs)
            }
            .padding(.vertical, Space.xs)
        }
    }

    private func sessionRow(_ s: HostSession, detail: String? = nil, unread: Bool = false) -> some View {
        MenuSessionRow(session: s, detail: detail, unread: unread) { openSession(s) }
            .contextMenu {
                Button(model.pinned.contains(s.key) ? "Unpin" : "Pin to top") { model.togglePin(s.key) }
            }
    }

    /// A session opens its quick message with its context. The panel closes first, so focus goes
    /// straight to the composer and nothing is left behind. Read state is not touched here: the
    /// composer marks a reply read once its context has actually loaded.
    private func openSession(_ s: HostSession) {
        dismissMenu()
        QuickComposerController.shared.show(target: s.key)
    }

    // MARK: Usage and awake

    /// Plan usage, folded away. No percentage in the collapsed row: the expanded `UsageSection` names
    /// each window and its freshness, and owns the one poll that keeps it current.
    private var usage: some View {
        MenuDisclosure(title: "Usage details", expanded: $usageOpen) {
            UsageSection()
        }
    }

    // MARK: Footer

    private var footer: some View {
        VStack(spacing: 0) {
            // Pinned, not in the scrolling band: whether the Mac is being kept awake is state to see at a glance.
            if model.awakeOffered {
                AwakeRow()
                InsetSeparator().padding(.bottom, 4)
            }
            MenuRow(title: "Quick message…", hint: "⌘K") {
                dismissMenu()
                QuickComposerController.shared.show()
            }
            .keyboardShortcut("k")
            MenuRow(title: "Open Squeak") {
                dismissMenu()
                model.showConversationWindow()
            }
        }
        .padding(.top, 4)
        .padding(.bottom, 6)
    }
}

/// One section of the menu, in attention order. Its sessions may be frozen in order under the pointer.
private struct MenuSection: Identifiable {
    let kind: SessionSectionKind
    var sessions: [HostSession]
    var id: String { kind.rawValue }
}

private struct OptionalPanelSurface: ViewModifier {
    let enabled: Bool
    @ViewBuilder func body(content: Content) -> some View {
        if enabled { content.panelSurface() } else { content }
    }
}

private struct PopoverHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}

/// DESIGN.md §3.2 `panel-glass`: the system's own popover material, blurring what is behind the
/// menu, with a light tint over it, so the panel reads as glass rather than a painted sheet.
/// Reduce Transparency gets the near-opaque `panel-translucent`.
struct PanelBackground: View {
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency

    var body: some View {
        if reduceTransparency {
            Theme.panelTranslucent
        } else {
            ZStack {
                VisualEffectBackground(material: .popover)
                Theme.panelGlass
            }
        }
    }
}

struct VisualEffectBackground: NSViewRepresentable {
    var material: NSVisualEffectView.Material

    func makeNSView(context: Context) -> NSVisualEffectView {
        let view = NSVisualEffectView()
        view.material = material
        view.blendingMode = .behindWindow
        view.state = .active
        return view
    }

    func updateNSView(_ view: NSVisualEffectView, context: Context) {
        view.material = material
    }
}
