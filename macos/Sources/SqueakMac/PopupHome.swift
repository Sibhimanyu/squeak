import SqueakIcons
import SqueakMacCore
import SwiftUI

// MARK: Tab bar

/// Home | Usage | Controls: a bordered track, the selected tab a raised pill.
struct PopupTabBar: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let nav = PopupNav.shared
    var selected: PopupNav.Tab
    var namespace: Namespace.ID

    var body: some View {
        HStack(spacing: 2) {
            ForEach(Array(PopupNav.Tab.allCases.enumerated()), id: \.element) { i, tab in
                let on = tab == selected
                Button {
                    if reduceMotion {
                        nav.show(tab)
                    } else {
                        withAnimation(.snappy(duration: 0.24)) { nav.show(tab) }
                    }
                } label: {
                    HStack(spacing: 5) {
                        icon(tab, on: on)
                        Text(tab.title).font(.popup(11, on ? .semibold : .regular)).foregroundStyle(on ? Theme.ink : Theme.muted).lineLimit(1).minimumScaleFactor(0.8)
                    }
                    .padding(.horizontal, 5)
                    .frame(height: 28)
                    .frame(maxWidth: .infinity)
                    .background {
                        if on {
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .fill(Theme.selectedStrong)
                                .matchedGeometryEffect(id: "popup-selected-tab", in: namespace)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityAddTraits(on ? .isSelected : [])
                .accessibilityLabel(tab.title)
            }
        }
        .padding(2.5)
        .frame(height: 30)
        .background(RoundedRectangle(cornerRadius: 11, style: .continuous).fill(Color.wash(0.025)))
    }

    @ViewBuilder private func icon(_ tab: PopupNav.Tab, on: Bool) -> some View {
        let color = on ? Theme.ink : Theme.muted
        switch tab {
        case .home: Lucide(.house, size: 14, color: color)
        case .usage: PopupBarsGlyph(size: 14, color: color)
        case .controls: Lucide(.settings, size: 14, color: color)
        }
    }
}

// MARK: Header

/// The top of every tab screen: a leading title (or the Home summary) and trailing controls, then the tab bar.
struct PopupTabHeader<Leading: View, Trailing: View>: View {
    var selected: PopupNav.Tab
    var namespace: Namespace.ID
    @ViewBuilder var leading: Leading
    @ViewBuilder var trailing: Trailing

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                leading
                Spacer(minLength: 8)
                trailing
            }
            .frame(minHeight: 32)
            .padding(.top, 12)
            .padding(.bottom, 13)
            PopupTabBar(selected: selected, namespace: namespace)
                .padding(.bottom, 12)
        }
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
        Menu {
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
            Lucide(.ellipsis, size: 14, label: "More", color: Theme.ink).frame(width: 28, height: 26)
                .background(RoundedRectangle(cornerRadius: PopupMetrics.controlRadius, style: .continuous).fill(Color.wash(0.07)))
                .overlay(RoundedRectangle(cornerRadius: PopupMetrics.controlRadius, style: .continuous).strokeBorder(Color.wash(0.12)))
                .contentShape(Rectangle())
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .accessibilityLabel("More options")
    }
}

// MARK: Home

struct PopupHomeTop: View {
    @Environment(AppModel.self) private var model
    @Binding var searching: Bool
    let dismiss: () -> Void
    var namespace: Namespace.ID

    var body: some View {
        @Bindable var model = model
        let total = model.visibleSessions.filter { !SessionGrouping.isEarlier($0, now: Date()) }.count
        VStack(spacing: 0) {
            PopupTabHeader(selected: .home, namespace: namespace) {
                HStack(spacing: 12) {
                    Circle().fill(model.isConnected ? Theme.done : Theme.offline).frame(width: 8, height: 8).padding(.leading, 2)
                        .accessibilityHidden(true)
                    Text(model.health != nil && !model.isConnected
                         ? model.connectionTitle
                         : "\(total) \(total == 1 ? "chat" : "chats")")
                        .font(.popup(14, .semibold)).foregroundStyle(Theme.ink).lineLimit(1).minimumScaleFactor(0.85)
                        .accessibilityLabel(model.isConnected ? "Connected, \(total) \(total == 1 ? "chat" : "chats")" : "Connection: \(model.connectionTitle)")
                }
            } trailing: {
                Button { PopupNav.shared.openNewChat() } label: { Text("New chat") }
                    .buttonStyle(PopupButtonStyle(height: 26, hPad: 13, size: 12.5))
                PopupMoreMenu(searching: $searching, isHome: true, dismiss: dismiss)
            }
            if searching {
                SearchField(text: $model.query)
                    .padding(.bottom, 12)
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
                UpdateBanner(updater: updater)
                if let note = model.updateNote { updateRow(note, action: "Dismiss") { model.dismissUpdateNote() } }
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

/// The Mac strip: the awake line and the usage line in one card. Each opens its tab.
struct PopupMacStrip: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let awakeLine = model.panelAwakeLine
        let usageLine = model.panelUsageLine?.replacingOccurrences(of: " · ", with: " • ")
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
                Lucide(.chevronRight, size: 14, color: Theme.muted)
            }
            .padding(.horizontal, 14).padding(.vertical, 4)
            .popupCard()
            .padding(.bottom, 12)
        }
    }

    private func stripRow(icon: some View, text: String, tab: PopupNav.Tab, label: String) -> some View {
        Button {
            if reduceMotion { PopupNav.shared.show(tab) }
            else { withAnimation(.snappy(duration: 0.24)) { PopupNav.shared.show(tab) } }
        } label: {
            HStack(spacing: 14) {
                icon.frame(width: 22)
                Text(verbatim: text).font(.popup(13)).foregroundStyle(Theme.ink).lineLimit(1).minimumScaleFactor(0.85)
                Spacer(minLength: 0)
            }
            .frame(minHeight: 24)
            .padding(.vertical, 2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label + " " + text)
    }
}

/// The Home band: the Mac strip, then one list of chats, newest first, each with its mark in the age's place
/// (§8.2). No sections and no strip for what waits: a chat waiting on you opens as its answer card in the list.
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
                PopupDivider()
                VStack(spacing: 5) {
                    ForEach(rows) { s in
                        row(s).contextMenu {
                            Button(model.pinned.contains(s.key) ? "Unpin" : "Pin to top") { model.togglePin(s.key) }
                        }
                    }
                }
                .padding(.vertical, 8)
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
                VStack(spacing: 7) {
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

/// A chat in the menu (§8.2): a bordered card with the title, `repo · agent`, and one more line (the agent's newest
/// step, or the start of its reply). The trailing slot is the age, or in its place the chat's one mark. Tapping
/// opens it in the popup.
struct PopupSessionCard: View {
    @Environment(AppModel.self) private var model
    let session: HostSession
    var detail: String?
    @State private var hovered = false

    var body: some View {
        let mark = model.mark(for: session)
        let loud = mark?.kind == .unread
        let third = detail ?? (session.state == .working ? model.liveStep(session.key) : nil)
        Button { PopupNav.shared.openSession(session.key) } label: {
            HStack(alignment: .top, spacing: 12) {
                AgentAvatar(session: session, size: 18)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(verbatim: SessionText.headline(session)).font(.popup(13, loud ? .bold : .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                        if session.showsConductorBadge { ConductorMarker(size: 13) }
                        Spacer(minLength: 4)
                        MarkSlot(mark: mark, age: session.lastActivityAt)
                    }
                    Text(verbatim: SessionText.secondLine(session)).font(.popup(12.5)).foregroundStyle(Theme.muted).lineLimit(1)
                    if let third, !third.isEmpty {
                        Text(verbatim: third).font(.popup(12.5)).foregroundStyle(Theme.muted).lineLimit(1).padding(.top, 1)
                    }
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 7)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(Color.wash(hovered ? 0.08 : 0.025)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovered = $0 }
        .accessibilityElement(children: .combine)
        .accessibilityLabel([SessionText.accessibility(title: SessionText.headline(session), mark: mark, last: session.lastActivityAt), third ?? ""].filter { !$0.isEmpty }.joined(separator: ", "))
    }
}

/// A chat waiting on you: a red capsule down its left edge, the title and age, `repo · agent`, the
/// agent's question and its lettered options as one-tap rows. An option sends just its letter, to the
/// chat's current turn, and only when tapped.
struct PopupAskCard: View {
    @Environment(AppModel.self) private var model
    let session: HostSession
    @State private var sending: String?
    @State private var note: String?

    var body: some View {
        let choices = Array(model.choices(for: session.key).prefix(4))
        HStack(alignment: .top, spacing: 11) {
            Capsule().fill(ChatMark.waitingKind(session) == .answer ? Theme.subtle : Theme.warning).frame(width: 4.5).padding(.vertical, 1).accessibilityHidden(true)
            AgentAvatar(session: session, size: 18).padding(.top, 1)
            VStack(alignment: .leading, spacing: 6) {
                Button { PopupNav.shared.openSession(session.key) } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(alignment: .firstTextBaseline, spacing: 6) {
                            Text(verbatim: SessionText.headline(session)).font(.popup(14, .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                            Spacer(minLength: 4)
                            RelativeTimeText(session.lastActivityAt, size: 11.5)
                        }
                        Text(verbatim: SessionText.secondLine(session)).font(.popup(12.5)).foregroundStyle(Theme.muted).lineLimit(1)
                        if let q = model.question(for: session.key), !q.isEmpty {
                            Text(verbatim: q).font(.popup(12.5)).foregroundStyle(Theme.ink).lineLimit(3)
                                .multilineTextAlignment(.leading).padding(.top, 3)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if !choices.isEmpty {
                    VStack(spacing: 4) {
                        ForEach(choices, id: \.letter) { c in PopupOptionRow(choice: c, busy: sending == c.letter, size: .compact) { send(c) }
                            .disabled(sending != nil)
                        }
                    }
                }
                if let note { Text(verbatim: note).font(.popup(11.5)).foregroundStyle(Theme.muted).lineLimit(2) }
            }
        }
        .padding(.leading, 9).padding(.trailing, 9).padding(.vertical, 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .popupCard()
        .accessibilityElement(children: .contain)
    }

    private func send(_ c: Choice) {
        sending = c.letter
        note = nil
        Task {
            let result = await model.send(c.letter, to: session.key, answering: true)
            sending = nil
            switch result {
            case .accepted: note = "Sent \(c.letter)"
            case .none: break
            default: note = "Not sent. Open the chat to answer."
            }
        }
    }
}

/// One lettered option: a letter in a circle and its label, as a row.
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
                Text(choice.letter).font(.popup(large ? 14 : 12, .semibold)).foregroundStyle(Theme.ink)
                    .frame(width: large ? 28 : 20, height: large ? 28 : 20)
                    .background(Circle().fill(Color.wash(0.10)))
                Text(verbatim: choice.label).font(.popup(large ? 14 : 12.5, large ? .semibold : .regular)).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true)
                    .multilineTextAlignment(.leading)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, large ? 12 : 8)
            .frame(maxWidth: .infinity, minHeight: large ? 40 : 28)
            .popupCard(radius: large ? 11 : 8, fill: busy ? 0.12 : 0.06, stroke: 0.09)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Answer \(choice.letter): \(choice.label)")
    }
}

// MARK: Footer

/// Quick message (⌘K) and Open Squeak, pinned under the band.
struct PopupHomeFooter: View {
    @Environment(AppModel.self) private var model
    let dismiss: () -> Void

    var body: some View {
        VStack(spacing: 0) {
            PopupDivider()
            HStack(spacing: 10) {
                Button { dismiss(); QuickComposerController.shared.show(fromPopup: true) } label: {
                    HStack(spacing: 8) {
                        PopupSymbol(name: "bubble.left", size: 14, color: Theme.muted)
                        Text("Quick message").font(.popup(13)).foregroundStyle(Theme.muted).lineLimit(1).fixedSize()
                        Spacer(minLength: 4)
                        Text("⌘ K").font(.popup(11.5)).foregroundStyle(Theme.muted)
                            .padding(.horizontal, 7).frame(height: 24)
                            .background(RoundedRectangle(cornerRadius: 6, style: .continuous).fill(Color.wash(0.07)))
                            .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(Color.wash(0.10)))
                    }
                    .padding(.horizontal, 10)
                    .frame(maxWidth: .infinity).frame(height: 28)
                    .popupCard(radius: 9, fill: 0.03, stroke: 0.11)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .keyboardShortcut("k")
                .accessibilityLabel("Quick message")
                Button { dismiss(); model.showConversationWindow() } label: { Text("Open Squeak") }
                    .buttonStyle(PopupButtonStyle(radius: 9, height: 28, hPad: 14, size: 13))
                    .fixedSize()
            }
            .padding(.top, 12).padding(.bottom, 12)
        }
    }
}
