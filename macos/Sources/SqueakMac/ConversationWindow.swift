import AppKit
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
                row(.all, "All sessions", "doc.text")
                row(.needsYou, "Needs you", "bell")
                row(.working, "Working", "play")
                row(.recent, "Recent", "clock")
            }
            Section("Sources") {
                source(.conductor, "arrow.triangle.branch")
                source(.terminal, "terminal")
                source(.claudeDesktop, "macwindow")
                if model.hasCodexApp { source(.codexApp, "chevron.left.forwardslash.chevron.right") }
            }
        }
        .listStyle(.sidebar)
        .safeAreaInset(edge: .top, spacing: 0) { brand }
        .safeAreaInset(edge: .bottom, spacing: 0) { footer }
    }

    private func row(_ f: NavFilter, _ title: String, _ symbol: String) -> some View {
        Label(title, systemImage: symbol)
            .badge(model.count(f))
            .tag(f)
            .accessibilityLabel("\(title), \(model.count(f))")
    }

    private func source(_ s: SessionSource, _ symbol: String) -> some View {
        Label(s.title, systemImage: symbol).tag(NavFilter.source(s))
    }

    private var brand: some View {
        HStack(spacing: 8) {
            DuckGlyph(size: 26)
            Text("Squeak").font(.title2.weight(.semibold))
            Spacer(minLength: 0)
            Button { QuickComposerController.shared.show() } label: {
                Image(systemName: "square.and.pencil").frame(width: 26, height: 26).contentShape(Rectangle())
            }
            .buttonStyle(.plain).foregroundStyle(.secondary)
            .accessibilityLabel("Quick message").help("Quick message")
        }
        .padding(.horizontal, 16).padding(.top, 4).padding(.bottom, 8)
        .accessibilityElement(children: .contain)
    }

    private var footer: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 7) {
                Circle().fill(connectionColor).frame(width: 7, height: 7)
                Text(connectionText).font(.callout).foregroundStyle(.secondary).lineLimit(1)
            }
            .accessibilityElement(children: .combine)
            Button { model.openSettings() } label: {
                Label("Settings", systemImage: "gearshape").font(.callout)
            }
            .buttonStyle(.plain).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16).padding(.vertical, 12)
    }

    private var loaded: Bool { model.hasLoaded || model.health != nil }

    /// Honest: "Service connected" only when it is; the daemon's own words otherwise.
    private var connectionText: String {
        guard loaded else { return "Connecting…" }
        return model.isConnected ? "Service connected" : model.connectionTitle
    }

    private var connectionColor: Color {
        guard loaded else { return Color.secondary.opacity(0.6) }
        return model.isConnected ? Theme.working : Theme.attentionDot
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
        .task(id: model.hasLoaded) {
            while !Task.isCancelled {
                await model.refreshLiveSteps()
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }

    private var selection: Binding<SessionKey?> {
        Binding(get: { model.selected }, set: { model.select($0) })
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Sessions").font(.largeTitle.weight(.bold)).accessibilityAddTraits(.isHeader)
            Text("\(model.activeCount) active across your Mac").font(.callout).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 20).padding(.top, 6).padding(.bottom, 12)
    }

    @ViewBuilder private func sectionView(_ section: SessionSection) -> some View {
        let earlier = section.kind == .earlier
        Section {
            SectionLabel(section.kind.title, count: earlier ? nil : section.sessions.count)
                .padding(.top, 6)
                .listRowSeparator(.hidden)
            if earlier {
                ShowEarlierRow(count: section.sessions.count, expanded: showEarlier) { showEarlier.toggle() }
                    .listRowSeparator(.hidden)
            }
            if !earlier || showEarlier {
                ForEach(section.sessions) { s in row(s) }
            }
        }
    }

    private func row(_ s: HostSession, snippet: String? = nil) -> some View {
        SessionListRow(session: s, live: model.liveStep(s.key), isPinned: model.pinned.contains(s.key), subtitleOverride: snippet)
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
                .font(.callout).foregroundStyle(.secondary).padding(.vertical, 12)
        } else {
            ForEach(hits, id: \.key) { hit in
                if let s = model.session(hit.key) { row(s, snippet: hit.titleMatch ? nil : hit.snippet) }
            }
        }
    }

    @ViewBuilder private var emptyNote: some View {
        Text(model.isConnected ? "No chats yet. Start one in Conductor and it shows up here." : "No chats to show yet.")
            .font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center).padding(24)
    }
}

/// title + time, "repo · Agent", then one status line with a small dot.
struct SessionListRow: View {
    let session: HostSession
    var live: String?
    var isPinned = false
    var subtitleOverride: String?

    var body: some View {
        let status = StatusLine.make(session, live: live)
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(verbatim: session.label).font(.body.weight(.semibold)).lineLimit(1)
                if isPinned {
                    Image(systemName: "pin.fill").font(.system(size: 8)).foregroundStyle(.tertiary).accessibilityLabel("Pinned")
                }
                Spacer(minLength: 6)
                RelativeTimeText(session.lastActivityAt, size: 12)
            }
            Text(verbatim: subtitleOverride ?? [session.repoName, SessionRowView.agentName(session.agent)].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · "))
                .font(.callout).foregroundStyle(.secondary).lineLimit(1)
            HStack(spacing: 6) {
                Circle().fill(status.color).frame(width: 7, height: 7)
                Text(status.text).font(.callout).foregroundStyle(status.textColor).lineLimit(1)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(session.label), \(status.text)")
    }
}

/// The row's last line, derived from the session's own state; never invented.
struct StatusLine {
    var text: String
    var color: Color
    var textColor: Color

    static func make(_ s: HostSession, live: String?) -> StatusLine {
        switch s.state {
        case .blocked:
            return StatusLine(text: s.awaitingApproval == true ? "Approval needed" : "Waiting for your answer", color: Theme.attentionDot, textColor: Theme.attention)
        case .working:
            let phrase = live ?? "Working"
            let execs = phrase.hasPrefix("Running") || phrase.hasPrefix("Building") || phrase.hasPrefix("Linting")
            return StatusLine(text: phrase, color: execs ? Theme.working : Color.blue, textColor: .secondary)
        case .finished: return StatusLine(text: "Completed", color: Color.secondary.opacity(0.7), textColor: .secondary)
        case .idle: return StatusLine(text: "Idle", color: Color.secondary.opacity(0.7), textColor: .secondary)
        case .error: return StatusLine(text: "Stopped with an error", color: Theme.error, textColor: .secondary)
        case .unknown: return StatusLine(text: "Unknown", color: Color.secondary.opacity(0.5), textColor: .secondary)
        }
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
                        .font(.caption).foregroundStyle(.tertiary)
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
            DuckGlyph(size: 48).opacity(0.9)
            Text("Pick a chat").font(.title3).foregroundStyle(.secondary)
            if let note {
                Text(note).font(.callout).foregroundStyle(.tertiary).multilineTextAlignment(.center).frame(maxWidth: 320)
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
                    Circle().fill(Theme.attentionDot).frame(width: 7, height: 7)
                    Text(model.connectionTitle).font(.callout.weight(.semibold))
                    Spacer()
                    Button("Check again") { model.recheck() }.controlSize(.small)
                }
                Text(help).font(.callout).foregroundStyle(.secondary)
                    .lineLimit(compact ? 2 : nil).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            }
            .padding(Space.m)
            .background(.quaternary.opacity(0.6), in: RoundedRectangle(cornerRadius: Radius.card))
        }
    }
}

enum DetailTab: String, CaseIterable, Identifiable {
    case conversation = "Conversation", activity = "Activity"
    var id: String { rawValue }
}

struct SessionDetail: View {
    let session: HostSession
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var tab: DetailTab = .conversation
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
            case .conversation: transcript.transition(.opacity)
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
                Text(verbatim: session.label)
                    .font(.largeTitle.weight(.bold)).lineLimit(2).accessibilityAddTraits(.isHeader)
                Spacer(minLength: 12)
                if session.capabilities.openInHost.isSupported {
                    Button { model.openInHost() } label: {
                        Label("Open in Conductor", systemImage: "arrow.up.forward.square")
                    }
                    .modifier(GlassBorderedButton())
                    .controlSize(.large)
                    .help("Open this chat in Conductor")
                    .disabled(model.openURL == nil && !model.demoMode)
                }
            }
            if let line = repoBranch {
                Text(verbatim: line).font(.title3).foregroundStyle(.secondary).lineLimit(1)
            }
            Text(verbatim: "\(agent) · \(session.source.title)").font(.callout).foregroundStyle(.secondary)
            Picker("View", selection: $tab) {
                ForEach(DetailTab.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented).labelsHidden().frame(width: 230)
            .padding(.top, 12)
            .accessibilityLabel("Conversation or activity")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 28).padding(.top, 8).padding(.bottom, 14)
    }

    private var repoBranch: String? {
        let parts = [session.repoName, session.branch].compactMap { $0 }.filter { !$0.isEmpty }
        return parts.isEmpty ? nil : parts.joined(separator: " / ")
    }

    // MARK: Transcript

    @ViewBuilder
    private var transcript: some View {
        if case .unsupported(let why) = session.capabilities.readTranscript {
            note("eye.slash", "Can't show this conversation", why)
        } else if model.messages.isEmpty {
            note("text.bubble", "No messages yet", "Messages appear here as the agent and you exchange them.")
                .safeAreaInset(edge: .bottom, spacing: 0) { bottomBar }
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 26) {
                        ForEach(model.messages) { m in
                            MessageView(
                                message: m, agentName: agent, glyph: AgentGlyph(agent: session.agent), canOpenHost: model.openURL != nil,
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

    private func note(_ symbol: String, _ title: String, _ message: String) -> some View {
        VStack(spacing: Space.s) {
            Image(systemName: symbol).font(.system(size: 26)).foregroundStyle(.tertiary)
            Text(title).font(.headline)
            Text(message).font(.callout).foregroundStyle(.secondary).multilineTextAlignment(.center)
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
            Text(verbatim: destinationNote).font(.caption).foregroundStyle(.secondary).padding(.leading, 4)
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
                Text(verbatim: model.activity.last?.text ?? "Working…").font(.callout).foregroundStyle(.secondary).lineLimit(1)
            }
            .padding(.leading, 4)
            .accessibilityLabel("What it's doing: \(model.activity.last?.text ?? "working")")
        } else if let line = model.summaryLine(for: session) {
            HStack(spacing: 8) {
                Image(systemName: "doc.text").foregroundStyle(.secondary)
                Text(verbatim: line).font(.callout).foregroundStyle(.secondary)
            }
            .padding(.leading, 4)
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
                    Text("⌘ ↩").font(.caption).foregroundStyle(.secondary)
                        .padding(.horizontal, 7).frame(height: 22)
                        .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Color(nsColor: .separatorColor)))
                        .accessibilityHidden(true)
                }
                Button(action: send) {
                    Text("Send").font(.body.weight(.semibold)).foregroundStyle(Color(nsColor: NSColor(hex: 0x18181B)))
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
        .squeakGlass(radius: 20)
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
                Image(systemName: "list.bullet.clipboard").font(.system(size: 26)).foregroundStyle(.tertiary)
                Text("No activity to show").font(.headline)
                Text(session.state == .working ? "Steps appear here as the agent works." : "Steps appear here while the agent works on a turn.")
                    .font(.callout).foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(model.activity.enumerated()), id: \.offset) { i, step in
                        HStack(alignment: .top, spacing: 12) {
                            Image(systemName: Self.icon(step))
                                .font(.system(size: 12)).foregroundStyle(.secondary)
                                .frame(width: 28, height: 28)
                                .background(.quaternary.opacity(0.6), in: RoundedRectangle(cornerRadius: 8))
                            Text(verbatim: step.text).font(.body).lineLimit(3).frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.top, 5)
                            if let at = step.at {
                                Text(at.formatted(date: .omitted, time: .standard)).font(.callout).monospacedDigit()
                                    .foregroundStyle(.tertiary).padding(.top, 5)
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

    static func icon(_ step: ActivityStep) -> String {
        switch step.kind {
        case "thinking": return "brain"
        case "note", "text": return "text.alignleft"
        case "background": return "clock.arrow.circlepath"
        default:
            let l = step.text.lowercased()
            if l.hasPrefix("read") { return "doc.text" }
            if l.hasPrefix("edit") || l.hasPrefix("write") { return "pencil" }
            if l.hasPrefix("run") { return "terminal" }
            if l.hasPrefix("search") || l.hasPrefix("find") { return "magnifyingglass" }
            return "wrench.and.screwdriver"
        }
    }
}

// MARK: - Messages

/// A round avatar glyph per agent: SF Symbols, not logos.
struct AgentGlyph {
    var symbol: String
    var color: Color

    init(agent: String?) {
        switch agent?.lowercased() {
        case "claude": symbol = "asterisk"; color = Color(nsColor: NSColor(hex: 0xE5532D))
        case "codex": symbol = "chevron.left.forwardslash.chevron.right"; color = Color.indigo
        default: symbol = "bubble.left"; color = Color.secondary
        }
    }
}

struct MessageView: View {
    let message: ChatMessage
    var agentName: String
    var glyph: AgentGlyph
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
            Text(name).font(.callout.weight(.semibold)).foregroundStyle(.primary.opacity(0.8))
            if let at = message.at {
                Text("·").foregroundStyle(.tertiary)
                Text(at.formatted(date: .omitted, time: .shortened)).font(.callout).foregroundStyle(.secondary)
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
                .background(.quaternary.opacity(0.7), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
            if let status = DeliveryText(state: message.state) { delivery(status) }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    private var agentBody: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: glyph.symbol)
                .font(.system(size: 15, weight: .semibold)).foregroundStyle(glyph.color)
                .frame(width: 34, height: 34)
                .background(glyph.color.opacity(0.12), in: Circle())
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 10) {
                meta(agentName)
                if let layout {
                    if !layout.before.isEmpty { MarkdownView(text: layout.before) }
                    if let q = layout.question {
                        Text(verbatim: q).font(.system(size: 15, weight: .semibold)).padding(.top, 8).accessibilityAddTraits(.isHeader)
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
            Image(systemName: status.symbol).font(.system(size: 10, weight: .medium)).foregroundStyle(status.color)
            Text(status.text).font(.caption).foregroundStyle(status.color)
                .fixedSize(horizontal: false, vertical: true)
            if status.offersOpen, canOpenHost {
                Button("Open in Conductor") { model.openInHost() }.buttonStyle(.plain)
                    .font(.caption.weight(.medium))
            }
            if status.offersReuse {
                Button("Edit as new message") { model.reuse(message) }.buttonStyle(.plain)
                    .font(.caption.weight(.medium))
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// A big, deliberate answer: letter, title, description, and a Recommended badge. Tapping sends just
/// the letter. A spring press (interruptible) and a hover tint; glass on macOS 26.
struct AnswerCard: View {
    let card: ChoiceCard
    var isEnabled = true
    var action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 16) {
                Text(card.letter)
                    .font(.system(size: 15, weight: .medium))
                    .frame(width: 36, height: 36)
                    .overlay(Circle().strokeBorder(Color(nsColor: .separatorColor), lineWidth: 1.2))
                VStack(alignment: .leading, spacing: 3) {
                    Text(verbatim: card.title).font(.system(size: 15, weight: .medium)).foregroundStyle(.primary)
                    if let d = card.detail {
                        Text(verbatim: d).font(.callout).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 12)
                if card.isRecommended {
                    Text("Recommended").font(.caption.weight(.medium)).foregroundStyle(Color(nsColor: NSColor(hex: 0x3F3200)))
                        .padding(.horizontal, 10).padding(.vertical, 4)
                        .background(Theme.duck.opacity(0.55), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                }
            }
            .padding(.horizontal, 18).padding(.vertical, 14)
            .frame(maxWidth: .infinity, minHeight: 68, alignment: .leading)
            .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
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
            .squeakGlass(radius: 16, tint: hovering ? Color.accentColor.opacity(0.14) : nil, interactive: true)
            .overlay(RoundedRectangle(cornerRadius: 16, style: .continuous).strokeBorder(Color(nsColor: .separatorColor).opacity(0.7)))
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.985 : 1)
            .animation(reduceMotion ? nil : .spring(response: 0.25, dampingFraction: 0.8), value: configuration.isPressed)
            .animation(reduceMotion ? nil : .spring(response: 0.3, dampingFraction: 0.9), value: hovering)
    }
}

struct DeliveryText {
    var text: String
    var symbol: String
    var color: Color
    var offersOpen = false
    var offersReuse = false

    init?(state: MessageState?) {
        switch state {
        case nil, .draft: return nil
        case .pending: self = .init(text: "Sending…", symbol: "ellipsis", color: Theme.subtle)
        case .accepted(let via): self = .init(text: Self.delivered(via), symbol: "checkmark", color: Theme.subtle)
        case .confirmed: self = .init(text: "Delivered", symbol: "checkmark", color: Theme.subtle)
        case .uncertain:
            self = .init(text: "Not confirmed — check Conductor before resending", symbol: "exclamationmark.circle", color: Theme.muted, offersOpen: true)
        case .refused(let r): self = .init(text: "Refused: \(r)", symbol: "xmark.circle", color: Theme.error, offersReuse: true)
        case .notSent(let r): self = .init(text: "Not sent: \(r)", symbol: "exclamationmark.circle", color: Theme.error, offersReuse: true)
        }
    }

    private init(text: String, symbol: String, color: Color, offersOpen: Bool = false, offersReuse: Bool = false) {
        self.text = text
        self.symbol = symbol
        self.color = color
        self.offersOpen = offersOpen
        self.offersReuse = offersReuse
    }

    static func delivered(_ via: String) -> String {
        switch via {
        case "conductor": "Delivered via Conductor"
        case "terminal": "Delivered via Terminal"
        case "background": "Sent in the background — Conductor shows it after it reloads the chat"
        default: "Delivered via \(via)"
        }
    }
}
