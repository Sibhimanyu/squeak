#if os(iOS)
import Observation
import SqueakCore
import SqueakIcons
import SwiftUI

enum AppTab: String, Hashable { case ponds, inbox, search, mac }

/// Which tab is up and where each tab's stack has gone. One object so a link, a launch flag or a swipe's Reply can
/// move any of them.
@MainActor @Observable
final class AppNav {
    var tab: AppTab = .ponds
    var ponds: [HomeRoute] = []
    var inbox: [HomeRoute] = []
    var search: [HomeRoute] = []
    /// The chat a launch flag's Reply sheet is for.
    var quickReply: PhoneSnapshot.Session?

    var current: [HomeRoute] {
        get { switch tab { case .ponds: ponds; case .inbox: inbox; case .search: search; case .mac: [] } }
        set { switch tab { case .ponds: ponds = newValue; case .inbox: inbox = newValue; case .search: search = newValue; case .mac: break } }
    }

    /// A chat opened on a fresh Ponds stack, so Back leads to the list.
    func open(session key: String) {
        tab = .ponds
        ponds = [.session(key)]
    }

    /// `-squeak-*` flags (screenshots of the demo, probes): start on a tab, in a pond, stream or chat.
    func applyLaunchFlags(model: AppModel) {
        let args = ProcessInfo.processInfo.arguments
        func value(_ flag: String) -> String? {
            guard let i = args.firstIndex(of: flag), i + 1 < args.count else { return nil }
            return args[i + 1]
        }
        if let raw = value("-squeak-home-tab"), let tab = AppTab(rawValue: raw) { self.tab = tab }
        if args.contains("-squeak-settings") || args.contains("-squeak-controls") || args.contains("-squeak-usage") { tab = .mac }
        if let id = value("-squeak-film") ?? value("-squeak-open-film") { tab = .ponds; ponds = [.film(id)] }
        if let key = value("-squeak-open") { tab = .ponds; ponds = [.session(key)] }
        if let name = value("-squeak-pond") ?? value("-squeak-project") { tab = .ponds; ponds = [.pond(name)] }
        if let both = value("-squeak-open-stream") {
            let parts = both.split(separator: ":", maxSplits: 1).map(String.init)
            if parts.count == 2 { tab = .ponds; ponds = [.pond(parts[0]), .stream(parts[0], parts[1])] }
        }
        if let raw = value("-squeak-scope"), let scope = PondScope(rawValue: raw), let name = value("-squeak-pond") ?? value("-squeak-project") {
            tab = .ponds; ponds = [.pond(name), .scope(name, scope)]
        }
        if let raw = value("-squeak-filter"), let filter = Presentation.Filter(rawValue: raw) { tab = .inbox; inbox = [.status(filter)] }
        if args.contains("-squeak-earlier") { tab = .ponds; ponds = [.recent] }
        if let key = value("-squeak-quick") { quickReply = model.snapshot?.session(key) }
        if let key = value("-squeak-rename") { model.renameTarget = model.snapshot?.session(key) }
    }
}

/// The paired app (DESIGN.md: pond-first): Ponds, Inbox, Search and Mac, each its own stack.
struct AppTabs: View {
    @Environment(AppModel.self) private var model
    @ObservedObject private var router = SqueakRouter.shared
    @State private var nav = AppNav()
    var onMainScreen: (() -> Void)?
    /// An app hosting this view as one of its own tabs gets the Ponds stack alone, with no bar of its own.
    var embedded = false

    private var needsYou: Int { NeedsYou.count(sessions: model.home.sessions, films: model.home.films) }

    var body: some View {
        Group { if embedded { PondsTab(nav: nav, embedded: true) } else { tabs } }
        .onAppear { nav.applyLaunchFlags(model: model); onMainScreen?() }
        .onChange(of: nav.ponds) { _, new in follow(new) }
        .onChange(of: nav.inbox) { _, new in follow(new) }
        .onChange(of: nav.search) { _, new in follow(new) }
        .sheet(item: $nav.quickReply) { QuickReply(session: $0) }
        // A tapped notification or link: the chat is on its way while the Mac's first view (which has it) loads.
        .overlay(alignment: .top) {
            if router.pendingSessionId != nil, model.freshSnapshotAt == nil {
                LoadingLine("Opening your chat…").frame(maxWidth: .infinity).padding(.vertical, 8).background(Theme.bg)
            }
        }
        // A link from a Telegram card: open its session as soon as the snapshot has it.
        .onChange(of: router.pendingSessionId, initial: true) { _, _ in openPending() }
        .onChange(of: model.home) { _, _ in openPending() }
        .task { await debugProbes() }
    }

    @ViewBuilder private var tabs: some View {
        if #available(iOS 18, *) { modernTabs } else { classicTabs }
    }

    /// iOS 18: the `Tab` API, with Search as the system's separated search tab.
    @available(iOS 18, *)
    private var modernTabs: some View {
        TabView(selection: $nav.tab) {
            Tab(value: AppTab.ponds) {
                PondsTab(nav: nav)
            } label: {
                Label { Text("Ponds") } icon: { SqueakRootView.tabIcon }
            }
            Tab("Inbox", systemImage: "tray", value: AppTab.inbox) {
                InboxTab(nav: nav).screenName("Inbox")
            }
            .badge(needsYou)
            Tab("Mac", systemImage: "laptopcomputer", value: AppTab.mac) {
                SettingsView(inTab: true).screenName("Mac")
            }
            Tab(value: AppTab.search, role: .search) {
                SearchTab(nav: nav).screenName("Search")
            }
        }
        .tint(Theme.info)
    }

    /// iOS 17: the same four tabs with `tabItem`.
    private var classicTabs: some View {
        TabView(selection: $nav.tab) {
            PondsTab(nav: nav)
                .tabItem { Label { Text("Ponds") } icon: { SqueakRootView.tabIcon } }.tag(AppTab.ponds)
            InboxTab(nav: nav).screenName("Inbox")
                .tabItem { Label("Inbox", systemImage: "tray") }.badge(needsYou).tag(AppTab.inbox)
            SettingsView(inTab: true).screenName("Mac")
                .tabItem { Label("Mac", systemImage: "laptopcomputer") }.tag(AppTab.mac)
            SearchTab(nav: nav).screenName("Search")
                .tabItem { Label("Search", systemImage: "magnifyingglass") }.tag(AppTab.search)
        }
        .tint(Theme.info)
    }

    /// Start following the chat on the tap, not when its screen has finished arriving.
    private func follow(_ path: [HomeRoute]) {
        if case let .session(key) = path.last {
            #if DEBUG
            OpenProbe.begin("open \(key)")
            #endif
            model.watch(key)
        }
    }

    private func openPending() {
        guard let id = router.pendingSessionId,
              let session = (model.home.sessions + model.home.recent).first(where: { $0.handle == id })
        else { return }
        nav.open(session: session.key)
        router.consume()
    }

    private func debugProbes() async {
        #if DEBUG
        let args = ProcessInfo.processInfo.arguments
        // `-squeak-reopen`: leaves the opened chat after 3 s and opens it again after 5 s, to time a chat that has a
        // cached frame (with `-squeak-scroll-trace`).
        if args.contains("-squeak-reopen"), let opened = nav.ponds.first {
            try? await Task.sleep(for: .seconds(3)); nav.ponds = []
            try? await Task.sleep(for: .seconds(2)); nav.ponds = [opened]
        }
        // `-squeak-probe-open <key>` (with `-squeak-project <name>` and `-squeak-open-probe`): taps the chat from the
        // pond page after 2 s, goes back after 6 s and taps it again after 8 s (cold, then warm).
        if let i = args.firstIndex(of: "-squeak-probe-open"), i + 1 < args.count {
            let pond = nav.ponds, chat = HomeRoute.session(args[i + 1])
            try? await Task.sleep(for: .seconds(2)); nav.ponds = pond + [chat]
            try? await Task.sleep(for: .seconds(4)); nav.ponds = pond
            try? await Task.sleep(for: .seconds(2)); nav.ponds = pond + [chat]
        }
        #endif
    }
}

/* ---------- Inbox ---------- */

/// The Mac Dashboard's lanes: Needs you, In progress, Done, Idle, with RasanAI's films above them.
struct InboxTab: View {
    @Environment(AppModel.self) private var model
    @Bindable var nav: AppNav
    @State private var quickReply: PhoneSnapshot.Session?

    var body: some View {
        NavigationStack(path: $nav.inbox) {
            let lanes = PondList.lanes(model.homeLists.visible)
            let films = model.home.films
            List {
                if let starting = model.startingChat { StartingRow(label: starting.label) }
                if !films.isEmpty {
                    Section("Films") { ForEach(films) { FilmListRow(film: $0) } }
                }
                ForEach(lanes, id: \.lane) { lane in
                    Section {
                        ForEach(lane.sessions) { session in
                            NavigationLink(value: HomeRoute.session(session.key)) { SessionRow(session: session) }.tapHaptic(.navigate)
                                .homeRow(needsYou: session.needsYou, edge: MarkGlyph.edge(session))
                                .modifier(SessionSwipe(session: session) { quickReply = session })
                        }
                    } header: {
                        HStack { Text(lane.lane.title); Spacer(); Text("\(lane.sessions.count)").monospacedDigit() }
                    } footer: {
                        if lane.lane == .needsYou {
                            NavigationLink(value: HomeRoute.status(.needsYou)) { Text("Answer them here") }.font(.footnote)
                        }
                    }
                }
                if lanes.isEmpty && films.isEmpty { resting }
                if !model.recentChats.isEmpty {
                    Section {
                        NavigationLink(value: HomeRoute.recent) {
                            Label("Older threads", systemImage: "clock.arrow.circlepath").frame(minHeight: 44)
                        }.tapHaptic(.navigate)
                    }
                }
            }
            .listStyle(.insetGrouped)
            .listSectionSpacing(16)
            .scrollContentBackground(.hidden)
            .background(Theme.bg.ignoresSafeArea())
            .navigationTitle("Inbox")
            .navigationBarTitleDisplayMode(.large)
            .navigationDestination(for: HomeRoute.self) { RouteView(route: $0, path: $nav.inbox) }
            .refreshable { Haptics.play(.refresh); await model.refresh() }
            .overlay(alignment: .bottom) { ConnectionBar() }
            .sheet(item: $quickReply) { QuickReply(session: $0) }
        }
        .foregroundStyle(Theme.ink)
        .navigationHaptic(count: nav.inbox.count)
    }

    private var resting: some View {
        VStack(spacing: 12) {
            Image("duck-asleep", bundle: .module).resizable().scaledToFit().frame(width: 88, height: 88).accessibilityHidden(true)
            Text("Nothing's running. The duck is resting.").foregroundStyle(Theme.muted)
        }
        .frame(maxWidth: .infinity).padding(.vertical, 32)
        .listRowBackground(Color.clear).listRowSeparator(.hidden)
    }
}

/// A film in the Inbox: title, the call it is on, and whether it waits on you.
struct FilmListRow: View {
    let film: PhoneFilm

    private var line: String {
        if film.waitingOnYou { return [film.currentCall, film.card?.prompt].compactMap { $0 }.joined(separator: " · ") }
        if let activity = film.progress?.activity, !activity.isEmpty, film.director.state == "running" { return activity }
        if film.director.state == "finished" { return "The film is finished." }
        return film.currentCall.map { "On the \($0.lowercased())" } ?? (film.director.detail ?? "")
    }

    var body: some View {
        NavigationLink(value: HomeRoute.film(film.id)) {
            HStack(spacing: 12) {
                Image(systemName: "film").foregroundStyle(film.waitingOnYou ? Theme.needsYou : Theme.muted).frame(width: 28)
                VStack(alignment: .leading, spacing: 2) {
                    Text(film.title).font(.headline).lineLimit(1)
                    if !line.isEmpty { Text(line).font(.subheadline).foregroundStyle(Theme.muted).lineLimit(2) }
                }
                Spacer(minLength: 4)
                Text(Age.describe(film.updatedAt)).font(.footnote).foregroundStyle(Theme.subtle).monospacedDigit()
            }
            .frame(minHeight: 44)
        }
        .tapHaptic(.navigate)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Film \(film.title), \(film.stateWord)\(line.isEmpty ? "" : ", \(line)")")
    }
}

/* ---------- Search ---------- */

/// iOS's search tab: threads, streams and ponds by what you type (SmartSearch understands states, agents, days and
/// `project:`), recent searches while it is empty.
struct SearchTab: View {
    @Environment(AppModel.self) private var model
    @Bindable var nav: AppNav
    @State private var query = ""
    @State private var quickReply: PhoneSnapshot.Session?
    @AppStorage("recentSearches") private var recentRaw = ""

    private var recent: [String] { recentRaw.split(separator: "\n").map(String.init) }

    var body: some View {
        NavigationStack(path: $nav.search) {
            List {
                if query.trimmingCharacters(in: .whitespaces).isEmpty { idle } else { results }
            }
            .listStyle(.insetGrouped)
            .listSectionSpacing(16)
            .scrollContentBackground(.hidden)
            .background(Theme.bg.ignoresSafeArea())
            .navigationTitle("Search")
            .searchable(text: $query, prompt: "Threads, streams, ponds")
            .onSubmit(of: .search) { remember() }
            .scrollDismissesKeyboard(.interactively)
            .navigationDestination(for: HomeRoute.self) { RouteView(route: $0, path: $nav.search) }
            .overlay(alignment: .bottom) { ConnectionBar() }
            .sheet(item: $quickReply) { QuickReply(session: $0) }
        }
        .foregroundStyle(Theme.ink)
        .navigationHaptic(count: nav.search.count)
    }

    private func remember() { recentRaw = PondList.remembering(query, in: recent).joined(separator: "\n") }

    @ViewBuilder private var idle: some View {
        if !recent.isEmpty {
            Section {
                ForEach(recent, id: \.self) { text in
                    Button { Haptics.play(.tap); query = text } label: { Label(text, systemImage: "clock").frame(minHeight: 44) }
                }
            } header: {
                HStack { Text("Recent"); Spacer(); Button("Clear") { Haptics.play(.tap); recentRaw = "" }.font(.footnote) }
            }
        }
        Section("Try") {
            ForEach(SmartSearch.chips(sessions: model.homeLists.visible), id: \.id) { chip in
                Button { Haptics.play(.tap); query = Self.text(for: chip) } label: {
                    Label(chip.title, systemImage: "magnifyingglass").frame(minHeight: 44)
                }
            }
        }
    }

    static func text(for chip: SmartSearch.Chip) -> String {
        switch chip.kind {
        case .needsYou: "waiting"
        case .token(let token):
            switch token {
            case .state(let filter): filter.word
            case .agent(let agent): agent
            case .project(let name): "project:\(name)"
            case .day(let day): day.rawValue
            }
        }
    }

    @ViewBuilder private var results: some View {
        let smart = SmartSearch.parse(query)
        let built = model.pondBuilt
        let items = built.ponds + built.other
        let ponds = PondList.matchingPonds(items, query: query)
        let streams = PondList.matchingStreams(items, query: query)
        let found = SmartSearch.results(smart, active: model.homeLists.visible, older: model.recentChats, unread: { model.isUnread($0) })
        if ponds.isEmpty && streams.isEmpty && found.active.isEmpty && found.older.isEmpty {
            ContentUnavailableView.search(text: query).listRowBackground(Color.clear).listRowSeparator(.hidden)
        }
        if !ponds.isEmpty {
            Section("Ponds") { ForEach(ponds) { PondRow(item: $0) } }
        }
        if !streams.isEmpty {
            Section("Streams") {
                ForEach(streams, id: \.stream.id) { hit in
                    NavigationLink(value: HomeRoute.stream(hit.pond.id, hit.stream.id)) {
                        HStack(spacing: 10) {
                            if let icon = model.pondIconName(hit.pond) { ProjectMark(name: icon, size: 28, round: true) }
                            VStack(alignment: .leading, spacing: 2) {
                                Text(hit.stream.name).font(.body).lineLimit(1)
                                Text(hit.pond.name).font(.footnote).foregroundStyle(Theme.muted)
                            }
                        }.frame(minHeight: 44)
                    }.tapHaptic(.navigate)
                }
            }
        }
        if !found.active.isEmpty { Section("Threads") { threadRows(found.active, recent: false) } }
        if !found.older.isEmpty { Section("Earlier") { threadRows(found.older, recent: true) } }
    }

    private func threadRows(_ sessions: [PhoneSnapshot.Session], recent: Bool) -> some View {
        ForEach(sessions) { session in
            NavigationLink(value: HomeRoute.session(session.key)) { SessionRow(session: session, recent: recent) }
                .simultaneousGesture(TapGesture().onEnded { remember() })
                .tapHaptic(.navigate)
                .homeRow(needsYou: !recent && session.needsYou, edge: MarkGlyph.edge(session))
                .modifier(SessionSwipe(session: session) { quickReply = session })
        }
    }
}
#endif
