import SqueakIcons
import SqueakMacCore
import SwiftUI

// MARK: Tab bar

/// Flat workspace-style navigation: a quiet label and one underline for the selected tab.
struct PopupTabBar: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let nav = PopupNav.shared
    var selected: PopupNav.Tab
    var namespace: Namespace.ID

    var body: some View {
        HStack(spacing: 20) {
            ForEach(PopupNav.Tab.allCases) { tab in
                let on = tab == selected
                Button {
                    if reduceMotion { nav.show(tab) }
                    else { withAnimation(.easeInOut(duration: 0.18)) { nav.show(tab) } }
                } label: {
                    Text(tab.title)
                        .font(.popup(12, on ? .semibold : .regular))
                        .foregroundStyle(on ? Theme.ink : Theme.muted)
                        .frame(height: 34)
                        .overlay(alignment: .bottom) {
                            if on {
                                RoundedRectangle(cornerRadius: 1).fill(Theme.ink)
                                    .frame(height: 2)
                                    .matchedGeometryEffect(id: "popup-selected-tab", in: namespace)
                            }
                        }
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(on ? .isSelected : [])
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 6)
    }
}

/// The same brand and navigation on every top-level screen. The second row carries each screen's
/// context, so switching tabs never moves the brand or its actions.
struct PopupTabHeader<Leading: View, Trailing: View>: View {
    @Environment(AppModel.self) private var model
    var selected: PopupNav.Tab
    var namespace: Namespace.ID
    @ViewBuilder var leading: Leading
    @ViewBuilder var trailing: Trailing

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                DuckMark(width: 24)
                Text("Squeak").font(.popup(15, .semibold)).foregroundStyle(Theme.ink)
                Spacer(minLength: 8)
                trailing
            }
            .frame(height: 38)
            .padding(.top, 8)
            HStack(spacing: 8) {
                leading
                Spacer(minLength: 6)
                Text(model.homeConnectionText).font(.popup(11)).foregroundStyle(Theme.muted)
                    .lineLimit(1)
                    .help(model.connectionTitle)
            }
            .padding(.top, 4).padding(.bottom, 4)
            PopupTabBar(selected: selected, namespace: namespace)
        }
        .padding(.horizontal, 4)
    }
}

/// The overflow menu shared by every tab. Search always opens Home before revealing its field.
struct PopupMoreMenu: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Binding var searching: Bool
    let isHome: Bool
    let dismiss: () -> Void

    var body: some View {
        SqueakMenu {
            Button("New chat…", systemImage: "plus") { PopupNav.shared.openNewChat() }
                .keyboardShortcut("n", modifiers: .command)
            Button(isHome && searching ? "Hide search" : "Search sessions…", systemImage: "magnifyingglass") {
                if isHome && searching {
                    searching = false
                    model.query = ""
                } else {
                    if reduceMotion { PopupNav.shared.show(.home) }
                    else { withAnimation(.snappy(duration: 0.24)) { PopupNav.shared.show(.home) } }
                    searching = true
                }
            }
            if model.setupNeedsAttention {
                Button("Finish setting up…", systemImage: "checklist") { dismiss(); model.openSettings(.setup) }
            }
            Divider()
            Button("Settings…", systemImage: "gearshape") { dismiss(); model.openSettings() }
                .keyboardShortcut(",")
            // Opens the update window on the live state (the banner shows the same state), so it always answers.
            Button("Check for Updates…", systemImage: "arrow.down.circle") { model.updater.checkForUpdates() }
            Divider()
            Button("Quit Squeak", systemImage: "power") { QuitIntent.shared.quitCompletely() }
                .keyboardShortcut("q")
        } label: {
            Lucide(.ellipsis, size: 16, label: "More", color: Theme.muted)
                .frame(width: 26, height: 28).contentShape(Rectangle())
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .menuIndicator(.hidden)
        .fixedSize()
        .accessibilityLabel("More options")
    }
}

// MARK: Home

struct PopupHomeTop: View {
    @Environment(AppModel.self) private var model
    @FocusState private var searchFocused: Bool
    @Binding var searching: Bool
    let dismiss: () -> Void
    var namespace: Namespace.ID

    var body: some View {
        @Bindable var model = model
        let total = model.visibleSessions.filter { !SessionGrouping.isEarlier($0, now: Date()) }.count
        VStack(spacing: 0) {
            PopupTabHeader(selected: .home, namespace: namespace) {
                Text("\(total) \(total == 1 ? "chat" : "chats")")
                    .font(.popup(11)).foregroundStyle(Theme.muted).monospacedDigit()
            } trailing: {
                Button {
                    searching.toggle()
                    if !searching { model.query = "" }
                } label: {
                    Lucide(.search, size: 15, label: searching ? "Hide search" : "Search chats", color: Theme.muted)
                        .frame(width: 26, height: 28).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .keyboardShortcut("f")
                .help("Search chats (⌘F)")
                Button { PopupNav.shared.openNewChat() } label: {
                    HStack(spacing: 4) {
                        Lucide(.plus, size: 13, color: Theme.ink)
                        Text("New chat")
                    }
                }
                .buttonStyle(PopupButtonStyle(height: 26, hPad: 8, size: 11))
                .help("New chat (⌘N)")
                PopupMoreMenu(searching: $searching, isHome: true, dismiss: dismiss)
            }
            if searching {
                SearchField(text: $model.query, placeholder: "Search chats…", focus: $searchFocused)
                    .padding(.bottom, 12)
                    .task { searchFocused = true }
            }
            banners
        }
    }

    private func updateRow(_ text: String, action: String, perform: @escaping () -> Void) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: Space.s) {
            Text(text).font(.system(size: 12)).foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 6)
            Button(action, action: perform).buttonStyle(.plain)
                .font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.ink)
        }
    }

    /// The phone-call add-on has an update to offer, is updating, or has just finished (or failed to).
    private var addonUpdateShown: Bool {
        let channels = model.channels
        return channels.gatewayUpdatePhase != nil || channels.gateway?.updateAvailable == true
    }

    /// The Home Assistant add-on's update, the way the Mac app's own update shows above: offered, in progress, done.
    @ViewBuilder private func addonUpdateRow(_ channels: ChannelsModel) -> some View {
        if channels.gatewayUpdating {
            HStack(spacing: Space.s) {
                ProgressView().controlSize(.small)
                Text(GatewayText.updating).font(.system(size: 12)).foregroundStyle(Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } else if case .updated(let version) = channels.gatewayUpdatePhase {
            updateRow("Phone-call add-on updated to \(version)", action: "Dismiss") { channels.dismissGatewayUpdate() }
        } else if channels.gatewayUpdatePhase == .timedOut {
            updateRow(GatewayText.updateTimedOut, action: "Check again") { Task { await channels.checkGatewayUpdate() } }
        } else if let error = channels.gatewayError, channels.gateway?.updateAvailable == true {
            updateRow(error, action: "Try again") { Task { await channels.updateGatewayAddon() } }
        } else if channels.gateway?.updateAvailable == true, let latest = channels.gateway?.latestVersion {
            updateRow("Phone-call add-on \(latest) is available", action: "Update") {
                Task { await channels.updateGatewayAddon() }
            }
        }
    }

    @ViewBuilder private var banners: some View {
        let showHelp = model.health != nil && model.connectionHelp != nil
        let updater = model.updater
        let channels = model.channels
        let showUpdate = updater.flow.phase != .idle || model.updateNote != nil || addonUpdateShown
        if showHelp || model.launchOfferPending || showUpdate || model.tips.tip != nil {
            VStack(alignment: .leading, spacing: 4) {
                UpdateBanner(updater: updater, installedNotice: model.updateNote, dismissInstalledNotice: model.dismissUpdateNote)
                addonUpdateRow(channels)
                if showHelp, let help = model.connectionHelp {
                    HStack(alignment: .top, spacing: Space.s) {
                        Text(help).font(.system(size: 12)).foregroundStyle(Theme.muted).lineLimit(3).fixedSize(horizontal: false, vertical: true)
                        Button("Check again") { model.recheck() }.buttonStyle(.plain)
                            .font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.ink)
                    }
                }
                LaunchOfferBanner()
                SetupTipCard()
            }
            .padding(.bottom, 8)
        }
    }
}

/// Two quiet Mac status links above the chat list. Each opens its tab.
struct PopupMacStrip: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let awakeLine = model.panelAwakeLine
        let usageLine = model.panelUsageLine
        if awakeLine != nil || usageLine != nil {
            HStack(spacing: 8) {
                VStack(alignment: .leading, spacing: 0) {
                    if let awakeLine {
                        stripRow(icon: Lucide(.moon, size: 14, color: Theme.muted), text: awakeLine, tab: .controls, label: "Awake. Opens controls.")
                    }
                    if let usageLine {
                        stripRow(icon: Lucide(.gauge, size: 14, color: Theme.muted), text: usageLine, tab: .usage, label: "Plan usage. Opens usage.")
                    }
                }
            }
            .padding(.horizontal, 8).padding(.vertical, 6)
            .overlay(alignment: .bottom) { PopupDivider() }
            .padding(.bottom, 4)
        }
    }

    private func stripRow(icon: some View, text: String, tab: PopupNav.Tab, label: String) -> some View {
        Button {
            if reduceMotion { PopupNav.shared.show(tab) }
            else { withAnimation(.snappy(duration: 0.24)) { PopupNav.shared.show(tab) } }
        } label: {
            HStack(spacing: 8) {
                icon.frame(width: 16)
                Text(verbatim: text).font(.popup(11)).foregroundStyle(Theme.muted).lineLimit(1).minimumScaleFactor(0.85)
                Spacer(minLength: 0)
                Lucide(.chevronRight, size: 11, color: Theme.subtle)
            }
            .frame(minHeight: 20)
            .padding(.vertical, 2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label + " " + text)
    }
}

/// Mac status and one list of chats, newest first. Answer choices expand inside the waiting row.
struct PopupHomeBand: View {
    @Environment(AppModel.self) private var model
    /// The order as it was when the pointer entered the list, so a row does not jump under it.
    @State private var frozenOrder: [SessionKey]?

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            PopupMacStrip()
            list
        }
        .onHover { frozenOrder = $0 ? rows.map(\.key) : nil }
    }

    /// Active chats (not idle for over a day), pinned first, then newest first by last activity.
    private var rows: [HostSession] {
        let now = Date()
        let live = model.visibleSessions.filter { !SessionGrouping.isEarlier($0, now: now) }.sorted(by: HomeProjects.before)
        let ordered = live.filter { model.pinned.contains($0.key) } + live.filter { !model.pinned.contains($0.key) }
        guard let frozen = frozenOrder else { return ordered }
        let byKey = Dictionary(uniqueKeysWithValues: ordered.map { ($0.key, $0) })
        let kept = frozen.compactMap { byKey[$0] }
        return kept + ordered.filter { !frozen.contains($0.key) }
    }

    @ViewBuilder private var list: some View {
        if model.sessions.isEmpty {
            SessionEmptyView()
        } else if model.isSearching {
            searchResults
        } else {
            let rows = rows
            VStack(alignment: .leading, spacing: 0) {
                if rows.isEmpty { nothingHappening }
                VStack(spacing: 2) {
                    ForEach(rows) { s in
                        row(s).squeakContextMenu {
                            Button(model.pinned.contains(s.key) ? "Unpin" : "Pin to top") { model.togglePin(s.key) }
                        }
                    }
                }
                .padding(.vertical, 6)
            }
        }
    }

    @ViewBuilder private func row(_ s: HostSession) -> some View {
        let mark = model.mark(for: s)
        if mark?.kind == .waiting {
            PopupAskCard(session: s)
        } else {
            PopupSessionCard(session: s, detail: s.state == .working ? nil : model.menuReplyPreviews[s.key])
        }
    }

    private var nothingHappening: some View {
        VStack(spacing: 4) {
            Text("Nothing is happening.").font(.popup(13, .semibold)).foregroundStyle(Theme.ink)
            Text("Start a chat, or open one from Conductor.").font(.popup(12.5)).foregroundStyle(Theme.muted)
        }
        .frame(maxWidth: .infinity).padding(.vertical, 28)
        .accessibilityElement(children: .combine)
    }

    private var searchResults: some View {
        let hits = model.searchHits
        return Group {
            if hits.isEmpty {
                EmptyStateView(symbol: .search, title: "No matches", message: "Search looks at titles and messages Squeak has already opened on this Mac.")
                    .frame(maxWidth: .infinity).padding(.vertical, 20)
            } else {
                VStack(spacing: 2) {
                    ForEach(hits, id: \.key) { hit in
                        if let s = model.session(hit.key) {
                            PopupSessionCard(session: s, detail: hit.titleMatch ? nil : hit.snippet)
                        }
                    }
                }
                .padding(.vertical, 10)
            }
        }
    }
}

// MARK: Cards

/// A compact row uses the workbench's type and trailing mark, with project/worktree context.
/// Waiting chats share this row and disclose their answer choices in place.
struct PopupChatLabel: View {
    @Environment(AppModel.self) private var model
    let session: HostSession
    var detail: String?
    var disclosure: Bool? = nil

    var body: some View {
        let mark = model.mark(for: session)
        HStack(alignment: .top, spacing: 9) {
            AgentAvatar(session: session, size: 16).padding(.top, 2)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(verbatim: SessionText.headline(session))
                        .font(.popup(13, mark?.kind == .unread ? .semibold : .medium))
                        .foregroundStyle(Theme.ink).lineLimit(1)
                    if session.showsConductorBadge { ConductorMarker(size: 11) }
                    Spacer(minLength: 2)
                    MarkSlot(mark: mark, age: session.lastActivityAt)
                    if let disclosure {
                        Lucide(disclosure ? .chevronDown : .chevronRight, size: 11, color: Theme.subtle)
                    }
                }
                Text(verbatim: context).font(.popup(11)).foregroundStyle(Theme.muted).lineLimit(1)
                if let detail, !detail.isEmpty {
                    Text(verbatim: detail).font(.popup(12)).foregroundStyle(Theme.muted).lineLimit(1)
                }
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    private var context: String {
        [session.repoName, session.branch, SessionText.agent(session.agent)]
            .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
    }
}

struct PopupSessionCard: View {
    @Environment(AppModel.self) private var model
    let session: HostSession
    var detail: String?
    @State private var hovered = false

    var body: some View {
        let preview = detail ?? (session.state == .working ? model.liveStep(session.key) : nil)
        Button { PopupNav.shared.openSession(session.key) } label: {
            PopupChatLabel(session: session, detail: preview)
                .background(hovered ? Theme.selected.opacity(0.6) : .clear, in: RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(.plain)
        .onHover { hovered = $0 }
        .accessibilityElement(children: .ignore)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel([SessionText.accessibility(title: SessionText.headline(session), mark: model.mark(for: session), last: session.lastActivityAt), SessionText.secondLine(session), preview ?? ""].filter { !$0.isEmpty }.joined(separator: ", "))
    }
}

/// An answer expands only on request, keeping the activity list compact. Expanding never sends;
/// only pressing an option sends its letter through the existing delivery path.
struct PopupAskCard: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let session: HostSession
    @State private var expanded = false
    @State private var hovered = false
    @State private var sending: String?
    @State private var note: String?

    var body: some View {
        let choices = model.choices(for: session.key)
        let question = model.question(for: session.key)
        VStack(alignment: .leading, spacing: 0) {
            Button {
                if choices.isEmpty { PopupNav.shared.openSession(session.key) }
                else if reduceMotion { expanded.toggle() }
                else { withAnimation(.easeInOut(duration: 0.18)) { expanded.toggle() } }
            } label: {
                PopupChatLabel(session: session, detail: expanded ? nil : question,
                               disclosure: choices.isEmpty ? nil : expanded)
            }
            .buttonStyle(.plain)
            .accessibilityLabel(SessionText.accessibility(title: SessionText.headline(session), mark: model.mark(for: session), last: session.lastActivityAt) + (question.map { ", " + $0 } ?? ""))
            .accessibilityValue(choices.isEmpty ? "" : expanded ? "Expanded" : "Collapsed")
            .accessibilityHint(choices.isEmpty ? "Opens chat" : "Shows or hides answer choices")
            if expanded {
                VStack(alignment: .leading, spacing: 6) {
                    if let question, !question.isEmpty {
                        Text(verbatim: question).font(.popup(12)).foregroundStyle(Theme.ink)
                            .fixedSize(horizontal: false, vertical: true).padding(.bottom, 3)
                    }
                    ForEach(choices, id: \.letter) { choice in
                        PopupOptionRow(choice: choice, busy: sending == choice.letter) { send(choice) }
                            .disabled(sending != nil || !model.canSend(session))
                    }
                    HStack {
                        if let note { Text(verbatim: note).font(.popup(11)).foregroundStyle(Theme.muted) }
                        Spacer(minLength: 0)
                        Button("Open chat") { PopupNav.shared.openSession(session.key) }
                            .buttonStyle(.plain).font(.popup(11)).foregroundStyle(Theme.muted)
                    }
                    .padding(.top, 3)
                }
                .padding(.leading, 33).padding(.trailing, 8).padding(.bottom, 10)
            }
        }
        .background(expanded ? Theme.surfaceRaised : hovered ? Theme.selected.opacity(0.6) : .clear,
                    in: RoundedRectangle(cornerRadius: 6))
        .onHover { hovered = $0 }
        .accessibilityElement(children: .contain)
    }

    private func send(_ choice: Choice) {
        sending = choice.letter
        note = nil
        Task {
            let result = await model.send(choice.letter, to: session.key, answering: true)
            sending = nil
            switch result {
            case .accepted: note = "Sent \(choice.letter)"
            case .none: break
            default: note = "Not sent. Open the chat to answer."
            }
        }
    }
}

/// One explicit answer action: a small letter key and its label.
struct PopupOptionRow: View {
    enum Size { case compact, large }
    let choice: Choice
    var busy = false
    var size: Size = .compact
    let action: () -> Void

    var body: some View {
        let large = size == .large
        Button(action: action) {
            HStack(spacing: large ? 12 : 8) {
                Text(choice.letter).font(.popup(large ? 12 : 11, .medium)).foregroundStyle(Theme.muted)
                    .frame(width: large ? 24 : 20, height: large ? 24 : 20)
                    .background(Theme.selected, in: RoundedRectangle(cornerRadius: 5))
                Text(verbatim: choice.label).font(.popup(large ? 13 : 12, .regular)).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 0)
                if busy { ProgressView().controlSize(.mini).accessibilityLabel("Sending answer") }
            }
            .padding(.horizontal, large ? 12 : 8)
            .frame(maxWidth: .infinity, minHeight: large ? 40 : 28)
            .popupCard(radius: 6, fill: busy ? 0.08 : 0.025, stroke: 0.08)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Answer \(choice.letter): \(choice.label)")
    }
}

// MARK: Footer

/// Always-visible handoff to the full app, plus the existing quick composer.
struct PopupHomeFooter: View {
    @Environment(AppModel.self) private var model
    let dismiss: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            PopupDivider()
            HStack(spacing: 8) {
                Button { dismiss(); model.showConversationWindow() } label: {
                    HStack(spacing: 7) {
                        Lucide(.externalLink, size: 14, color: Theme.ink)
                        Text("Open Squeak").font(.popup(12, .medium)).foregroundStyle(Theme.ink)
                    }
                    .frame(height: 30).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                Spacer(minLength: 0)
                Button { dismiss(); QuickComposerController.shared.show(fromPopup: true) } label: {
                    HStack(spacing: 6) {
                        PopupSymbol(name: "bubble.left", size: 14, color: Theme.muted)
                        Text("Quick message").font(.popup(11)).foregroundStyle(Theme.muted)
                        if let shortcut = quickShortcut {
                            Text(shortcut.keycap).font(.popup(10)).foregroundStyle(Theme.subtle)
                                .help(shortcut.title).accessibilityLabel(shortcut.title)
                        }
                    }
                    .frame(height: 30).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 4).padding(.vertical, 6)
        }
    }

    private var quickShortcut: HotKeyPreset? {
        guard model.hotKeyID != nil, HotKeyCenter.shared.registrationError == nil else { return nil }
        return HotKeyCenter.shared.activePreset
    }
}
