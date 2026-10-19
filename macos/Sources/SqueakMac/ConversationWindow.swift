import AppKit
import SqueakIcons
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
        .frame(minWidth: 960, minHeight: 600)
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
            Text("\(model.activeCount) active across your Mac").font(Typo.body).foregroundStyle(Theme.muted)
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
            if let s = model.selectedSession {
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
    @State private var contentHeight: CGFloat = 0

    private var agent: String { SessionRowView.agentName(session.agent) ?? "Agent" }
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
        .task(id: "\(session.key.stringValue)-\(session.state == .working)-\(tab.rawValue)") {
            guard session.state == .working || tab == .activity else { return }
            while !Task.isCancelled {
                await model.refreshActivity()
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    // MARK: Header

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .top) {
                Text(verbatim: SessionText.headline(session))
                    .font(Typo.title).lineLimit(2).accessibilityAddTraits(.isHeader)
                Spacer(minLength: 12)
                if session.capabilities.openInHost.isSupported {
                    Button { model.openInHost() } label: {
                        LucideLabel("Open in Conductor", .externalLink, color: Theme.ink)
                    }
                    .modifier(GlassBorderedButton())
                    .help("Open this chat in Conductor")
                    .disabled(model.openURL == nil && !model.demoMode)
                }
            }
            if let line = repoBranch {
                Text(verbatim: line).font(Typo.heading).foregroundStyle(Theme.muted).lineLimit(1)
            }
            // §8.2: the git line lives here, not in the list row.
            if let git = model.summaryLine(for: session) {
                Text(verbatim: git).font(Typo.meta).monospacedDigit().foregroundStyle(Theme.muted).lineLimit(1)
            }
            Text(verbatim: "\(SessionText.agent(session.agent) ?? "agent") · \(SessionText.stateWord(session)) · \(session.source.title)").font(Typo.meta).foregroundStyle(Theme.muted)
            Picker("View", selection: $tab) {
                ForEach(DetailTab.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented).labelsHidden().frame(width: 230)
            .padding(.top, 12)
            .accessibilityLabel("Chat or activity")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 28).padding(.top, 8).padding(.bottom, 14)
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
        } else if model.messages.isEmpty {
            note(.messageSquareText, "No messages yet", "Messages appear here as the agent and you exchange them.")
                .safeAreaInset(edge: .bottom, spacing: 0) { bottomBar }
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 26) {
                        ForEach(model.messages) { m in
                            MessageView(
                                message: m, agentName: agent, canOpenHost: model.openURL != nil,
                                layout: m.id == needsYouMessageID ? ChoiceLayout.make(m.text) : nil,
                                canAnswer: sendBlock == nil && model.isConnected, onChoose: choose
                            )
                            .id(m.id)
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
                }
                .safeAreaInset(edge: .bottom, spacing: 0) { bottomBar }
                .onChange(of: model.messages.last?.id) { _, _ in
                    if atBottom || model.messages.last?.role == .user { scrollDown(proxy) }
                }
                .onChange(of: model.messages.last?.state) { _, _ in
                    if atBottom { scrollDown(proxy) }
                }
                .onAppear {
                    proxy.scrollTo("bottom", anchor: .bottom)
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { proxy.scrollTo("bottom", anchor: .bottom) }
                }
            }
        }
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
        Task { _ = await model.send(c.letter, to: key) }
    }

    private func scrollDown(_ proxy: ScrollViewProxy) {
        if reduceMotion { proxy.scrollTo("bottom", anchor: .bottom) } else {
            withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("bottom", anchor: .bottom) }
        }
    }

    // MARK: Bottom bar: summary line and the floating composer

    private var bottomBar: some View {
        VStack(alignment: .leading, spacing: 8) {
            summary
            composer
            Text(verbatim: destinationNote).font(Typo.meta).foregroundStyle(Theme.muted).padding(.leading, 4)
        }
        .frame(maxWidth: 820)
        .padding(.horizontal, 28)
        .padding(.top, 10)
        .padding(.bottom, 14)
        .frame(maxWidth: .infinity)
        .background(.bar)
    }

    /// Real data only: the live step of a working session, or what the source reports (nothing today
    /// for live sessions, since the adapters expose no diff or test results).
    @ViewBuilder private var summary: some View {
        if session.state == .working {
            HStack(spacing: 8) {
                StateDot(state: .working).scaleEffect(0.85)
                Text(verbatim: model.activity.last?.text ?? "Working…").font(Typo.body).foregroundStyle(Theme.muted).lineLimit(1)
            }
            .padding(.leading, 4)
            .accessibilityLabel("What it's doing: \(model.activity.last?.text ?? "working")")
        }
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
        return "Replies go to \(session.source.replyDestination)."
    }

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
                isEnabled: editable, focusToken: focusToken, onSend: send,
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
                Button(action: send) {
                    SendLabel()
                        .padding(.horizontal, 6)
                }
                .modifier(SendButtonStyle())
                .keyboardShortcut(.return, modifiers: .command)
                .disabled(!canSend)
                .accessibilityLabel("Send message")
                .help(session.capabilities.attachments.reason.map { "Send (⌘↩). Attachments: \($0)" } ?? "Send (⌘↩)")
            }
        }
        .padding(.leading, 14).padding(.trailing, 10).padding(.top, 8).padding(.bottom, 10)
        .squeakGlass(radius: Radius.card)
        .accessibilityElement(children: .contain)
    }

    private func send() {
        let t = model.draft
        guard canSend, !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let key = session.key
        Task { _ = await model.send(t, to: key) }
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
                        HStack(alignment: .top, spacing: 12) {
                            Lucide(Self.icon(step), size: 16, color: Theme.muted)
                                .frame(width: 28, height: 28)
                                .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.control))
                            Text(verbatim: step.text).font(.body).lineLimit(3).frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.top, 5)
                            if let at = step.at {
                                Text(at.formatted(date: .omitted, time: .standard)).font(Typo.body).monospacedDigit()
                                    .foregroundStyle(Theme.subtle).padding(.top, 5)
                            }
                        }
                        .padding(.vertical, 9)
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

// MARK: - Messages

struct MessageView: View {
    let message: ChatMessage
    var agentName: String
    var canOpenHost: Bool
    var layout: ChoiceLayout?
    var canAnswer = true
    var onChoose: (ChoiceCard) -> Void = { _ in }
    @Environment(AppModel.self) private var model

    var body: some View {
        if message.role == .user { userBody } else { agentBody }
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
            if let status = DeliveryText(state: message.state) { delivery(status) }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    private var agentBody: some View {
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 10) {
                meta(agentName)
                if let layout {
                    if !layout.before.isEmpty { MarkdownView(text: layout.before) }
                    if let q = layout.question {
                        Text(verbatim: q).font(Typo.heading).padding(.top, 8).accessibilityAddTraits(.isHeader)
                    }
                    SqueakGlassGroup(spacing: 10) {
                        VStack(spacing: 10) {
                            ForEach(layout.cards, id: \.letter) { card in
                                AnswerCard(card: card, isEnabled: canAnswer) { onChoose(card) }
                            }
                        }
                    }
                    if !layout.after.isEmpty { MarkdownView(text: layout.after).padding(.top, 6) }
                } else {
                    MarkdownView(text: message.text)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(layout != nil ? "\(agentName) is waiting for your answer" : "")
    }

    private func delivery(_ status: DeliveryText) -> some View {
        HStack(spacing: 6) {
            Lucide(status.symbol, size: 16, color: status.color)
            Text(status.text).font(Typo.meta).foregroundStyle(status.color)
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

struct DeliveryText {
    var text: String
    var symbol: LucideName
    var color: Color
    var offersOpen = false
    var offersReuse = false

    init?(state: MessageState?) {
        switch state {
        case nil, .draft: return nil
        case .pending: self = .init(text: "Sending…", symbol: .ellipsis, color: Theme.subtle)
        case .accepted(let via): self = .init(text: Self.delivered(via), symbol: .check, color: Theme.subtle)
        case .confirmed: self = .init(text: "Sent", symbol: .check, color: Theme.subtle)
        case .uncertain:
            self = .init(text: "Typed it in, but couldn't confirm it was sent. Check Conductor before resending.", symbol: .circleAlert, color: Theme.muted, offersOpen: true)
        case .refused(let r): self = .init(text: "Refused: \(r)", symbol: .circleX, color: Theme.error, offersReuse: true)
        case .notSent(let r): self = .init(text: "Not sent: \(r)", symbol: .circleAlert, color: Theme.error, offersReuse: true)
        }
    }

    private init(text: String, symbol: LucideName, color: Color, offersOpen: Bool = false, offersReuse: Bool = false) {
        self.text = text
        self.symbol = symbol
        self.color = color
        self.offersOpen = offersOpen
        self.offersReuse = offersReuse
    }

    static func delivered(_ via: String) -> String {
        switch via {
        case "conductor": "Sent in Conductor"
        case "terminal": "Sent in Terminal"
        case "background": "Sent in the background. Conductor shows it after it reloads the chat."
        default: "Sent in \(via)"
        }
    }
}

/// "Send" in the primary text colour while it can be pressed, muted while it cannot.
private struct SendLabel: View {
    @Environment(\.isEnabled) private var isEnabled
    var body: some View {
        Text("Send").font(Typo.label).foregroundStyle(isEnabled ? Theme.primaryText : Theme.muted)
    }
}
