import AppKit
import SqueakIcons
import SqueakMarkup
import SqueakMacCore
import SwiftUI

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
    @State private var images = ImageTray()
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
                ConnectionNotice(compact: true).padding(.horizontal, 16).padding(.bottom, Space.s)
            }
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
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 12) {
                Text(verbatim: SessionText.headline(session))
                    .font(.system(size: 18, weight: .bold)).lineLimit(1).truncationMode(.tail)
                    .help(SessionText.headline(session))
                    .accessibilityAddTraits(.isHeader)
                Spacer(minLength: 12)
                if session.capabilities.openInHost.isSupported {
                    Button { model.openInHost() } label: {
                        Lucide(.externalLink, size: Metrics.icon, color: Theme.ink)
                    }
                    .modifier(GlassBorderedButton())
                    .help("Open this chat in Conductor")
                    .accessibilityLabel("Open in Conductor")
                    .disabled(model.openURL == nil && !model.demoMode)
                }
                if session.conductorSessionId != nil, model.workspaceRepos != nil {
                    ChatActionsMenu(session: session)
                }
            }
            Text(verbatim: metaLine).font(.system(size: 11.5)).monospacedDigit().foregroundStyle(Theme.muted)
                .lineLimit(1).truncationMode(.middle)
                .help(metaLine)
            if let extras = model.chatExtras, session.conductorSessionId != nil {
                ChatSetupLine(session: session, extras: extras)
            }
            tabStrip.padding(.top, 2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 8)
    }

    /// Chat | Activity as one wide segmented control: a hairline-framed track, the chosen half raised.
    private var tabStrip: some View {
        HStack(spacing: 0) {
            ForEach(DetailTab.allCases) { t in
                Button { tab = t } label: {
                    Text(t.rawValue).font(.system(size: 12, weight: tab == t ? .semibold : .regular))
                        .foregroundStyle(tab == t ? Theme.ink : Theme.muted)
                        .frame(maxWidth: .infinity, minHeight: 22)
                        .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(tab == t ? Theme.selectedStrong : .clear))
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(tab == t ? .isSelected : [])
            }
        }
        .padding(2)
        .background(Theme.surface.opacity(0.6), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.lineStrong))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Chat or activity")
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
                    LazyVStack(alignment: .leading, spacing: 16) {
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
                                ask: display.ask, framed: true, canSend: sendBlock == nil && model.isConnected,
                                onSend: { form in await model.answer(form, for: session.key) }, result: display.outcome
                            )
                            .id(display.ask.toolUseId)
                        }
                        Color.clear.frame(height: 1).id("bottom")
                            .onAppear { atBottom = true }
                            .onDisappear { atBottom = false }
                    }
                    .frame(maxWidth: 820, alignment: .leading)
                    .padding(.horizontal, 16)
                    .padding(.top, 12)
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
                    .frame(minWidth: 28, minHeight: 28)
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
            if session.source == .conductor {
                QueueStack(model: model, sessionId: session.key.hostSessionId, isWorking: working,
                           onEdit: { model.setDraft($0) })
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
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 12)
        .frame(maxWidth: .infinity)
        .background(Theme.bg)
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
    private var canSend: Bool { sendBlock == nil && model.isConnected && (hasText || images.hasImages) }

    private var composer: some View {
        let text = Binding(get: { model.draft }, set: { model.setDraft($0) })
        let editable = sendBlock == nil && model.isConnected
        let minH: CGFloat = 28
        let maxH: CGFloat = 17 * 7 + 12
        return VStack(alignment: .leading, spacing: 4) {
            ImageStrip(tray: images).padding(.leading, 4)
            HStack(alignment: .bottom, spacing: 8) {
            if editable && session.capabilities.attachments.isSupported {
                AttachButton(tray: images).padding(.bottom, 0)
            }
            ComposerField(
                text: text, sendKey: .commandReturnSends, placeholder: placeholder,
                isEnabled: editable, focusToken: focusToken, onSend: { send(.queue) },
                onContentHeight: { contentHeight = $0 },
                onImages: editable && session.capabilities.attachments.isSupported ? { images.add($0) } : nil
            )
            .frame(height: min(max(contentHeight, minH), maxH))
            HStack(spacing: 8) {
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
                    .buttonStyle(MockSendStyle())
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
                    .buttonStyle(MockSendStyle())
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(!canSend)
                    .accessibilityLabel("Send message")
                    .help(session.capabilities.attachments.reason.map { "Send (⌘↩). Attachments: \($0)" } ?? "Send (⌘↩). Paste, drop or + attaches images")
                }
            }
            }
        }
        .padding(.leading, 12).padding(.trailing, 6).padding(.vertical, 6)
        .background(Theme.surface.opacity(0.7), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Theme.lineStrong))
        .accessibilityElement(children: .contain)
        .imageDrop(images)
    }

    private func shortcut(_ mode: SendMode, _ modifiers: EventModifiers) -> some View {
        Button("") { send(mode) }
            .keyboardShortcut(.return, modifiers: modifiers)
            .disabled(!canSend)
            .frame(width: 0, height: 0).opacity(0).accessibilityHidden(true)
    }

    private func send(_ mode: SendMode) {
        let typed = model.draft
        guard canSend else { return }
        // Images are saved into the chat's folder only now; if that fails nothing is sent and everything stays.
        guard let t = images.prepareToSend(text: typed, folder: session.cwd) else { return }
        let sentImages = images.hasImages
        let key = session.key
        // The mode only means something mid-turn; an idle chat is simply sent.
        let effective: SendMode = working ? mode : .queue
        if working { queueSteerExplained = true }
        // The field clears as it sends and keeps focus, so the next message can be typed at once.
        focusToken += 1
        if sentImages { images.clear() }
        Task { _ = await model.send(t, to: key, mode: effective) }
    }
}


/// The composer's Send: duck yellow with ink text, 28pt high, as the mockup draws it. Dimmed while there is nothing to send.
struct MockSendStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 13, weight: .semibold))
            .foregroundStyle(Theme.primaryText)
            .padding(.horizontal, 12).frame(minWidth: 56, minHeight: Metrics.field)
            .background(configuration.isPressed ? Theme.primaryPressed : Theme.primaryFill, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .opacity(isEnabled ? 1 : 0.55)
    }
}
