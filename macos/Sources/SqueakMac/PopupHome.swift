import SqueakIcons
import SqueakMacCore
import SwiftUI

// MARK: Tab bar

/// Home | Needs you (red count) | Usage | Controls: a bordered track, the selected tab a raised pill.
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
                        if tab != .needsYou { icon(tab, on: on) }
                        Text(tab == .needsYou ? "Needs you" : tab.title).font(.popup(11, on ? .semibold : .regular)).foregroundStyle(on ? Theme.ink : Theme.muted).lineLimit(1).minimumScaleFactor(0.8)
                        if tab == .needsYou, needs > 0 { PopupBadge(count: needs) }
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
                .accessibilityLabel(tab == .needsYou && needs > 0 ? "Needs you, \(needs)" : tab.title)
            }
        }
        .padding(2.5)
        .frame(height: 30)
        .background(RoundedRectangle(cornerRadius: 11, style: .continuous).fill(Color.wash(0.025)))
    }

    private var needs: Int { model.grouped.first(where: { $0.kind == .needsYou })?.sessions.count ?? 0 }

    @ViewBuilder private func icon(_ tab: PopupNav.Tab, on: Bool) -> some View {
        let color = on ? Theme.ink : Theme.muted
        switch tab {
        case .home: Lucide(.house, size: 14, color: color)
        case .needsYou: Lucide(.circleAlert, size: 14, color: color)
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
        let working = model.grouped.first(where: { $0.kind == .working })?.sessions.count ?? 0
        let total = model.visibleSessions.count
        VStack(spacing: 0) {
            PopupTabHeader(selected: .home, namespace: namespace) {
                HStack(spacing: 12) {
                    Circle().fill(model.isConnected ? Theme.done : Theme.offline).frame(width: 8, height: 8).padding(.leading, 2)
                        .accessibilityHidden(true)
                    Text(model.health != nil && !model.isConnected
                         ? model.connectionTitle
                         : "\(total) \(total == 1 ? "session" : "sessions") · \(working) working")
                        .font(.popup(14, .semibold)).foregroundStyle(Theme.ink).lineLimit(1).minimumScaleFactor(0.85)
                        .accessibilityLabel(model.isConnected ? "Connected, \(total) sessions, \(working) working" : "Connection: \(model.connectionTitle)")
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

    @ViewBuilder private var banners: some View {
        let showHelp = model.health != nil && model.connectionHelp != nil
        let updater = model.updater
        let showUpdate = updater.flow.phase != .idle || model.updateNote != nil
        if showHelp || model.launchOfferPending || showUpdate || model.tips.tip != nil {
            VStack(alignment: .leading, spacing: 4) {
                UpdateBanner(updater: updater)
                if let note = model.updateNote { updateRow(note, action: "Dismiss") { model.dismissUpdateNote() } }
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

/// The Home band: Mac strip, then Needs you, Errors, Working, Finished and Idle.
struct PopupHomeBand: View {
    @Environment(AppModel.self) private var model
    @State private var needsOpen = true
    @State private var workingOpen = true
    @State private var doneOpen = false
    @State private var idleOpen = false
    /// Each section's order as it was when the pointer entered the list, so a row does not jump under it.
    @State private var frozenOrder: [SessionSectionKind: [SessionKey]]?
    var onlyNeedsYou = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            if !onlyNeedsYou { PopupMacStrip() }
            list
        }
        .onHover { setHovering($0) }
    }

    private var sections: [PopupSection] {
        let live = model.grouped
        let order: [SessionSectionKind] = onlyNeedsYou ? [.needsYou] : [.needsYou, .error, .working, .done, .idle]
        guard let frozen = frozenOrder else {
            return order.compactMap { kind in live.first(where: { $0.kind == kind }).map { PopupSection(kind: kind, sessions: $0.sessions) } }
        }
        let liveByKey = Dictionary(uniqueKeysWithValues: live.flatMap(\.sessions).map { ($0.key, $0) })
        let frozenKeys = Set(frozen.values.flatMap { $0 })
        return order.compactMap { kind in
            let kept = (frozen[kind] ?? []).compactMap { liveByKey[$0] }
            let joined = (live.first(where: { $0.kind == kind })?.sessions ?? []).filter { !frozenKeys.contains($0.key) }
            let rows = kept + joined
            return rows.isEmpty ? nil : PopupSection(kind: kind, sessions: rows)
        }
    }

    private func setHovering(_ hovering: Bool) {
        frozenOrder = hovering ? Dictionary(uniqueKeysWithValues: model.grouped.map { ($0.kind, $0.sessions.map(\.key)) }) : nil
    }

    @ViewBuilder private var list: some View {
        if model.sessions.isEmpty {
            emptyState
        } else if model.isSearching {
            searchResults
        } else {
            let sections = sections
            VStack(alignment: .leading, spacing: 0) {
                if sections.isEmpty { allQuiet }
                ForEach(sections) { section in
                    PopupDivider()
                    sectionView(section)
                }
            }
        }
    }

    @ViewBuilder private var emptyState: some View {
        SessionEmptyView()
    }

    private var allQuiet: some View {
        VStack(spacing: 4) {
            Text("All quiet").font(.popup(13, .semibold)).foregroundStyle(Theme.ink)
            Text("Nothing needs you right now.").font(.popup(12.5)).foregroundStyle(Theme.muted)
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
                            PopupSessionCard(session: s, detail: hit.titleMatch ? nil : hit.snippet, showTime: true)
                        }
                    }
                }
                .padding(.vertical, 10)
            }
        }
    }

    @ViewBuilder private func sectionView(_ section: PopupSection) -> some View {
        let n = section.sessions.count
        switch section.kind {
        case .needsYou:
            PopupSectionHeader(title: "Needs you", count: n, color: Theme.needsYou, expanded: $needsOpen)
            if needsOpen { cards(section.sessions) { PopupAskCard(session: $0) } }
        case .error:
            PopupSectionHeader(title: "Errors", count: n, color: Theme.error, expanded: nil)
            cards(section.sessions) { PopupSessionCard(session: $0, detail: model.menuReplyPreviews[$0.key], showTime: true) }
        case .working:
            PopupSectionHeader(title: "Working", count: n, color: Theme.working, expanded: $workingOpen)
            if workingOpen { cards(section.sessions) { PopupSessionCard(session: $0) } }
        case .done:
            let unread = section.sessions.filter { model.hasUnreadUpdate(for: $0.key) }.count
            PopupSectionHeader(title: "Finished", count: n, color: Theme.done, expanded: $doneOpen, countText: unread > 0 ? "\(n) finished · \(unread) new" : "\(n) finished", compact: true)
            if doneOpen {
                cards(section.sessions) {
                    PopupSessionCard(session: $0, detail: model.menuReplyPreviews[$0.key], showTime: true, unread: model.hasUnreadUpdate(for: $0.key))
                }
            }
        case .idle:
            PopupSectionHeader(title: "Idle", count: n, color: Theme.idle, expanded: $idleOpen, countText: "\(n) idle", compact: true)
            if idleOpen { cards(section.sessions) { PopupSessionCard(session: $0, showTime: true) } }
        }
    }

    private func cards<C: View>(_ sessions: [HostSession], @ViewBuilder _ card: @escaping (HostSession) -> C) -> some View {
        VStack(spacing: 5) {
            ForEach(sessions) { s in
                card(s).contextMenu {
                    Button(model.pinned.contains(s.key) ? "Unpin" : "Pin to top") { model.togglePin(s.key) }
                }
            }
        }
        .padding(.bottom, 12)
    }
}

private struct PopupSection: Identifiable {
    let kind: SessionSectionKind
    var sessions: [HostSession]
    var id: String { kind.rawValue }
}

/// A section's heading: a coloured dot, the title, its count and a chevron. Needs you and Working fold
/// (chevron down when open); Finished and Idle say "N finished" and open to the right.
struct PopupSectionHeader: View {
    let title: String
    let count: Int
    let color: Color
    var expanded: Binding<Bool>?
    var countText: String?
    var compact = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Button { withAnimation(reduceMotion ? nil : .easeOut(duration: 0.15)) { expanded?.wrappedValue.toggle() } } label: {
            HStack(spacing: 12) {
                Circle().fill(color).frame(width: 8, height: 8).accessibilityHidden(true)
                Text(title).font(.popup(14, .semibold)).foregroundStyle(Theme.ink)
                if compact {
                    Spacer(minLength: 8)
                    Text(verbatim: countText ?? "\(count)").font(.popup(12.5)).foregroundStyle(Theme.muted)
                } else {
                    Text("\(count)").font(.popup(12.5)).monospacedDigit().foregroundStyle(Theme.muted).padding(.leading, -2)
                    Spacer(minLength: 8)
                }
                if let expanded {
                    Lucide(expanded.wrappedValue ? .chevronDown : .chevronRight, size: 14, color: Theme.muted)
                }
            }
            .frame(height: 34)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(expanded == nil)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
        .accessibilityValue(expanded.map { $0.wrappedValue ? "expanded" : "collapsed" } ?? "")
    }
}

// MARK: Cards

/// A working, finished or errored session: a bordered card with a state dot, the title, `repo · agent` and
/// one more line (the agent's newest step, or the start of its reply). Tapping opens it in the popup.
struct PopupSessionCard: View {
    @Environment(AppModel.self) private var model
    let session: HostSession
    var detail: String?
    var showTime = false
    var unread = false
    @State private var hovered = false

    var body: some View {
        let third = detail ?? (session.state == .working ? model.liveStep(session.key) : nil)
        Button { PopupNav.shared.openSession(session.key) } label: {
            HStack(alignment: .top, spacing: 12) {
                Circle().fill(Theme.color(for: session.state)).frame(width: 8, height: 8).padding(.top, 4).accessibilityHidden(true)
                AgentAvatar(session: session, size: 18)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(verbatim: SessionText.headline(session)).font(.popup(13, .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                        Spacer(minLength: 4)
                        if unread { Text("New").font(.popup(11.5, .medium)).foregroundStyle(Theme.done) }
                        if showTime { RelativeTimeText(session.lastActivityAt, size: 11.5) }
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
        .accessibilityLabel([SessionText.headline(session), SessionText.secondLine(session), SessionText.stateWord(session), third ?? ""].filter { !$0.isEmpty }.joined(separator: ", "))
    }
}

/// A session that needs you: a red capsule down its left edge, the title and age, `repo · agent`, the
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
            Capsule().fill(Theme.needsYou).frame(width: 4.5).padding(.vertical, 1).accessibilityHidden(true)
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
