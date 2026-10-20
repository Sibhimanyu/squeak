import SqueakIcons
import SqueakMacCore
import SwiftUI

/// The menu-bar panel, in the manner of the system's own menus (Sound, Wi-Fi): a compact rounded
/// surface of native material, muted section headings, grouped bands for what is live, inset
/// separators, and the actions as plain menu rows at the foot. The list takes whatever height the
/// screen leaves and scrolls. Choice taps and inline replies go through `AppModel.send`, a
/// deliberate user tap.
struct PopoverView: View {
    @Environment(AppModel.self) private var model
    @State private var showEarlier = false
    @State private var notices: [SessionKey: String] = [:]
    @State private var contentHeight: CGFloat = 0
    @State private var chromeHeight: CGFloat = 0
    @State private var footerHeight: CGFloat = 0
    /// The usable height of the screen this panel's window is on; nil until it is in a window.
    @State private var hostScreenHeight: CGFloat?

    /// Offline previews draw their own panel surface (the real `MenuBarExtra` window draws the
    /// system's) and may pin the screen height to show a short screen.
    var drawsOwnSurface = false
    var screenHeightOverride: CGFloat?

    static let width = PopoverMetrics.width
    /// Used until the panel is attached to a window.
    private static let fallbackScreenHeight: CGFloat = 800
    private static let minList: CGFloat = 96

    /// What the panel as a whole may take.
    private var available: CGFloat {
        max(0, (screenHeightOverride ?? hostScreenHeight ?? Self.fallbackScreenHeight) - PopoverMetrics.screenMargin)
    }

    /// What the list may take: the usable height less the panel's fixed parts and footer.
    private var listCap: CGFloat { max(Self.minList, available - chromeHeight - Self.outerSeparators - footerTotal) }

    /// The two separators inside the outer scroll view.
    private static let outerSeparators: CGFloat = 2
    /// The footer plus the separator (1pt, 4pt above) that sits over it.
    private var footerTotal: CGFloat { footerHeight + 5 }

    private static let emptyHeight: CGFloat = 220

    /// The list's own height when the panel does not overflow: the empty state or the measured rows,
    /// clamped to what the screen leaves.
    private var currentListHeight: CGFloat {
        model.sessions.isEmpty ? min(Self.emptyHeight, listCap) : min(max(contentHeight, Self.minList), listCap)
    }

    /// The fixed parts (header, banners, awake note, usage) plus the footer leave less than a
    /// minimal list. Then everything above the footer scrolls as one, and the list does not.
    private var overflows: Bool { chromeHeight + Self.outerSeparators + footerTotal + Self.minList > available }

    var body: some View {
        @Bindable var model = model
        VStack(spacing: 0) {
            // One scroll path: the whole upper part when it cannot fit, otherwise only the list.
            ScrollView(overflows ? .vertical : []) {
                VStack(spacing: 0) {
                    VStack(spacing: 0) {
                        header
                        SearchField(text: $model.query)
                            .padding(.horizontal, PopoverMetrics.inset)
                            .padding(.bottom, Space.m)
                        banners
                    }
                    .measuredAsChrome()
                    InsetSeparator()
                    content
                    InsetSeparator()
                    VStack(spacing: 0) {
                        if model.awakeOffered {
                            GroupBand { AwakeRow() }
                            InsetSeparator()
                        }
                        GroupBand { UsageSection() }
                    }
                    .measuredAsChrome()
                }
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(height: overflows
                ? max(Self.minList, available - footerTotal)
                : chromeHeight + Self.outerSeparators + currentListHeight)
            InsetSeparator().padding(.top, 4)
            footer.measuredAsFooter()
        }
        .frame(width: Self.width)
        .background(ScreenHeightReader { hostScreenHeight = $0 })
        .modifier(OptionalPanelSurface(enabled: drawsOwnSurface))
        .onPreferenceChange(PopoverChromeKey.self) { chromeHeight = $0 }
        .onPreferenceChange(PopoverFooterKey.self) { footerHeight = $0 }
        .task(id: model.hasLoaded) { await model.pollLiveSteps() }
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: Space.s) {
            LogoLockup(height: 22)
            Spacer()
            if model.health != nil, !model.isConnected {
                HStack(spacing: 5) {
                    Circle().fill(Theme.offline).frame(width: 9, height: 9)
                    Text(model.connectionTitle).font(.system(size: 12)).foregroundStyle(Theme.muted).lineLimit(1)
                }
                .accessibilityElement(children: .combine)
                .accessibilityLabel("Connection: \(model.connectionTitle)")
            }
        }
        .padding(.horizontal, PopoverMetrics.inset)
        .padding(.top, 14)
        .padding(.bottom, Space.m)
    }

    @ViewBuilder private var banners: some View {
        let showHelp = model.health != nil && model.connectionHelp != nil
        if showHelp || model.launchOfferPending {
            VStack(alignment: .leading, spacing: Space.s) {
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

    // MARK: Content

    @ViewBuilder private var content: some View {
        if model.sessions.isEmpty {
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
            .frame(height: overflows ? Self.emptyHeight : currentListHeight)
        } else {
            ScrollView(overflows ? [] : .vertical) {
                list
                    .padding(.vertical, 4)
                    .background(
                        GeometryReader { Color.clear.preference(key: PopoverHeightKey.self, value: $0.size.height) }
                    )
            }
            .onPreferenceChange(PopoverHeightKey.self) { contentHeight = $0 }
            .frame(height: overflows ? max(contentHeight, Self.minList) : currentListHeight)
            .scrollIndicators(.automatic)
        }
    }

    @ViewBuilder private var list: some View {
        if model.isSearching {
            let hits = model.searchHits
            if hits.isEmpty {
                EmptyStateView(symbol: .search, title: "No matches", message: "Search looks at titles and messages Squeak has already opened on this Mac.")
                    .frame(maxWidth: .infinity)
            } else {
                VStack(spacing: 0) {
                    ForEach(hits, id: \.key) { hit in
                        if let s = model.session(hit.key) { row(s, snippet: hit.titleMatch ? nil : hit.snippet) }
                    }
                }
                .padding(.horizontal, 4)
            }
        } else {
            let sections = model.grouped
            let quiet = !sections.contains { $0.kind == .needsYou || $0.kind == .working }
            let now = Date()
            VStack(alignment: .leading, spacing: 0) {
                if quiet { allQuiet }
                ForEach(Array(sections.enumerated()), id: \.element.id) { i, section in
                    // What is live sits on a band; the rest on the glass, split by inset separators.
                    let live = Self.isLive(section.kind)
                    // Quiet groups split by an inset line; so do two live bands that touch.
                    if i > 0, live == Self.isLive(sections[i - 1].kind) { InsetSeparator().padding(.vertical, live ? 0 : Space.xs) }
                    if live {
                        GroupBand { sectionView(section, now: now).padding(.vertical, Space.s) }
                    } else {
                        sectionView(section, now: now).padding(.vertical, Space.xs)
                    }
                }
            }
        }
    }

    private static func isLive(_ kind: SessionSectionKind) -> Bool { kind == .needsYou || kind == .working }

    private var allQuiet: some View {
        VStack(spacing: Space.xs) {
            Text("All quiet").font(Typo.label).foregroundStyle(Theme.ink)
            Text("Nothing needs you right now.").font(Typo.body).foregroundStyle(Theme.muted)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, Space.l)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private func sectionView(_ section: SessionSection, now: Date) -> some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            MenuHeading(section.kind.title).padding(.horizontal, Space.l).padding(.bottom, 2)
            Group {
                switch section.kind {
                case .needsYou:
                    ForEach(Array(section.sessions.enumerated()), id: \.element.id) { i, s in
                        if i < 2 { card(s).padding(.horizontal, 4) } else { row(s) }
                    }
                case .idle:
                    // Idle for more than a day is tucked away behind one quiet row.
                    let earlier = section.sessions.filter { SessionGrouping.isEarlier($0, now: now) }
                    ForEach(section.sessions.filter { !earlier.contains($0) }) { row($0) }
                    if !earlier.isEmpty {
                        ShowEarlierRow(count: earlier.count, expanded: showEarlier) { showEarlier.toggle() }
                        if showEarlier { ForEach(earlier) { row($0) } }
                    }
                default:
                    ForEach(section.sessions) { row($0) }
                }
            }
            .padding(.horizontal, 4)
        }
    }

    private func row(_ s: HostSession, snippet: String? = nil) -> some View {
        Button { model.open(s.key) } label: {
            SessionRowView(session: s, isPinned: model.pinned.contains(s.key), subtitleOverride: snippet)
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button(model.pinned.contains(s.key) ? "Unpin" : "Pin to top") { model.togglePin(s.key) }
        }
    }

    private func card(_ s: HostSession) -> some View {
        NeedsYouCard(
            session: s, question: model.askDisplay(for: s.key) == nil ? model.question(for: s.key) : nil, choices: model.choices(for: s.key),
            canReply: model.canSend(s) && model.isConnected,
            onOpen: { model.open(s.key) },
            onChoose: { send($0.letter, to: s.key) },
            onReply: { send($0, to: s.key) },
            notice: notices[s.key],
            ask: model.askDisplay(for: s.key)?.ask, askResult: model.askDisplay(for: s.key)?.outcome,
            onAnswer: { form in await model.answer(form, for: s.key) }
        )
    }

    /// A deliberate tap: the same send path as the window's Send. The card says what happened.
    private func send(_ text: String, to key: SessionKey) {
        notices[key] = "Sending…"
        Task {
            let result = await model.send(text, to: key)
            notices[key] = result.flatMap(SendFeedback.init)?.failureText
        }
    }

    // MARK: Footer

    private var footer: some View {
        VStack(spacing: 0) {
            MenuRow(title: "Quick message…", hint: "⌘K") { QuickComposerController.shared.show() }
                .keyboardShortcut("k")
            MenuRow(title: "New chat…", hint: "⌘N") { NewChatController.shared.show() }
                .keyboardShortcut("n")
            InsetSeparator().padding(.vertical, 4)
            MenuRow(title: "Open Squeak") { model.showConversationWindow() }
            MenuRow(title: "Settings…", hint: "⌘,") { model.openSettings() }
                .keyboardShortcut(",")
            MenuRow(title: "Check for Updates…", disabled: !model.updater.canCheck) { model.updater.checkForUpdates() }
            MenuRow(title: "Quit Squeak", hint: "⌘Q") { NSApp.terminate(nil) }
                .keyboardShortcut("q")
        }
        .padding(.top, 4)
        .padding(.bottom, 6)
    }
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
