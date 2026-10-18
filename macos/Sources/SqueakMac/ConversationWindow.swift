import AppKit
import SqueakMacCore
import SwiftUI

// The Squeak window (.context/v3/DESIGN-BRIEF.md): a 260pt sidebar of grouped sessions and a
// calm reading column. Whitespace and type do the work; the only lines are hairlines under the
// header and between sidebar sections. Nothing here sends by itself: a chip, the Send button and
// ⌘↩ are deliberate taps.

struct ConversationView: View {
    @Environment(AppModel.self) private var model
    @FocusState private var searchFocused: Bool

    var body: some View {
        HStack(spacing: 0) {
            SidebarView(searchFocused: $searchFocused)
                .frame(width: 260)
            Rectangle().fill(Theme.line).frame(width: 1)
            DetailView()
        }
        .background(Theme.bg)
        .ignoresSafeArea(.container, edges: .top)
        .frame(minWidth: 900, minHeight: 560)
        .background(WindowChrome())
        .background {
            // ⌘F focuses the search field from anywhere in the window.
            Button("Search") { searchFocused = true }
                .keyboardShortcut("f", modifiers: .command)
                .opacity(0).accessibilityHidden(true)
        }
    }
}

/// A transparent title bar, so the sidebar and header own the top edge; the traffic lights stay.
struct WindowChrome: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let v = NSView()
        DispatchQueue.main.async { Self.apply(v.window) }
        return v
    }

    func updateNSView(_ v: NSView, context: Context) {
        DispatchQueue.main.async { Self.apply(v.window) }
    }

    static func apply(_ w: NSWindow?) {
        guard let w else { return }
        w.titlebarAppearsTransparent = true
        w.titleVisibility = .hidden
        w.styleMask.insert(.fullSizeContentView)
    }
}

// MARK: - Sidebar

struct SidebarView: View {
    @Environment(AppModel.self) private var model
    var searchFocused: FocusState<Bool>.Binding
    @State private var showEarlier = false

    var body: some View {
        @Bindable var model = model
        VStack(alignment: .leading, spacing: 0) {
            header
            SearchField(text: $model.query, placeholder: "Search chats", hint: "⌘F", focus: searchFocused)
                .padding(.horizontal, Space.m)
                .padding(.bottom, Space.s)
            content
        }
        .frame(maxHeight: .infinity, alignment: .top)
        .background(Theme.sidebar)
    }

    private var header: some View {
        HStack(spacing: 10) {
            DuckGlyph(size: 28)
            VStack(alignment: .leading, spacing: 1) {
                Text("Squeak").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.ink)
                HStack(spacing: 5) {
                    Circle().fill(connectionColor).frame(width: 6, height: 6)
                    Text(connectionText).font(.system(size: 11)).foregroundStyle(Theme.muted).lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            Button { QuickComposerController.shared.show() } label: {
                Image(systemName: "square.and.pencil").font(.system(size: 13)).foregroundStyle(Theme.muted)
                    .frame(width: 26, height: 26).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Quick message")
            .help("Quick message")
        }
        .padding(.horizontal, Space.l)
        .padding(.top, 40)  // clears the traffic lights
        .padding(.bottom, Space.m)
        .accessibilityElement(children: .contain)
    }

    private var connectionText: String {
        model.hasLoaded || model.health != nil ? model.connectionTitle : "Connecting…"
    }

    private var connectionColor: Color {
        if !(model.hasLoaded || model.health != nil) { return Theme.subtle }
        return model.isConnected ? Theme.working : Theme.subtle
    }

    @ViewBuilder private var content: some View {
        if model.isSearching {
            searchResults
        } else if model.sessions.isEmpty {
            Spacer()
            Text(model.isConnected ? "No chats yet. Start one in Conductor and it shows up here." : "No chats to show yet.")
                .font(.system(size: 12)).foregroundStyle(Theme.muted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity).padding(Space.xl)
            Spacer()
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(Array(model.grouped.enumerated()), id: \.element.id) { i, section in
                        if i > 0 {
                            Hairline().padding(.horizontal, Space.m).padding(.top, Space.m)
                        }
                        sectionView(section, first: i == 0)
                    }
                }
                .padding(.horizontal, Space.s)
                .padding(.bottom, Space.l)
            }
        }
    }

    @ViewBuilder private func sectionView(_ section: SessionSection, first: Bool) -> some View {
        let isEarlier = section.kind == .earlier
        SectionLabel(section.kind.title, count: section.kind == .needsYou ? section.sessions.count : nil)
            .padding(.horizontal, Space.m)
            .padding(.top, first ? Space.s : Space.m)
            .padding(.bottom, Space.xs)
        if isEarlier {
            ShowEarlierRow(count: section.sessions.count, expanded: showEarlier) { showEarlier.toggle() }
        }
        if !isEarlier || showEarlier {
            ForEach(section.sessions) { row($0) }
        }
    }

    private func row(_ s: HostSession, snippet: String? = nil) -> some View {
        SessionRowView(session: s, isSelected: model.selected == s.key, isPinned: model.pinned.contains(s.key), subtitleOverride: snippet)
            .onTapGesture { model.select(s.key) }
            .accessibilityAddTraits(.isButton)
            .contextMenu {
                Button(model.pinned.contains(s.key) ? "Unpin" : "Pin to top") { model.togglePin(s.key) }
            }
    }

    @ViewBuilder private var searchResults: some View {
        let hits = model.searchHits
        if hits.isEmpty {
            Text("No matches. Search covers titles and messages Squeak has already opened on this Mac.")
                .font(.system(size: 12)).foregroundStyle(Theme.muted)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity).padding(Space.xl)
            Spacer()
        } else {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    ForEach(hits, id: \.key) { hit in
                        if let s = model.session(hit.key) { row(s, snippet: hit.titleMatch ? nil : hit.snippet) }
                    }
                }
                .padding(.horizontal, Space.s)
            }
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
                        .font(.system(size: 11)).foregroundStyle(Theme.subtle)
                }
                .padding(Space.xl)
            } else if model.sessions.isEmpty {
                pick("Nothing here yet.")
            } else {
                pick(nil)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bg)
    }

    private func pick(_ note: String?) -> some View {
        VStack(spacing: Space.m) {
            DuckGlyph(size: 48).opacity(0.9)
            Text(note == nil ? "Pick a chat" : "Pick a chat").font(.system(size: 14)).foregroundStyle(Theme.muted)
            if let note {
                Text(note).font(.system(size: 12)).foregroundStyle(Theme.subtle).multilineTextAlignment(.center)
                    .frame(maxWidth: 320)
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
                    Circle().fill(Theme.subtle).frame(width: 6, height: 6)
                    Text(model.connectionTitle).font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.ink)
                    Spacer()
                    Button("Check again") { model.recheck() }.buttonStyle(QuietButtonStyle())
                }
                Text(help).font(.system(size: 11.5)).foregroundStyle(Theme.muted)
                    .lineLimit(compact ? 2 : nil).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            }
            .padding(Space.m)
            .background(Theme.surfaceRaised.opacity(0.45), in: RoundedRectangle(cornerRadius: Radius.card))
        }
    }
}

struct SessionDetail: View {
    let session: HostSession
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var activityOpen = false
    @State private var focusToken = 0
    @State private var atBottom = false
    @State private var contentHeight: CGFloat = 0

    private var agent: String { SessionRowView.agentName(session.agent) ?? "Agent" }

    var body: some View {
        VStack(spacing: 0) {
            header
            Hairline()
            if !model.isConnected {
                ConnectionNotice(compact: true).padding(.horizontal, Space.xl).padding(.top, Space.m)
            }
            transcript
        }
        .onAppear { focusToken += 1 }
    }

    // MARK: Header

    private var header: some View {
        HStack(alignment: .center, spacing: Space.m) {
            VStack(alignment: .leading, spacing: 4) {
                Text(verbatim: session.label)
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(Theme.ink)
                    .lineLimit(1)
                Text(verbatim: SessionRowView.subtitle(session, showsAgent: true))
                    .font(.system(size: 12.5)).foregroundStyle(Theme.muted).lineLimit(1)
            }
            Spacer(minLength: Space.m)
            StateChip(state: session.state)
            Button { model.openInHost() } label: {
                Label("Open in Conductor", systemImage: "arrow.up.right").labelStyle(.titleAndIcon)
            }
            .buttonStyle(QuietButtonStyle())
            .disabled(model.openURL == nil && !model.demoMode)
            .help(model.openURL == nil ? "This chat can't be opened in Conductor" : "Open this chat in Conductor")
        }
        .padding(.horizontal, 32)
        .frame(maxWidth: 784)
        .padding(.top, 36)
        .padding(.bottom, Space.l)
        .frame(maxWidth: .infinity)
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
                    LazyVStack(alignment: .leading, spacing: 22) {
                        ForEach(model.messages) { m in
                            MessageView(
                                message: m, agentName: agent, canOpenHost: model.openURL != nil,
                                needsYou: m.id == needsYouMessageID, choices: m.id == needsYouMessageID ? Choices.parse(m.text) : [],
                                canAnswer: sendBlock == nil && model.isConnected, onChoose: choose
                            )
                            .id(m.id)
                        }
                        Color.clear.frame(height: 1).id("bottom")
                            .onAppear { atBottom = true }
                            .onDisappear { atBottom = false }
                    }
                    .frame(maxWidth: 720, alignment: .leading)
                    .padding(.horizontal, 32)
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
            Image(systemName: symbol).font(.system(size: 26)).foregroundStyle(Theme.subtle)
            Text(title).font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.ink)
            Text(message).font(.system(size: 12)).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
        }
        .frame(maxWidth: 340)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// The agent's last message, when it is the last thing in the chat and the chat needs you.
    private var needsYouMessageID: String? {
        guard session.state == .blocked, let last = model.messages.last, last.role == .assistant else { return nil }
        return last.id
    }

    private func choose(_ c: Choice) {
        guard sendBlock == nil, model.isConnected else { return }
        let key = session.key
        Task { _ = await model.send(c.letter, to: key) }
    }

    private func scrollDown(_ proxy: ScrollViewProxy) {
        if reduceMotion { proxy.scrollTo("bottom", anchor: .bottom) } else {
            withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("bottom", anchor: .bottom) }
        }
    }

    // MARK: Bottom bar: activity pill and the floating composer

    private var bottomBar: some View {
        VStack(spacing: Space.s) {
            if session.state == .working { ActivityPill(open: $activityOpen, key: session.key) }
            composer
        }
        .frame(maxWidth: 784)
        .padding(.horizontal, Space.l)
        .padding(.top, Space.l)
        .padding(.bottom, Space.l)
        .frame(maxWidth: .infinity)
        .background(alignment: .bottom) {
            LinearGradient(colors: [Theme.bg.opacity(0), Theme.bg.opacity(0.92)], startPoint: .top, endPoint: .bottom)
                .allowsHitTesting(false)
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
        return session.key.provider.hasSuffix("-terminal") ? "Reply to \(agent) in Terminal…" : "Reply to \(agent)…"
    }

    private var hasText: Bool { !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    private var canSend: Bool { sendBlock == nil && model.isConnected && hasText }

    private var composer: some View {
        let text = Binding(get: { model.draft }, set: { model.setDraft($0) })
        let editable = sendBlock == nil && model.isConnected
        let lineHeight: CGFloat = 17
        let minH: CGFloat = 30
        let maxH: CGFloat = lineHeight * 6 + 12
        return HStack(alignment: .bottom, spacing: Space.s) {
            ComposerField(
                text: text, sendKey: .commandReturnSends, placeholder: placeholder,
                isEnabled: editable, focusToken: focusToken, onSend: send,
                onContentHeight: { contentHeight = $0 }
            )
            .frame(height: min(max(contentHeight, minH), maxH))
            if editable {
                Text("⌘↩")
                    .font(.system(size: 11.5)).foregroundStyle(Theme.subtle)
                    .padding(.horizontal, 8).frame(height: 22)
                    .background(Theme.surfaceRaised.opacity(0.6), in: Capsule())
                    .padding(.bottom, 4)
                    .accessibilityHidden(true)
            }
            Button(action: send) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 13, weight: .bold))
                    .foregroundStyle(canSend ? Color(nsColor: NSColor(hex: 0x18181B)) : Theme.muted)
                    .frame(width: 30, height: 30)
                    .background(canSend ? Theme.duck : Theme.surfaceRaised.opacity(0.8), in: Circle())
            }
            .buttonStyle(.plain)
            .keyboardShortcut(.return, modifiers: .command)
            .disabled(!canSend)
            .accessibilityLabel("Send message")
            .help(session.capabilities.attachments.reason.map { "Send (⌘↩). Attachments: \($0)" } ?? "Send (⌘↩)")
        }
        .padding(.leading, 18)
        .padding(.trailing, 8)
        .padding(.vertical, 8)
        .glassCapsule(radius: Radius.capsule)
        .accessibilityElement(children: .contain)
    }

    private func send() {
        let t = model.draft
        guard canSend, !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let key = session.key
        Task { _ = await model.send(t, to: key) }
    }
}

extension View {
    /// macOS 26 glass where it exists, the regular material elsewhere.
    @ViewBuilder func glassCapsule(radius: CGFloat) -> some View {
        let shape = RoundedRectangle(cornerRadius: radius, style: .continuous)
        if ProcessInfo.processInfo.environment["SQUEAK_MAC_CAPTURE"] != nil {
            // cacheDisplay cannot draw glass or materials, so a capture shows a flat stand-in.
            self.background(Theme.surfaceRaised.opacity(0.55), in: shape).overlay(shape.stroke(Theme.line))
        } else if #available(macOS 26, *) {
            self.glassEffect(.regular, in: shape)
                .shadow(color: .black.opacity(0.18), radius: 14, y: 4)
        } else {
            self.background(.regularMaterial, in: shape)
                .overlay(shape.stroke(Theme.line))
                .shadow(color: .black.opacity(0.18), radius: 14, y: 4)
        }
    }
}

// MARK: - What it's doing

/// A quiet pill above the composer: the newest step in one line; a click shows the last six.
struct ActivityPill: View {
    @Binding var open: Bool
    let key: SessionKey
    @Environment(AppModel.self) private var model

    var body: some View {
        let steps = Array(model.activity.suffix(6))
        VStack(alignment: .leading, spacing: Space.s) {
            Button { open.toggle() } label: {
                HStack(spacing: Space.s) {
                    StateDot(state: .working).scaleEffect(0.8)
                    Text(verbatim: steps.last?.text ?? "Working…")
                        .font(.system(size: 12)).foregroundStyle(Theme.muted).lineLimit(1)
                    Spacer(minLength: Space.s)
                    Image(systemName: open ? "chevron.down" : "chevron.up")
                        .font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.subtle)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("What it's doing: \(steps.last?.text ?? "working")")
            .accessibilityHint(open ? "Hides the last steps" : "Shows the last steps")
            if open {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(Array(steps.enumerated()), id: \.offset) { _, step in
                        HStack(alignment: .firstTextBaseline, spacing: Space.s) {
                            Image(systemName: icon(step.kind)).font(.system(size: 9)).foregroundStyle(Theme.subtle).frame(width: 12)
                            Text(verbatim: step.text).font(.system(size: 11.5)).foregroundStyle(Theme.muted).lineLimit(2)
                        }
                    }
                }
                .padding(.leading, 2)
            }
        }
        .padding(.horizontal, Space.m + 2)
        .padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surfaceRaised.opacity(0.5), in: RoundedRectangle(cornerRadius: Radius.card))
        .task(id: key) {
            while !Task.isCancelled {
                await model.refreshActivity()
                try? await Task.sleep(for: .seconds(2))
            }
        }
    }

    private func icon(_ kind: String) -> String {
        switch kind {
        case "thinking": "brain"
        case "tool": "wrench.and.screwdriver"
        default: "text.alignleft"
        }
    }
}

// MARK: - Messages

struct MessageView: View {
    let message: ChatMessage
    var agentName: String
    var canOpenHost: Bool
    var needsYou = false
    var choices: [Choice] = []
    var canAnswer = true
    var onChoose: (Choice) -> Void = { _ in }
    @Environment(AppModel.self) private var model

    var body: some View {
        let mine = message.role == .user
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Text(mine ? "You" : agentName).font(.system(size: 12, weight: .semibold)).foregroundStyle(Theme.muted)
                if let at = message.at {
                    Text(at.formatted(date: .omitted, time: .shortened)).font(.system(size: 11)).foregroundStyle(Theme.subtle)
                }
            }
            if mine {
                Text(verbatim: message.text)
                    .font(.system(size: 14))
                    .lineSpacing(3.5)
                    .foregroundStyle(Theme.ink)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 14)
                    .padding(.vertical, 12)
                    .background(Theme.surfaceRaised.opacity(0.45), in: RoundedRectangle(cornerRadius: Radius.bubble))
                if let status = DeliveryText(state: message.state) { delivery(status) }
            } else {
                agentBody
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Unboxed prose. When the chat needs an answer to this message it gets the red bar and chips.
    private var agentBody: some View {
        HStack(alignment: .top, spacing: 11) {
            if needsYou {
                RoundedRectangle(cornerRadius: 1.5).fill(Theme.needsYou).frame(width: 3)
                    .accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: Space.m) {
                MarkdownView(text: shownText)
                if needsYou, !choices.isEmpty {
                    ChoiceChips(choices: choices, isEnabled: canAnswer, onChoose: onChoose)
                }
            }
        }
        .fixedSize(horizontal: false, vertical: true)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(needsYou ? "\(agentName) is waiting for your answer" : "")
    }

    /// While chips stand in for the options, a bare "A. Retry once" line would say it twice. Lines
    /// that say more than their chip, and everything else, stay.
    private var shownText: String {
        guard needsYou, !choices.isEmpty,
              let re = try? NSRegularExpression(pattern: #"^\s*(?:[-*+]\s+)?\(?([A-H])[).:]\s+(.*)$"#) else { return message.text }
        var inCode = false
        let kept = message.text.components(separatedBy: "\n").filter { line in
            if line.trimmingCharacters(in: .whitespaces).hasPrefix("```") { inCode.toggle(); return true }
            guard !inCode, let m = re.firstMatch(in: line, range: NSRange(line.startIndex..., in: line)),
                  let lr = Range(m.range(at: 1), in: line), let tr = Range(m.range(at: 2), in: line),
                  let choice = choices.first(where: { $0.letter == String(line[lr]) }) else { return true }
            let rest = Choices.stripMarkdown(String(line[tr])).trimmingCharacters(in: CharacterSet(charactersIn: " .:"))
            return rest != choice.label
        }.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        return kept.isEmpty ? message.text : kept
    }

    private func delivery(_ status: DeliveryText) -> some View {
        HStack(spacing: 6) {
            Image(systemName: status.symbol).font(.system(size: 10, weight: .medium)).foregroundStyle(status.color)
            Text(status.text).font(.system(size: 11.5)).foregroundStyle(status.color)
                .fixedSize(horizontal: false, vertical: true)
            if status.offersOpen, canOpenHost {
                Button("Open in Conductor") { model.openInHost() }.buttonStyle(.plain)
                    .font(.system(size: 11.5, weight: .medium)).foregroundStyle(Theme.ink)
            }
            if status.offersReuse {
                Button("Edit as new message") { model.reuse(message) }.buttonStyle(.plain)
                    .font(.system(size: 11.5, weight: .medium)).foregroundStyle(Theme.ink)
            }
        }
        .accessibilityElement(children: .combine)
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
