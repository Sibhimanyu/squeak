import AppKit
import SqueakIcons
import SqueakMarkup
import SqueakMacCore
import SwiftUI

// The Squeak window: a native three-column NavigationSplitView. A source-list sidebar (filters),
// a session list, and the conversation. The system draws the sidebar material and, on macOS 26,
// the toolbar glass; the floating composer and the answer cards use Liquid Glass behind
// `#available` with material fallbacks (Glass.swift). Nothing here sends by itself: an answer card,
// the Send button and ⌘↩ are deliberate taps.

struct ConversationView: View {
    @Environment(AppModel.self) private var model
    @State private var visibility: NavigationSplitViewVisibility = .all

    var body: some View {
        @Bindable var model = model
        Group {
            if model.settingsSection != nil {
                SettingsShell()
            } else {
                NavigationSplitView(columnVisibility: $visibility) {
                    SidebarView()
                        .navigationSplitViewColumnWidth(min: 200, ideal: 216, max: 280)
                } content: {
                    SessionListView()
                        .navigationSplitViewColumnWidth(min: 280, ideal: 312, max: 460)
                } detail: {
                    DetailView()
                }
                .searchable(text: $model.query, placement: .sidebar, prompt: "Search sessions")
                .modifier(WindowStyling())
            }
        }
        .background(ConversationWindowReader())
        .background {
            // ⌘\ folds the filters column away and back, wherever focus is (search, list, composer).
            Button("Toggle Sidebar") { visibility = visibility == .all ? .doubleColumn : .all }
                .keyboardShortcut("\\", modifiers: .command)
                .opacity(0).accessibilityHidden(true)
        }
        .frame(minWidth: 960, minHeight: 600)
    }
}

/// Tells the model which NSWindow hosts the conversation, so "on screen" means this window and
/// not Settings or any other ordinary window.
private struct ConversationWindowReader: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView { Reader() }
    func updateNSView(_ view: NSView, context: Context) {}

    private final class Reader: NSView {
        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            let w = window
            Task { @MainActor in AppModel.shared.conversationWindow = w }
        }
    }
}

/// ⌘K focuses search (the system gives ⌘F), and the title leaves the toolbar: each column has its own heading.
private struct WindowStyling: ViewModifier {
    func body(content: Content) -> some View {
        if #available(macOS 15, *) {
            content.modifier(SearchFocus()).toolbar(removing: .title)
        } else {
            content
        }
    }
}

@available(macOS 15, *)
private struct SearchFocus: ViewModifier {
    @FocusState private var focused: Bool

    func body(content: Content) -> some View {
        content
            .searchFocused($focused)
            .background {
                Button("Search") { focused = true }
                    .keyboardShortcut("k", modifiers: .command)
                    .opacity(0).accessibilityHidden(true)
            }
    }
}

// MARK: - Sidebar

struct SidebarView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        List(selection: $model.navFilter) {
            Section {
                row(.all, "All sessions", .list)
                row(.needsYou, "Needs you", .bell)
                row(.working, "Working", .play)
                row(.done, "Done", .circleCheck)
            }
            Section {
                LucideLabel("Usage", .gauge).tag(NavFilter.usage)
                    .accessibilityLabel("Usage")
            }
            Section("Sources") {
                source(.conductor, .gitBranch)
                source(.terminal, .terminal)
                source(.claudeDesktop, .monitor)
                if model.hasCodexApp { source(.codexApp, .code) }
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .top, spacing: 0) { brand }
        .safeAreaInset(edge: .bottom, spacing: 0) { footer }
    }

    private func row(_ f: NavFilter, _ title: String, _ symbol: LucideName) -> some View {
        HStack {
            LucideLabel(title, symbol)
            Spacer(minLength: 4)
            count(model.count(f), needsYou: f == .needsYou)
        }
        .tag(f)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(title), \(model.count(f))")
    }

    /// 8.3: a red pill with a white count for things that need you; every other count is plain muted text.
    @ViewBuilder private func count(_ n: Int, needsYou: Bool) -> some View {
        if needsYou && n > 0 {
            Text("\(n)").font(.system(size: 11, weight: .bold)).monospacedDigit().foregroundStyle(.white)
                .padding(.horizontal, 7).frame(minWidth: 20, minHeight: 20)
                .background(Theme.needsYou, in: Capsule())
        } else if n > 0 {
            Text("\(n)").font(Typo.meta).monospacedDigit().foregroundStyle(Theme.muted)
        }
    }

    private func source(_ s: SessionSource, _ symbol: LucideName) -> some View {
        LucideLabel(s.title, symbol).tag(NavFilter.source(s))
    }

    /// No duck here: the sidebar sits on the system's glass, and glass never sits behind the duck (DESIGN.md 5).
    private var brand: some View {
        HStack(spacing: 8) {
            Spacer(minLength: 0)
            Button { QuickComposerController.shared.show() } label: {
                Lucide(.squarePen, size: 20, color: Theme.muted).frame(width: 26, height: 26).contentShape(Rectangle())
            }
            .buttonStyle(.plain).foregroundStyle(Theme.muted)
            .accessibilityLabel("Quick message").help("Quick message")
        }
        .padding(.horizontal, 16).padding(.top, 4).padding(.bottom, 8)
        .accessibilityElement(children: .contain)
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 7) {
                Circle().fill(connectionColor).frame(width: 9, height: 9)
                Text(connectionText).font(Typo.body).foregroundStyle(Theme.muted).lineLimit(1)
            }
            .accessibilityElement(children: .combine)
            Button { model.openSettings() } label: {
                LucideLabel("Settings", .settings).font(Typo.body)
            }
            .buttonStyle(.plain).foregroundStyle(Theme.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16).padding(.vertical, 12)
    }

    private var loaded: Bool { model.hasLoaded || model.health != nil }

    /// Honest: "Service connected" only when it is; the daemon's own words otherwise.
    private var connectionText: String {
        guard loaded else { return "Connecting…" }
        return model.isConnected ? "Connected" : model.connectionTitle
    }

    private var connectionColor: Color {
        guard loaded else { return Theme.idle }
        return model.isConnected ? Theme.working : Theme.offline
    }
}

// MARK: - Session list

struct SessionListView: View {
    @Environment(AppModel.self) private var model
    @State private var showEarlier = false

    var body: some View {
        List(selection: selection) {
            if model.isSearching {
                searchRows
            } else {
                ForEach(model.grouped) { section in
                    sectionView(section)
                }
            }
        }
        .listStyle(.inset)
        .scrollContentBackground(.hidden)
        .safeAreaInset(edge: .top, spacing: 0) { header }
        .overlay { if model.sessions.isEmpty { emptyNote } }
        .task(id: model.hasLoaded) { await model.pollLiveSteps() }
    }

    private var selection: Binding<SessionKey?> {
        Binding(get: { model.selected }, set: { model.select($0) })
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Sessions").font(Typo.title).accessibilityAddTraits(.isHeader)
            Text(model.sessionsSummary).font(Typo.body).foregroundStyle(Theme.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 20).padding(.top, 6).padding(.bottom, 12)
    }

    @ViewBuilder private func sectionView(_ section: SessionSection) -> some View {
        // Idle for more than a day is tucked away behind one quiet row.
        let now = Date()
        let earlier = section.kind == .idle ? section.sessions.filter { SessionGrouping.isEarlier($0, now: now) } : []
        let shown = section.sessions.filter { !earlier.contains($0) }
        Section {
            SectionLabel(section.kind.title, count: shown.count)
                .padding(.top, 6)
                .listRowSeparator(.hidden)
            ForEach(shown) { s in row(s) }
            if !earlier.isEmpty {
                ShowEarlierRow(count: earlier.count, expanded: showEarlier) { showEarlier.toggle() }
                    .listRowSeparator(.hidden)
                if showEarlier { ForEach(earlier) { s in row(s) } }
            }
        }
    }

    private func row(_ s: HostSession, snippet: String? = nil) -> some View {
        SessionListRow(session: s, isPinned: model.pinned.contains(s.key), subtitleOverride: snippet)
            .tag(s.key)
            .listRowSeparator(.visible)
            .contextMenu {
                Button(model.pinned.contains(s.key) ? "Unpin" : "Pin to top") { model.togglePin(s.key) }
            }
    }

    @ViewBuilder private var searchRows: some View {
        let hits = model.searchHits
        if hits.isEmpty {
            Text("No matches. Search covers titles and messages Squeak has already opened on this Mac.")
                .font(Typo.body).foregroundStyle(Theme.muted).padding(.vertical, 12)
        } else {
            ForEach(hits, id: \.key) { hit in
                if let s = model.session(hit.key) { row(s, snippet: hit.titleMatch ? nil : hit.snippet) }
            }
        }
    }

    @ViewBuilder private var emptyNote: some View {
        Text(model.isConnected ? "No chats yet. Start one in Conductor and it shows up here." : "No chats to show yet.")
            .font(Typo.body).foregroundStyle(Theme.muted).multilineTextAlignment(.center).padding(24)
    }
}

/// 8.2: dot, then three lines (SessionRowLines). No icon.
struct SessionListRow: View {
    let session: HostSession
    var isPinned = false
    var subtitleOverride: String?

    var body: some View {
        HStack(alignment: .top, spacing: Space.m) {
            StateDot(state: session.state).frame(height: 19)
            SessionRowLines(session: session, isPinned: isPinned, subtitleOverride: subtitleOverride)
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(SessionText.headline(session)), \(SessionText.secondLine(session)), \(SessionText.stateWord(session))")
    }
}

// MARK: - Detail

struct DetailView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            if model.navFilter == .usage {
                UsageDetailView()
            } else if let s = model.selectedSession {
                SessionDetail(session: s).id(s.key)
            } else if model.selected != nil {
                pick("Squeak no longer lists this chat. It may have been archived in Conductor.")
            } else if !model.isConnected && model.health != nil {
                VStack(spacing: Space.m) {
                    ConnectionNotice().frame(maxWidth: 460)
                    Text("Drafts are saved on this Mac and never sent on their own after reconnecting.")
                        .font(Typo.meta).foregroundStyle(Theme.subtle)
                }
                .padding(Space.xl)
            } else if model.sessions.isEmpty {
                pick("Nothing here yet.")
            } else {
                pick(nil)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func pick(_ note: String?) -> some View {
        VStack(spacing: Space.m) {
            DuckMark(width: 48)
            Text("Pick a chat").font(Typo.heading).foregroundStyle(Theme.muted)
            if let note {
                Text(note).font(Typo.body).foregroundStyle(Theme.subtle).multilineTextAlignment(.center).frame(maxWidth: 320)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// The reason Squeak cannot reach its service, with the fix, in one quiet card.
struct ConnectionNotice: View {
    @Environment(AppModel.self) private var model
    var compact = false

    var body: some View {
        if let help = model.connectionHelp, model.health != nil {
            VStack(alignment: .leading, spacing: Space.xs) {
                HStack(spacing: 6) {
                    Circle().fill(Theme.offline).frame(width: 9, height: 9)
                    Text(model.connectionTitle).font(Typo.label)
                    Spacer()
                    Button("Check again") { model.recheck() }.controlSize(.small)
                }
                Text(help).font(Typo.body).foregroundStyle(Theme.muted)
                    .lineLimit(compact ? 2 : nil).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            }
            .padding(Space.m)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
            .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Theme.line))
        }
    }
}

enum DetailTab: String, CaseIterable, Identifiable {
    case chat = "Chat", activity = "Activity"
    var id: String { rawValue }
}

struct SessionDetail: View {
    let session: HostSession
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var tab: DetailTab = .chat
    @State private var focusToken = 0
    @State private var atBottom = false
    /// Something arrived while you were reading further up: the jump button says "New".
    @State private var newBelow = false
    @State private var contentHeight: CGFloat = 0
    /// True until the newest end of the chat has been on screen once: while it is, every change in the
    /// content's height (lazy rows being measured) puts the view back on the newest message, so a chat opens
    /// on its end, not wherever the estimated heights landed.
    @State private var settling = true
    @State private var stackHeight: CGFloat = 0
    /// The message that was first before an earlier page was asked for: kept in place when the page lands.
    @State private var keepAnchor: String?
    @State private var topVisible = false
    /// The long queue/steer explanation shows until the first message sent mid-turn; a short line after.
    @AppStorage("queueSteerExplained") private var queueSteerExplained = false

    private var agent: String { SessionRowView.agentName(session.agent) ?? "Agent" }
    private var rows: [ChatTimeline.Row] {
        ChatTimeline.rows(messages: model.messages, state: session.state, activity: model.activity)
    }
    private var receipt: (id: String, receipt: ChatTimeline.Receipt)? {
        ChatTimeline.receipt(messages: model.messages, state: session.state)
    }
    private var firstMessageID: String? { model.messages.first?.id }
    private var isWorking: Bool { ChatTimeline.isWorking(messages: model.messages, state: session.state) }
    private var spring: Animation? { reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.86) }

    var body: some View {
        VStack(spacing: 0) {
            header
            if !model.isConnected {
                ConnectionNotice(compact: true).padding(.horizontal, 28).padding(.bottom, Space.s)
            }
            Divider()
            switch tab {
            case .chat: transcript.transition(.opacity)
            case .activity: ActivityList(session: session).transition(.opacity)
            }
        }
        .animation(spring, value: tab)
        .onAppear { focusToken += 1 }
        // The chat's model, stuck state and background work, from the daemon, while the chat is on screen.
        .task(id: session.key.stringValue) {
            model.chatExtras = nil
            model.chatNote = nil
            while !Task.isCancelled {
                await model.refreshChatExtras(session)
                try? await Task.sleep(for: .seconds(3))
            }
        }
        .task(id: "\(session.key.stringValue)-\(isWorking)-\(tab.rawValue)") {
            guard isWorking || tab == .activity else { return }
            while !Task.isCancelled {
                await model.refreshActivity()
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    // MARK: Header

    /// Two lines: the title with the view switch and Open beside it, then one
    /// muted line of who, where and what changed. The transcript is what this
    /// window is for, so the header takes as little of it as it can.
    private var header: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .center, spacing: 12) {
                Text(verbatim: SessionText.headline(session))
                    .font(Typo.heading).lineLimit(1).truncationMode(.tail)
                    .help(SessionText.headline(session))
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 12)
                Picker("View", selection: $tab) {
                    ForEach(DetailTab.allCases) { Text($0.rawValue).tag($0) }
                }
                .pickerStyle(.segmented).labelsHidden().controlSize(.small).fixedSize()
                .accessibilityLabel("Chat or activity")
                if session.conductorSessionId != nil, model.workspaceRepos != nil {
                    ChatActionsMenu(session: session)
                }
                if session.capabilities.openInHost.isSupported {
                    Button { model.openInHost() } label: {
                        Lucide(.externalLink, size: 14, color: Theme.ink)
                    }
                    .modifier(GlassBorderedButton())
                    .help("Open this chat in Conductor")
                    .accessibilityLabel("Open in Conductor")
                    .disabled(model.openURL == nil && !model.demoMode)
                }
            }
            Text(verbatim: metaLine).font(Typo.meta).monospacedDigit().foregroundStyle(Theme.muted)
                .lineLimit(1).truncationMode(.middle)
                .help(metaLine)
            if let extras = model.chatExtras, session.conductorSessionId != nil {
                ChatSetupLine(session: session, extras: extras)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 28).padding(.top, 6).padding(.bottom, 10)
    }

    /// `Claude · working · Conductor · repo · branch · +12 −3` (§8.2: the git line lives here, not in the list row).
    private var metaLine: String {
        [SessionText.agent(session.agent) ?? "agent", SessionText.stateWord(session), session.source.title, repoBranch,
         model.summaryLine(for: session)]
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private var repoBranch: String? {
        let parts = [session.repoName, session.branch].compactMap { $0 }.filter { !$0.isEmpty }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    // MARK: Transcript

    @ViewBuilder
    private var transcript: some View {
        if case .unsupported(let why) = session.capabilities.readTranscript {
            note(.eyeOff, "Can't show this conversation", why)
        } else if rows.count == 1, rows[0] == .empty {
            note(.messageSquareText, "No messages yet", "Send one below to start. Messages appear here as the agent and you exchange them.")
                .safeAreaInset(edge: .bottom, spacing: 0) { bottomBar }
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 26) {
                        EarlierRow(paging: model.paging, onLoad: { requestEarlier() })
                            .onAppear { topVisible = true; if !settling { requestEarlier() } }
                            .onDisappear { topVisible = false }
                        ForEach(rows) { row in
                            switch row {
                            case .message(let m, let muted):
                                MessageView(
                                    message: m, agentName: agent, canOpenHost: model.openURL != nil, agentWorking: session.state == .working,
                                    layout: !muted && m.id == needsYouMessageID && model.askDisplay(for: session.key) == nil ? ChoiceLayout.make(m.text) : nil,
                                    canAnswer: sendBlock == nil && model.isConnected, onChoose: choose, muted: muted,
                                    receipt: receipt?.id == m.id ? receipt?.receipt : nil
                                )
                                .id(m.id)
                            case .working(let label):
                                WorkingRow(agentName: agent, label: label)
                                    .id("working")
                                    .transition(.opacity)
                            case .empty:
                                EmptyView()
                            }
                        }
                        if let display = model.askDisplay(for: session.key) {
                            AskCard(
                                ask: display.ask, canSend: sendBlock == nil && model.isConnected,
                                onSend: { form in await model.answer(form, for: session.key) }, result: display.outcome
                            )
                            .id(display.ask.toolUseId)
                        }
                        Color.clear.frame(height: 1).id("bottom")
                            .onAppear { atBottom = true }
                            .onDisappear { atBottom = false }
                    }
                    .frame(maxWidth: 820, alignment: .leading)
                    .padding(.horizontal, 28)
                    .padding(.top, Space.xl)
                    .padding(.bottom, Space.l)
                    .frame(maxWidth: .infinity)
                    .background(GeometryReader { Color.clear.preference(key: ConversationHeightKey.self, value: $0.size.height) })
                }
                .defaultScrollAnchor(.bottom)
                .onPreferenceChange(ConversationHeightKey.self) { height in
                    stackHeight = height
                    // Rows are measured as they appear: until the end has been reached, stay on it, and after an
                    // earlier page lands, stay on the message that was first.
                    if let anchor = keepAnchor { proxy.scrollTo(anchor, anchor: .top) } else if settling { proxy.scrollTo("bottom", anchor: .bottom) }
                }
                // The jump button floats just above the composer and takes no room, so nothing moves when it shows.
                .safeAreaInset(edge: .bottom, spacing: 0) { bottomBar.overlay(alignment: .top) { jumpButton(proxy) } }
                .animation(reduceMotion ? nil : .easeOut(duration: 0.22), value: rows.map(\.id))
                .onChange(of: rows.last?.id) { _, _ in
                    if atBottom || model.messages.last?.role == .user { scrollDown(proxy) } else { newBelow = true }
                }
                .onChange(of: atBottom) { _, now in
                    if now { newBelow = false; settling = false }
                }
                .onChange(of: model.messages.last?.state) { _, _ in
                    if atBottom { scrollDown(proxy) }
                }
                .onChange(of: firstMessageID) { _, _ in
                    // An earlier page landed in front: put the reader back on the message they were at.
                    if let anchor = keepAnchor { proxy.scrollTo(anchor, anchor: .top) }
                }
                .onChange(of: model.paging.loading) { _, loading in
                    // Still at the top after a page (a short one): the next page is wanted too.
                    if !loading, topVisible, !settling, model.paging.error == nil, keepAnchor == nil { requestEarlier() }
                }
                .task(id: keepAnchor) {
                    // The anchor only has to hold while the new rows are measured.
                    guard keepAnchor != nil else { return }
                    try? await Task.sleep(for: .milliseconds(700))
                    if !Task.isCancelled, !model.paging.loading { keepAnchor = nil }
                }
                .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
            }
        }
    }

    /// Asks for the next older page, remembering where the reader is so the page lands above them.
    private func requestEarlier() {
        guard model.paging.canLoad else { return }
        keepAnchor = model.messages.first?.id
        model.loadEarlier()
    }

    private func note(_ symbol: LucideName, _ title: String, _ message: String) -> some View {
        VStack(spacing: Space.s) {
            Lucide(symbol, size: 28, color: Theme.subtle)
            Text(title).font(Typo.heading)
            Text(message).font(Typo.body).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
        }
        .frame(maxWidth: 340)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// The agent's last message, when it is the last thing in the chat and the chat needs you.
    private var needsYouMessageID: String? {
        guard session.state == .blocked, let last = model.messages.last, last.role == .assistant else { return nil }
        return last.id
    }

    private func choose(_ c: ChoiceCard) {
        guard sendBlock == nil, model.isConnected else { return }
        let key = session.key
        Task { _ = await model.send(c.letter, to: key, answering: true) }
    }

    /// Back to the newest message in one click (or ⌘↓): a round button while the end of the chat is out of view, a
    /// "New" pill when something arrived meanwhile.
    private func jumpButton(_ proxy: ScrollViewProxy) -> some View {
        ZStack {
            if !atBottom, !rows.isEmpty {
                Button {
                    newBelow = false
                    scrollDown(proxy)
                } label: {
                    HStack(spacing: 6) {
                        Lucide(.chevronDown, size: 14, color: Theme.ink)
                        if newBelow { Text("New").font(Typo.meta.weight(.semibold)).foregroundStyle(Theme.ink) }
                    }
                    .padding(.horizontal, newBelow ? 12 : 0)
                    .frame(minWidth: 32, minHeight: 32)
                    .background(Theme.surfaceRaised, in: Capsule())
                    .overlay(Capsule().stroke(Theme.line))
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .help("Jump to the newest message (⌘↓)")
                .accessibilityLabel(newBelow ? "New messages. Jump to the newest" : "Jump to the newest message")
                .keyboardShortcut(.downArrow, modifiers: [.command])
                .transition(.opacity.combined(with: .scale(scale: 0.9)))
            }
        }
        .offset(y: -44)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: atBottom)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: newBelow)
    }

    private func scrollDown(_ proxy: ScrollViewProxy) {
        if reduceMotion { proxy.scrollTo("bottom", anchor: .bottom) } else {
            withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("bottom", anchor: .bottom) }
        }
    }

    // MARK: Bottom bar: summary line and the floating composer

    private var bottomBar: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let extras = model.chatExtras, session.state == .working {
                if let stall = extras.stalled {
                    StuckCard(stall: stall) { Task { await model.stopChat(session) } }
                }
                if !extras.background.isEmpty { BackgroundStrip(extras: extras, crowded: extras.stalled != nil) }
            }
            if let note = model.chatNote {
                Text(verbatim: note).font(Typo.meta).foregroundStyle(Theme.error).padding(.leading, 4)
            }
            composer
            Text(verbatim: destinationNote).font(Typo.meta).foregroundStyle(Theme.muted).padding(.leading, 4)
                .task(id: model.serviceDown(session)) {
                    while model.serviceDown(session), !Task.isCancelled {
                        model.probeService()
                        try? await Task.sleep(for: .seconds(2.5))
                    }
                }
        }
        .frame(maxWidth: 820)
        .padding(.horizontal, 28)
        .padding(.top, 10)
        .padding(.bottom, 14)
        .frame(maxWidth: .infinity)
        .background(.bar)
    }

    // MARK: Composer

    private var sendBlock: String? {
        if case .unsupported(let why) = session.capabilities.send { return why }
        if session.replyTarget == nil { return "Squeak has no way to reply to this chat." }
        return nil
    }

    private var placeholder: String {
        if let why = sendBlock { return "Read-only: \(why)" }
        if !model.isConnected { return "Offline. Your draft is saved and is not sent automatically." }
        return "Reply to \(agent)…"
    }

    private var destinationNote: String {
        if let why = sendBlock { return "Can't reply here: \(why)" }
        if !model.isConnected { return "Not connected. Replies wait until Squeak's service is back." }
        if model.serviceDown(session) { return "Reconnecting to Squeak's service… Send tries again." }
        if working {
            return queueSteerExplained
                ? "Queues after this turn · ⇧⌘↩ steers now"
                : "Queue holds it until \(agent) finishes this turn. Hold Queue, or press ⇧⌘↩, to steer it in now."
        }
        return "Replies go to \(session.source.replyDestination)."
    }

    /// While the agent is mid-turn a message is either queued behind the turn or steered into it.
    private var working: Bool { session.state == .working }

    private var hasText: Bool { !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var canSend: Bool { sendBlock == nil && model.isConnected && hasText }

    private var composer: some View {
        let text = Binding(get: { model.draft }, set: { model.setDraft($0) })
        let editable = sendBlock == nil && model.isConnected
        let minH: CGFloat = 44
        let maxH: CGFloat = 17 * 7 + 12
        return VStack(alignment: .leading, spacing: 6) {
            ComposerField(
                text: text, sendKey: .commandReturnSends, placeholder: placeholder,
                isEnabled: editable, focusToken: focusToken, onSend: { send(.queue) },
                onContentHeight: { contentHeight = $0 }
            )
            .frame(height: min(max(contentHeight, minH), maxH))
            HStack(spacing: 8) {
                Spacer(minLength: 0)
                if editable {
                    Text("⌘ ↩").font(Typo.meta).foregroundStyle(Theme.muted)
                        .padding(.horizontal, 7).frame(height: 22)
                        .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Theme.lineStrong))
                        .accessibilityHidden(true)
                }
                if working {
                    // Click queues; the arrow or a click-and-hold offers Steer now.
                    Menu {
                        Button("Steer now: into the turn in progress") { send(.steer) }
                        Button("Queue: after this turn") { send(.queue) }
                    } label: {
                        HStack(spacing: 5) {
                            SendLabel(title: "Queue")
                            Lucide(.chevronDown, size: 12, color: canSend ? Theme.ink : Theme.muted)
                        }
                        .padding(.horizontal, 6)
                    } primaryAction: {
                        send(.queue)
                    }
                    .menuStyle(.button)
                    .menuIndicator(.hidden)
                    .modifier(SendButtonStyle())
                    .fixedSize()
                    .disabled(!canSend)
                    .accessibilityLabel("Queue message")
                    .accessibilityHint("Holds it until \(agent) finishes this turn. Steer now is in its menu, or press Shift-Command-Return.")
                    .help("Queue: \(agent) reads it after this turn (⌘↩). Steer now: hold, or ⇧⌘↩")
                    // The shortcuts work without opening the menu.
                    shortcut(.queue, [.command])
                    shortcut(.steer, [.command, .shift])
                } else {
                    Button { send(.queue) } label: {
                        SendLabel(title: "Send").padding(.horizontal, 6)
                    }
                    .modifier(SendButtonStyle())
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(!canSend)
                    .accessibilityLabel("Send message")
                    .help(session.capabilities.attachments.reason.map { "Send (⌘↩). Attachments: \($0)" } ?? "Send (⌘↩)")
                }
            }
        }
        .padding(.leading, 14).padding(.trailing, 10).padding(.top, 8).padding(.bottom, 10)
        .squeakGlass(radius: Radius.card)
        .accessibilityElement(children: .contain)
    }

    private func shortcut(_ mode: SendMode, _ modifiers: EventModifiers) -> some View {
        Button("") { send(mode) }
            .keyboardShortcut(.return, modifiers: modifiers)
            .disabled(!canSend)
            .frame(width: 0, height: 0).opacity(0).accessibilityHidden(true)
    }

    private func send(_ mode: SendMode) {
        let t = model.draft
        guard canSend, !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let key = session.key
        // The mode only means something mid-turn; an idle chat is simply sent.
        let effective: SendMode = working ? mode : .queue
        if working { queueSteerExplained = true }
        // The field clears as it sends and keeps focus, so the next message can be typed at once.
        focusToken += 1
        Task { _ = await model.send(t, to: key, mode: effective) }
    }
}

// MARK: - Activity tab

struct ActivityList: View {
    let session: HostSession
    @Environment(AppModel.self) private var model

    var body: some View {
        if model.activity.isEmpty {
            VStack(spacing: Space.s) {
                Lucide(.clipboardList, size: 28, color: Theme.subtle)
                Text("No activity to show").font(Typo.heading)
                Text(session.state == .working ? "Steps appear here as the agent works." : "Steps appear here while the agent works on a turn.")
                    .font(Typo.body).foregroundStyle(Theme.muted)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(model.activity.enumerated()), id: \.offset) { i, step in
                        ActivityStepRow(step: step)
                        if i < model.activity.count - 1 { Divider().padding(.leading, 40) }
                    }
                }
                .frame(maxWidth: 820).padding(.horizontal, 28).padding(.vertical, 16)
                .frame(maxWidth: .infinity)
            }
        }
    }

    static func icon(_ step: ActivityStep) -> LucideName {
        switch step.kind {
        case "thinking": return .brain
        case "note", "text": return .alignLeft
        case "background": return .history
        default:
            let l = step.text.lowercased()
            if l.hasPrefix("read") { return .fileText }
            if l.hasPrefix("edit") || l.hasPrefix("write") { return .filePen }
            if l.hasPrefix("run") { return .terminal }
            if l.hasPrefix("search") || l.hasPrefix("find") { return .search }
            return .wrench
        }
    }
}

/// One step of an agent's turn: its icon, text and time. The Activity tab and a subagent's feed draw the same row.
struct ActivityStepRow: View {
    let step: ActivityStep
    var compact = false

    var body: some View {
        HStack(alignment: .top, spacing: compact ? 8 : 12) {
            Lucide(ActivityList.icon(step), size: compact ? 12 : 16, color: Theme.muted)
                .frame(width: compact ? 22 : 28, height: compact ? 22 : 28)
                .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.control))
            Text(verbatim: step.text).font(compact ? Typo.body : .body).lineLimit(3).frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, compact ? 2 : 5)
            if let at = step.at {
                Text(at.formatted(date: .omitted, time: .standard)).font(Typo.body).monospacedDigit()
                    .foregroundStyle(Theme.subtle).padding(.top, compact ? 2 : 5)
            }
        }
        .padding(.vertical, compact ? 6 : 9)
    }
}

// MARK: - Messages

struct MessageView: View {
    let message: ChatMessage
    var agentName: String
    var canOpenHost: Bool
    /// Whether the agent is still mid-turn, which decides if a queued message still reads "Queued".
    var agentWorking = true
    var layout: ChoiceLayout?
    var canAnswer = true
    var onChoose: (ChoiceCard) -> Void = { _ in }
    /// The previous turn's agent message while a new one is being worked on.
    var muted = false
    /// What the transcript says about your latest message ("Read by Claude", "Turn ended").
    var receipt: ChatTimeline.Receipt?
    @Environment(AppModel.self) private var model

    var body: some View {
        if message.role == .user { userBody } else { agentBody.opacity(muted ? 0.62 : 1) }
    }

    private func meta(_ name: String) -> some View {
        HStack(spacing: 6) {
            Text(name).font(Typo.label).foregroundStyle(Theme.ink)
            if let at = message.at {
                Text("·").foregroundStyle(Theme.subtle)
                Text(at.formatted(date: .omitted, time: .shortened)).font(Typo.body).foregroundStyle(Theme.muted)
            }
        }
    }

    private var userBody: some View {
        VStack(alignment: .trailing, spacing: 6) {
            meta("You")
            Text(verbatim: message.text)
                .font(.system(size: 14)).lineSpacing(3)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 14).padding(.vertical, 11)
                .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(Theme.line))
            if let status = DeliveryText(message: message, agent: agentName, agentWorking: agentWorking, receipt: receipt) { delivery(status) }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    private var agentBody: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 10) {
                meta(agentName)
                if let layout {
                    if !layout.before.isEmpty { MessageText(markdown: layout.before, style: .squeak) }
                    if let q = layout.question {
                        MessageInlineText(markdown: q, style: .squeak, size: 15, weight: .semibold).padding(.top, 8).accessibilityAddTraits(.isHeader)
                    }
                    SqueakGlassGroup(spacing: 10) {
                        VStack(spacing: 10) {
                            ForEach(layout.cards, id: \.letter) { card in
                                AnswerCard(card: card, isEnabled: canAnswer) { onChoose(card) }
                            }
                        }
                    }
                    if !layout.after.isEmpty { MessageText(markdown: layout.after, style: .squeak).padding(.top, 6) }
                } else {
                    MessageText(markdown: message.text, style: .squeak)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(layout != nil ? "\(agentName) is waiting for your answer" : "")
    }

    private func delivery(_ status: DeliveryText) -> some View {
        HStack(spacing: 6) {
            Text(status.text).font(Typo.meta).foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
            if status.offersOpen, canOpenHost {
                Button("Open in Conductor") { model.openInHost() }.buttonStyle(.plain)
                    .font(Typo.meta.weight(.medium))
            }
            if status.offersReuse {
                Button("Edit as new message") { model.reuse(message) }.buttonStyle(.plain)
                    .font(Typo.meta.weight(.medium))
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// 8.4 option row: letter in a `radius-chip` square, title in `label`, the detail beneath, and the
/// word "recommended" in `muted` when the agent marked one (never coloured, never pre-selected).
/// Tapping sends just the letter. The row sits on Liquid Glass (Glass.swift); no state colour on it.
struct AnswerCard: View {
    let card: ChoiceCard
    var isEnabled = true
    var action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 12) {
                Text(card.letter)
                    .font(Typo.label)
                    .foregroundStyle(Theme.muted)
                    .frame(width: 26, height: 26)
                    .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.chip))
                    .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Theme.line))
                VStack(alignment: .leading, spacing: 3) {
                    Text(verbatim: card.title).font(Typo.label).foregroundStyle(Theme.ink)
                    if let d = card.detail {
                        Text(verbatim: d).font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 12)
                if card.isRecommended {
                    Text("recommended").font(Typo.meta).foregroundStyle(Theme.muted)
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 12)
            .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
            .contentShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        }
        .buttonStyle(CardPressStyle(hovering: hovering))
        .disabled(!isEnabled)
        .opacity(isEnabled ? 1 : 0.5)
        .onHover { hovering = $0 }
        .accessibilityLabel("Answer \(card.letter): \(card.title)\(card.isRecommended ? ", recommended" : "")")
        .accessibilityHint(card.detail ?? "")
    }
}

private struct CardPressStyle: ButtonStyle {
    var hovering: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .squeakGlass(radius: Radius.card, interactive: true)
            .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(hovering ? Theme.lineStrong : Theme.line))
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.985 : 1)
            .animation(reduceMotion ? nil : .spring(response: 0.25, dampingFraction: 0.8), value: configuration.isPressed)
    }
}

/// The one muted line under a sent message ("Sending…", "Sent", "Queued · …", "Steered into the current turn", "Not confirmed", "Not sent: reason"),
/// with the one action that fits a failure.
struct DeliveryText {
    var text: String
    var offersOpen = false
    var offersReuse = false

    init?(message: ChatMessage, agent: String, agentWorking: Bool, receipt: ChatTimeline.Receipt? = nil) {
        guard let state = message.state else { return nil }
        // In the transcript: the receipt says it (only the newest one of yours has it); nothing otherwise.
        if state == .confirmed {
            guard let receipt else { return nil }
            text = receipt.line(agent: agent)
            return
        }
        guard let line = message.deliveryLine(agent: agent, agentWorking: agentWorking) else { return nil }
        text = line
        switch state {
        case .uncertain: offersOpen = true
        case .refused, .notSent: offersReuse = true
        default: break
        }
    }
}

/// "Send" in the primary text colour while it can be pressed, muted while it cannot.
private struct SendLabel: View {
    var title = "Send"
    @Environment(\.isEnabled) private var isEnabled
    var body: some View {
        Text(title).font(Typo.label).foregroundStyle(isEnabled ? Theme.primaryText : Theme.muted)
    }
}


private struct ConversationHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

/// The top of the conversation: "Load earlier messages" while there are some (it loads by itself when
/// scrolled to), a spinner while a page is read, a retry when it failed, "Start of chat" at the end.
struct EarlierRow: View {
    let paging: EarlierPaging
    var onLoad: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            if paging.loading {
                ProgressView().controlSize(.small)
                Text("Loading earlier messages…").font(Typo.meta).foregroundStyle(Theme.muted)
            } else if let error = paging.error {
                Text(verbatim: error).font(Typo.meta).foregroundStyle(Theme.error)
                Button("Try again", action: onLoad).buttonStyle(.plain).font(Typo.meta.weight(.medium))
            } else if paging.reachedStart {
                Text("Start of chat").font(Typo.meta).foregroundStyle(Theme.subtle)
            } else {
                Button("Load earlier messages", action: onLoad).buttonStyle(.plain)
                    .font(Typo.meta.weight(.medium)).foregroundStyle(Theme.muted)
            }
        }
        .frame(maxWidth: .infinity)
        .frame(minHeight: 20)
        .accessibilityElement(children: .combine)
    }
}

/// The agent at work, directly under what you sent: its name, a pulsing dot (still under Reduce
/// Motion) and the live step ("Running tests…", "Starting…" before the first).
struct WorkingRow: View {
    let agentName: String
    let label: String

    var body: some View {
        HStack(spacing: 8) {
            StateDot(state: .working)
            Text(agentName).font(Typo.label).foregroundStyle(Theme.ink)
            Text("·").foregroundStyle(Theme.subtle)
            Text(verbatim: label).font(Typo.body).foregroundStyle(Theme.muted).lineLimit(1)
                .contentTransition(.opacity)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(agentName) is working: \(label)")
    }
}
