import SqueakMacCore
import SwiftUI

struct ConversationView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        @Bindable var model = model
        NavigationSplitView {
            SidebarView()
                .navigationSplitViewColumnWidth(min: 250, ideal: 290, max: 380)
        } detail: {
            DetailView()
        }
        .searchable(text: $model.query, placement: .sidebar, prompt: "Search sessions and messages")
        .background(Theme.bg)
        .frame(minWidth: 840, minHeight: 520)
    }
}

struct SidebarView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        let selection = Binding<SessionKey?>(get: { model.selected }, set: { model.select($0) })
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                ConnectionPill()
                Spacer()
                Button { QuickComposerController.shared.show() } label: { Image(systemName: "square.and.pencil") }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Quick message")
                    .help("Quick message")
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            if model.sessions.isEmpty {
                Spacer()
                EmptyStateView(
                    symbol: model.isConnected ? "tray" : "bolt.slash",
                    title: model.isConnected ? "No sessions yet" : (model.health == nil ? "Connecting…" : "No sessions to show"),
                    message: model.isConnected ? "Start a chat in Conductor and it shows up here." : "The fix is shown on the right."
                )
                Spacer()
            } else {
                List(selection: selection) {
                    SessionSections { model.select($0) }
                }
                .listStyle(.sidebar)
                .scrollContentBackground(.hidden)
            }
        }
        .background(Theme.sidebar)
    }
}

struct DetailView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            if let s = model.selectedSession {
                SessionDetail(session: s).id(s.key)
            } else if model.selected != nil {
                placeholder("questionmark.circle", "Session not in the list", "Squeak no longer lists this session. It may have been archived in Conductor.")
            } else if !model.isConnected && model.health != nil {
                VStack(spacing: 12) {
                    ConnectionBanner().frame(maxWidth: 460)
                    Text("Drafts are saved on this Mac and never sent on their own after reconnecting.")
                        .font(.system(size: 11)).foregroundStyle(Theme.subtle)
                }
                .padding(24)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if model.sessions.isEmpty {
                placeholder("tray", "Nothing here yet", "When you start a chat in Conductor, it appears in the sidebar and you can answer it from here.")
            } else {
                placeholder("bubble.left.and.bubble.right", "Choose a session", "Pick a session on the left, or press ⌘1 to ⌘9.")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bg)
    }

    private func placeholder(_ symbol: String, _ title: String, _ message: String) -> some View {
        EmptyStateView(symbol: symbol, title: title, message: message)
    }
}

struct SessionDetail: View {
    let session: HostSession
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var activityOpen = false
    @State private var focusToken = 0

    var body: some View {
        VStack(spacing: 0) {
            header
            Divider().overlay(Theme.line)
            if !model.isConnected {
                ConnectionBanner(compact: true).padding(12)
            }
            transcript
            if showActivity {
                activityPanel
            }
            Divider().overlay(Theme.line)
            composer
        }
        .onAppear { focusToken += 1 }
    }

    private var showActivity: Bool {
        if case .unsupported = session.capabilities.activity { return false }
        return true
    }

    // MARK: Header

    private var header: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(verbatim: session.label)
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundStyle(Theme.ink)
                    .lineLimit(1)
                HStack(spacing: 8) {
                    let place = [session.repoName, session.branch].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
                    if !place.isEmpty {
                        Text(verbatim: place).font(.system(size: 12)).foregroundStyle(Theme.muted).lineLimit(1)
                    }
                    HStack(spacing: 5) {
                        StateDot(state: session.state)
                        Text(Theme.label(for: session.state)).font(.system(size: 12, weight: .medium))
                            .foregroundStyle(Theme.color(for: session.state))
                    }
                }
            }
            Spacer()
            Button { model.openInHost() } label: { Label("Open in Conductor", systemImage: "arrow.up.forward.app") }
                .buttonStyle(QuietButtonStyle())
                .disabled(model.openURL == nil)
                .help(model.openURL == nil ? "This session can't be opened in Conductor" : "Open this chat in Conductor")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    // MARK: Messages

    @ViewBuilder
    private var transcript: some View {
        if case .unsupported(let why) = session.capabilities.readTranscript {
            EmptyStateView(symbol: "eye.slash", title: "Can't show this conversation", message: why)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else if model.messages.isEmpty {
            EmptyStateView(symbol: "text.bubble", title: "No messages yet", message: "Messages appear here as the agent and you exchange them.")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 14) {
                        ForEach(model.messages) { m in
                            MessageView(message: m, canOpenHost: model.openURL != nil)
                                .id(m.id)
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .frame(maxWidth: 760)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 16)
                    .frame(maxWidth: .infinity)
                }
                .onChange(of: model.messages.last?.id) { _, _ in scrollDown(proxy) }
                .onChange(of: model.messages.last?.state) { _, _ in scrollDown(proxy) }
                .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
            }
        }
    }

    private func scrollDown(_ proxy: ScrollViewProxy) {
        if reduceMotion { proxy.scrollTo("bottom", anchor: .bottom) } else {
            withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("bottom", anchor: .bottom) }
        }
    }

    // MARK: Activity

    private var activityPanel: some View {
        DisclosureGroup(isExpanded: $activityOpen) {
            if model.activity.isEmpty {
                Text(session.state == .working ? "Nothing reported yet." : "Nothing happening right now.")
                    .font(.system(size: 11)).foregroundStyle(Theme.subtle)
            } else {
                VStack(alignment: .leading, spacing: 4) {
                    ForEach(Array(model.activity.suffix(8).enumerated()), id: \.offset) { _, step in
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Image(systemName: icon(step.kind)).font(.system(size: 9)).foregroundStyle(Theme.subtle).frame(width: 12)
                            Text(verbatim: step.text).font(.system(size: 11)).foregroundStyle(Theme.muted).lineLimit(2)
                        }
                    }
                }
            }
        } label: {
            Text("What it's doing").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.muted)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
        .task(id: session.key) {
            while !Task.isCancelled {
                if activityOpen { await model.refreshActivity() }
                try? await Task.sleep(for: .seconds(2))
            }
        }
        .onChange(of: activityOpen) { _, open in if open { Task { await model.refreshActivity() } } }
    }

    private func icon(_ kind: String) -> String {
        switch kind {
        case "thinking": "brain"
        case "tool": "wrench.and.screwdriver"
        default: "text.alignleft"
        }
    }

    // MARK: Composer

    private var sendBlock: String? {
        if case .unsupported(let why) = session.capabilities.send { return why }
        if session.replyTarget == nil { return "Squeak has no way to reply to this session." }
        return nil
    }

    private var composer: some View {
        let text = Binding(get: { model.draft }, set: { model.setDraft($0) })
        let canSend = sendBlock == nil && model.isConnected && !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return VStack(alignment: .leading, spacing: 8) {
            if let why = sendBlock {
                Label("Read-only: \(why)", systemImage: "lock")
                    .font(.system(size: 12)).foregroundStyle(Theme.muted)
            } else {
                ComposerField(
                    text: text, sendKey: .commandReturnSends, placeholder: "Reply to \(session.label)",
                    isEnabled: true, focusToken: focusToken, onSend: send
                )
                .frame(height: 74)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: 10))
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.line))
            }
            HStack(spacing: 8) {
                Image(systemName: "paperclip").foregroundStyle(Theme.subtle)
                    .accessibilityLabel("Attachments unavailable")
                    .help(session.capabilities.attachments.reason ?? "Attachments aren't supported yet")
                Text(destination)
                    .font(.system(size: 11)).foregroundStyle(Theme.subtle).lineLimit(1)
                Spacer()
                if sendBlock == nil, !model.isConnected {
                    Text("Offline. Your draft is saved and is not sent automatically.")
                        .font(.system(size: 11)).foregroundStyle(Theme.muted)
                } else if sendBlock == nil {
                    Text("⌘↩ to send").font(.system(size: 11)).foregroundStyle(Theme.subtle)
                }
                Button("Send", action: send)
                    .buttonStyle(PrimaryButtonStyle())
                    .keyboardShortcut(.return, modifiers: .command)
                    .disabled(!canSend)
                    .accessibilityLabel("Send message")
            }
        }
        .padding(12)
    }

    private var destination: String {
        "To: \(session.label) · \(providerName(session.key.provider))"
    }

    private func send() {
        let t = model.draft
        guard sendBlock == nil, model.isConnected, !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        let key = session.key
        Task { _ = await model.send(t, to: key) }
    }
}

// MARK: - Messages

struct MessageView: View {
    let message: ChatMessage
    var canOpenHost: Bool
    @Environment(AppModel.self) private var model

    var body: some View {
        let mine = message.role == .user
        VStack(alignment: mine ? .trailing : .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(mine ? "You" : "Agent").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.muted)
                if let at = message.at {
                    Text(at.formatted(date: .omitted, time: .shortened)).font(.system(size: 10)).foregroundStyle(Theme.subtle)
                }
            }
            MessageBody(text: message.text)
                .padding(.horizontal, 12)
                .padding(.vertical, 9)
                .background(mine ? Theme.userBubble : Theme.surface, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
                .frame(maxWidth: mine ? 560 : .infinity, alignment: mine ? .trailing : .leading)
            if mine, let status = DeliveryText(state: message.state) {
                HStack(spacing: 6) {
                    Image(systemName: status.symbol).font(.system(size: 10)).foregroundStyle(status.color)
                    Text(status.text).font(.system(size: 11)).foregroundStyle(status.color)
                        .fixedSize(horizontal: false, vertical: true)
                    if status.offersOpen, canOpenHost {
                        Button("Open in Conductor") { model.openInHost() }.buttonStyle(QuietButtonStyle())
                    }
                    if status.offersReuse {
                        Button("Edit as new message") { model.reuse(message) }.buttonStyle(QuietButtonStyle())
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: mine ? .trailing : .leading)
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
        case .pending: self = .init(text: "Sending…", symbol: "ellipsis", color: Theme.muted)
        case .accepted(let via): self = .init(text: Self.delivered(via), symbol: "checkmark", color: Theme.working)
        case .confirmed: self = .init(text: "Delivered", symbol: "checkmark.circle.fill", color: Theme.working)
        case .uncertain: self = .init(text: "Not confirmed — check Conductor before resending", symbol: "questionmark.circle.fill", color: Theme.duck, offersOpen: true)
        case .refused(let r): self = .init(text: "Refused: \(r)", symbol: "xmark.circle.fill", color: Theme.needsYou, offersReuse: true)
        case .notSent(let r): self = .init(text: "Not sent: \(r)", symbol: "exclamationmark.circle.fill", color: Theme.needsYou, offersReuse: true)
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

/// Agent text is untrusted: plain Text only, never Markdown or links. Fenced code
/// blocks are split out and set monospaced.
struct MessageBody: View {
    let text: String

    private enum Piece: Hashable { case prose(String), code(String) }

    private var pieces: [Piece] {
        let parts = text.components(separatedBy: "```")
        var out: [Piece] = []
        for (i, part) in parts.enumerated() {
            if i % 2 == 1 {
                var code = part
                if let nl = code.firstIndex(of: "\n"), !code[..<nl].contains(" ") { code = String(code[code.index(after: nl)...]) }
                out.append(.code(code.trimmingCharacters(in: .newlines)))
            } else {
                let p = part.trimmingCharacters(in: .newlines)
                if !p.isEmpty { out.append(.prose(p)) }
            }
        }
        return out
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(pieces.enumerated()), id: \.offset) { _, piece in
                switch piece {
                case .prose(let p):
                    Text(verbatim: p)
                        .font(.system(size: 13))
                        .foregroundStyle(Theme.ink)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                case .code(let c):
                    ScrollView(.horizontal, showsIndicators: false) {
                        Text(verbatim: c)
                            .font(.system(size: 12, design: .monospaced))
                            .foregroundStyle(Theme.ink)
                            .textSelection(.enabled)
                            .padding(8)
                    }
                    .background(Theme.surfaceRaised.opacity(0.7), in: RoundedRectangle(cornerRadius: 8))
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
