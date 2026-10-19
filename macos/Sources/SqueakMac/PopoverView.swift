import SqueakMacCore
import SwiftUI

/// The menu-bar popover (brief: 360 wide, content-height up to 560). List first: whitespace and type
/// do the work. Choice taps and inline replies go through `AppModel.send`, a deliberate user tap.
struct PopoverView: View {
    @Environment(AppModel.self) private var model
    @State private var showEarlier = false
    @State private var notices: [SessionKey: String] = [:]
    @State private var contentHeight: CGFloat = 0

    static let width: CGFloat = 360
    static let maxHeight: CGFloat = 560

    var body: some View {
        @Bindable var model = model
        VStack(spacing: 0) {
            header
            SearchField(text: $model.query)
                .padding(.horizontal, 20)
                .padding(.bottom, Space.m)
            banners
            Hairline()
            content
            Hairline()
            footer
        }
        .frame(width: Self.width)
        .background(Theme.bg)
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
        .padding(.horizontal, 20)
        .padding(.top, Space.l)
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
            .padding(.horizontal, 20)
            .padding(.bottom, Space.m)
        }
    }

    // MARK: Content

    @ViewBuilder private var content: some View {
        if model.sessions.isEmpty {
            VStack {
                if model.health == nil {
                    EmptyStateView(symbol: "ellipsis.circle", title: "Connecting…", message: "Looking for the Squeak service on this Mac.")
                } else if !model.isConnected {
                    EmptyStateView(symbol: "bolt.slash", title: "No sessions to show", message: "Squeak can't reach its service yet, so there is nothing to list.")
                } else {
                    EmptyStateView(symbol: "tray", title: "No sessions yet", message: "Start a chat in Conductor and it shows up here, with its replies.")
                }
            }
            .frame(maxWidth: .infinity)
            .frame(height: 220)
        } else {
            ScrollView {
                list
                    .padding(.horizontal, Space.s)
                    .padding(.vertical, Space.s)
                    .background(
                        GeometryReader { Color.clear.preference(key: PopoverHeightKey.self, value: $0.size.height) }
                    )
            }
            .onPreferenceChange(PopoverHeightKey.self) { contentHeight = $0 }
            .frame(height: min(max(contentHeight, 120), Self.maxHeight - 132))
            .scrollIndicators(.automatic)
        }
    }

    @ViewBuilder private var list: some View {
        if model.isSearching {
            let hits = model.searchHits
            if hits.isEmpty {
                EmptyStateView(symbol: "magnifyingglass", title: "No matches", message: "Search looks at titles and messages Squeak has already opened on this Mac.")
                    .frame(maxWidth: .infinity)
            } else {
                VStack(spacing: 0) {
                    ForEach(hits, id: \.key) { hit in
                        if let s = model.session(hit.key) { row(s, snippet: hit.titleMatch ? nil : hit.snippet) }
                    }
                }
            }
        } else {
            let sections = model.grouped
            let quiet = !sections.contains { $0.kind == .needsYou || $0.kind == .working }
            VStack(alignment: .leading, spacing: 0) {
                if quiet { allQuiet }
                ForEach(Array(sections.enumerated()), id: \.element.id) { i, section in
                    if i > 0 { Hairline().padding(.vertical, Space.s).padding(.horizontal, Space.m) }
                    sectionView(section)
                }
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

    @ViewBuilder private func sectionView(_ section: SessionSection) -> some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            SectionLabel(section.kind.title).padding(.horizontal, Space.m).padding(.bottom, 2)
            switch section.kind {
            case .needsYou:
                ForEach(Array(section.sessions.enumerated()), id: \.element.id) { i, s in
                    if i < 2 { card(s) } else { row(s) }
                }
            case .earlier:
                ShowEarlierRow(count: section.sessions.count, expanded: showEarlier) { showEarlier.toggle() }
                if showEarlier { ForEach(section.sessions) { row($0) } }
            default:
                ForEach(section.sessions) { row($0) }
            }
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
            session: s, question: model.question(for: s.key), choices: model.choices(for: s.key),
            canReply: model.canSend(s) && model.isConnected,
            onOpen: { model.open(s.key) },
            onChoose: { send($0.letter, to: s.key) },
            onReply: { send($0, to: s.key) },
            notice: notices[s.key]
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
        HStack(spacing: Space.m) {
            Button { QuickComposerController.shared.show() } label: {
                HStack(spacing: 6) {
                    Text("Quick message").foregroundStyle(Theme.muted)
                    Text("⌘K").foregroundStyle(Theme.subtle)
                }
                .font(.system(size: 12))
            }
            .buttonStyle(.plain)
            .keyboardShortcut("k")
            Spacer()
            Button("Open Squeak") { model.showConversationWindow() }
                .buttonStyle(.plain)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Theme.ink)
            Menu {
                Button("Settings…") { model.openSettings() }.keyboardShortcut(",")
                Button("Check for updates…") { model.updater.checkForUpdates() }.disabled(!model.updater.canCheck)
                Divider()
                Button("Quit Squeak") { NSApp.terminate(nil) }.keyboardShortcut("q")
            } label: {
                Image(systemName: "gearshape").font(.system(size: 13)).foregroundStyle(Theme.muted)
            }
            .menuStyle(.borderlessButton)
            .menuIndicator(.hidden)
            .fixedSize()
            .accessibilityLabel("Settings and quit")
            .help("Settings")
        }
        .padding(.horizontal, 20)
        .padding(.vertical, Space.m)
    }
}

private struct PopoverHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = max(value, nextValue()) }
}
