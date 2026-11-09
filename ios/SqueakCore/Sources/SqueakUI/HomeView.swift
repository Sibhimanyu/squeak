#if os(iOS)
import SqueakCore
import SqueakIcons
import SwiftUI

/// Where Home's stack can go: a group of chats (a project, a state, the older ones) or one chat.
enum HomeRoute: Hashable {
    case session(String)
    case project(String)
    case status(Presentation.Filter)
    case recent
    case film(String)
}

/// DESIGN.md §8.2: Home is a stack of group cards, by project or by state; a card's header opens
/// the group's chats and the few chats it previews open themselves. Nothing else competes for the
/// first glance: one accent colour (needs you), everything else in ink and grey.
/// The standalone app's Home is the flat projects list, with Usage and Settings in one capsule at the
/// top right and the search dock (`SearchDock`) at the foot; there is no tab bar.
struct HomeView: View {
    /// Squeak's own app: no tab bar, search in the dock, Usage and Settings in one top-right capsule.
    var standalone = false
    /// Normally nil: an embedded host keeps the Projects / Status switch and remembers the choice.
    var fixedGrouping: Presentation.Grouping?
    /// Whether a linked chat opens here.
    var opensLinks = true
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ObservedObject private var router = SqueakRouter.shared
    /// Projects or Status, remembered between launches.
    @AppStorage("homeGrouping") private var storedGrouping = Presentation.Grouping.projects
    private var grouping: Presentation.Grouping { fixedGrouping ?? storedGrouping }
    private var groupingBinding: Binding<Presentation.Grouping> { $storedGrouping }
    @State private var query = ""
    /// The dock's chosen filter tokens (chips).
    @State private var chosen: [SearchToken] = []
    @FocusState private var searchFocused: Bool
    /// The small states opened in place on Home; kept here so a card scrolled away keeps its state.
    /// `-squeak-expand <working|done|…>` starts with that state open: screenshots of the demo only.
    @State private var expanded: Set<Presentation.Filter> = {
        let args = ProcessInfo.processInfo.arguments
        guard let i = args.firstIndex(of: "-squeak-expand"), i + 1 < args.count, let f = Presentation.Filter(rawValue: args[i + 1]) else { return [] }
        return [f]
    }()
    @State private var showingSettings = ProcessInfo.processInfo.arguments.contains("-squeak-settings")
    @State private var showingNewChat = ProcessInfo.processInfo.arguments.contains("-squeak-newchat")
        || ProcessInfo.processInfo.arguments.contains("-squeak-newchat-filled")
        || ProcessInfo.processInfo.arguments.contains("-squeak-newchat-error")
        || ProcessInfo.processInfo.arguments.contains("-squeak-newchat-save")
        || ProcessInfo.processInfo.arguments.contains("-squeak-newchat-customize")
    @State private var showingUsage = ProcessInfo.processInfo.arguments.contains("-squeak-usage")
    /// The chat a swipe's Reply is answering, without opening it.
    @State private var quickReply: PhoneSnapshot.Session?
    /// `-squeak-open <key>` starts inside a session: screenshots of the demo only.
    @State private var path: [HomeRoute] = {
        let args = ProcessInfo.processInfo.arguments
        // `-squeak-open-film <id>` starts inside a film: screenshots of the demo only.
        if let index = args.firstIndex(of: "-squeak-open-film"), index + 1 < args.count { return [.film(args[index + 1])] }
        guard let index = args.firstIndex(of: "-squeak-open"), index + 1 < args.count else { return [] }
        return [.session(args[index + 1])]
    }()

    /// Chats on screen under the groups: those with an unread reply are in New replies above them instead.
    /// Active chats, unread ones included: a reply you have not seen is a blue dot on its row, not a section of its own.
    private var sessions: [PhoneSnapshot.Session] { model.homeLists.visible }
    private var unreadReplies: [PhoneSnapshot.Session] { model.unreadReplies }
    /// Chats that are not active any more, to pick up again.
    private var recent: [PhoneSnapshot.Session] { model.recentChats }
    /// The large title: "Sessions" for the standalone app, else the grouping's.
    private var title: String { standalone ? "Sessions" : grouping.title }
    private var smart: SmartQuery { SmartSearch.parse(query).adding(chosen) }
    private var isSearching: Bool { !smart.isEmpty }
    /// Every project: active chats and older ones together, newest activity first when Home opens, then held
    /// still while you look (`StableOrder`), so a busy project does not jump under a finger.
    private var projects: [Presentation.Project] {
        StableOrder.arrange(model.homeLists.projects, previous: shownProjects) { $0.name }
    }
    @State private var shownProjects: [String] = []

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if !model.home.present {
                    ScrollView { waiting }
                } else if isSearching {
                    List { results }
                        .listStyle(.insetGrouped)
                        .listSectionSpacing(16)
                        .scrollContentBackground(.hidden)
                } else {
                    ScrollViewReader { proxy in
                        ScrollView { cards }
                            // `-squeak-scrollend`: scrolls to the last card, for screenshots.
                            .onAppear { if ProcessInfo.processInfo.arguments.contains("-squeak-scrollend") { DispatchQueue.main.asyncAfter(deadline: .now() + 1) { proxy.scrollTo("end", anchor: .bottom) } } }
                    }
                        .scrollDismissesKeyboard(.interactively)
                        .contentMargins(.bottom, 24, for: .scrollContent)
                }
            }
            // The foot floats over the list (below), so the list leaves room for it instead of an inset measuring it.
            .contentMargins(.bottom, standalone ? 96 : 0, for: .scrollContent)
            .background(Theme.bg.ignoresSafeArea())
            .navigationTitle(!isSearching && model.home.present ? title : "Sessions")
            .navigationBarTitleDisplayMode(.large)
            .modifier(NavSearch(enabled: !standalone, text: $query))
            .navigationDestination(for: HomeRoute.self) { route in
                if case .session(let key) = route { SessionView(key: key) } else if case .film(let id) = route { FilmView(id: id) } else { GroupView(route: route, path: $path) }
            }
            .refreshable { Haptics.play(.refresh); shownProjects = []; await model.refresh() }
            .onChange(of: path) { _, new in
                // Start following the chat on the tap, not when its screen has finished arriving.
                if case let .session(key) = new.last {
                    #if DEBUG
                    OpenProbe.begin("open \(key)")
                    #endif
                    model.watch(key)
                }
            }
            .toolbar { toolbar }
            // An overlay, never a safeAreaInset: an inset asks the whole scrolling list for its minimum height, and with
            // a real Mac's chats that laid out every row's text past iOS's 20 s launch watchdog (0x8badf00d,
            // scene-create): 1.20.32 and 1.20.34 opened black on a real iPhone and were killed. The list's bottom
            // content margin keeps its last row clear of it.
            .overlay(alignment: .bottom) {
                VStack(spacing: 0) {
                    ConnectionBar()
                    if standalone, model.home.present {
                        SearchDock(
                            query: $query, chosen: $chosen, focused: $searchFocused,
                            chips: SmartSearch.chips(sessions: sessions, chosen: chosen,
                                                     needsYouCount: NeedsYou.count(sessions: model.home.sessions, films: model.home.films)),
                            canStartChat: model.home.workspaces != nil,
                            onNeedsYou: { searchFocused = false; path.append(.status(.needsYou)) },
                            onNewChat: { searchFocused = false; showingNewChat = true })
                    }
                }
            }
            // A tapped notification or link: the chat is on its way while the Mac's first view (which has it) loads.
            // An overlay, not an inset, so it adds no layout pass.
            .overlay(alignment: .top) {
                if opensLinks, router.pendingSessionId != nil, model.freshSnapshotAt == nil {
                    LoadingLine("Opening your chat…").frame(maxWidth: .infinity).padding(.vertical, 8).background(Theme.bg)
                }
            }
            .sheet(isPresented: $showingSettings) { SettingsView() }
            .sheet(item: $quickReply) { session in QuickReply(session: session) }
            .onAppear {
                let args = ProcessInfo.processInfo.arguments
                // `-squeak-quick <key>`: the swipe's Reply sheet, for screenshots of the demo.
                if let i = args.firstIndex(of: "-squeak-quick"), i + 1 < args.count { quickReply = model.snapshot?.session(args[i + 1]) }
                // `-squeak-group <projects|status>` and `-squeak-filter <needsYou|…>`: for screenshots.
                if let i = args.firstIndex(of: "-squeak-group"), i + 1 < args.count, let g = Presentation.Grouping(rawValue: args[i + 1]) { groupingBinding.wrappedValue = g }
                if args.contains("-squeak-tab-home") { groupingBinding.wrappedValue = .projects }
                if let i = args.firstIndex(of: "-squeak-filter"), i + 1 < args.count, let f = Presentation.Filter(rawValue: args[i + 1]) { path = [.status(f)] }
                if args.contains("-squeak-earlier") { path = [.recent] }
                // `-squeak-rename <key>`: the rename alert, for screenshots of the demo.
                if let i = args.firstIndex(of: "-squeak-rename"), i + 1 < args.count { model.renameTarget = model.snapshot?.session(args[i + 1]) }
                if let i = args.firstIndex(of: "-squeak-project"), i + 1 < args.count { path = [.project(args[i + 1])] }
                #if DEBUG
                // `-squeak-reopen`: leaves the opened chat after 3 s and opens it again after 5 s, to time a chat that
                // has a cached frame (with `-squeak-scroll-trace`).
                if args.contains("-squeak-reopen"), let opened = path.first {
                    DispatchQueue.main.asyncAfter(deadline: .now() + 3) { path = [] }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 5) { path = [opened] }
                }
                // `-squeak-probe-open <key>` (with `-squeak-project <name>` and `-squeak-open-probe`): taps the chat
                // from the project page after 2 s, goes back after 6 s and taps it again after 8 s (cold, then warm).
                if let i = args.firstIndex(of: "-squeak-probe-open"), i + 1 < args.count {
                    let project = path
                    let chat = HomeRoute.session(args[i + 1])
                    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { path = project + [chat] }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 6) { path = project }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 8) { path = project + [chat] }
                }
                #endif
            }
            .sheet(isPresented: $showingUsage) { UsageView() }
            .sheet(isPresented: $showingNewChat) { NewChatEntry() }
            // A link from a Telegram card: open its session as soon as the
            // snapshot has it, on a fresh stack so Back leads to the list.
            .onChange(of: router.pendingSessionId, initial: true) { _, _ in if opensLinks { openPending() } }
            .onChange(of: model.home) { _, _ in if opensLinks { openPending() } }
        }
        .foregroundStyle(Theme.ink)
        .navigationHaptic(count: path.count)
    }

    /* ---------- the two views ---------- */

    /// The switch, one line of what is on screen in words, then the cards. Both presentations read the
    /// same snapshot, so the switch changes only how it is laid out and needs no round trip.
    private var cards: some View {
        LazyVStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 10) {
                if fixedGrouping == nil {
                    Picker("Group by", selection: groupingBinding) {
                        ForEach(Presentation.Grouping.allCases) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .onChange(of: groupingBinding.wrappedValue) { _, _ in Haptics.play(.segment) }
                }
                if !sessions.isEmpty {
                    // With no tab for it, what waits on you opens from the line that counts it.
                    if Presentation.needsYouCount(sessions) > 0 {
                        NavigationLink(value: HomeRoute.status(.needsYou)) {
                            HStack(spacing: 6) { summary; Lucide(.chevronRight, size: 14, color: Theme.subtle) }
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.press)
                        .accessibilityHint("Opens what is waiting for you")
                    } else {
                        summary
                    }
                }
                MacStripView { showingSettings = true }
            }
            .padding(.bottom, 4)
            if let starting = model.startingChat { StartingRow(label: starting.label) }
            // RasanAI films, as things of their own, above the chats.
            if !model.home.films.isEmpty { FilmsCard(films: model.home.films) }
            if projects.isEmpty || (grouping == .status && sessions.isEmpty) {
                restingDuck
            } else {
                switch grouping {
                case .projects:
                    VStack(spacing: 0) {
                        ForEach(projects) { ProjectRow(project: $0, last: $0.id == projects.last?.id) }
                    }
                    .onAppear { shownProjects = [] }
                    .onChange(of: projects.map(\.name), initial: true) { _, names in shownProjects = names }
                case .status:
                    ForEach(Presentation.statusGroups(sessions), id: \.filter) { group in
                        StatusGroupCard(filter: group.filter, sessions: sessions.filter { Presentation.inFilter($0, group.filter) },
                                        expanded: Binding(get: { expanded.contains(group.filter) },
                                                          set: { if $0 { expanded.insert(group.filter) } else { expanded.remove(group.filter) } }))
                    }
                }
            }
            if !recent.isEmpty { FindOlderChatsLine() }
            Color.clear.frame(height: 1).id("end")
        }
        .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 16)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: grouping)
    }

    /// "6 sessions · 3 working", always: the Mac's awake and power state has its own strip below.
    /// In words only: ConnectionBar speaks up when the connection is not fine.
    private var summary: some View {
        TimelineView(.periodic(from: .now, by: 5)) { _ in
            let state = model.connection()
            HStack(spacing: 6) {
                StatusDot(color: state.color)
                Text(subtitle).font(.subheadline).foregroundStyle(Theme.muted).monospacedDigit()
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(subtitle), \(state.text)")
        }
    }

    /// Searching skips the groups: every chat that matches (SmartSearch), active ones first, each newest first.
    @ViewBuilder
    private var results: some View {
        let found = SmartSearch.results(smart, active: sessions, older: recent, unread: { model.isUnread($0) })
        let active = found.active
        let older = found.older
        if active.isEmpty && older.isEmpty {
            ContentUnavailableView.search(text: query).listRowBackground(Color.clear).listRowSeparator(.hidden)
        }
        if !active.isEmpty {
            Section {
                ForEach(active) { session in
                    NavigationLink(value: HomeRoute.session(session.key)) { SessionRow(session: session) }.tapHaptic(.navigate)
                        .homeRow(needsYou: session.needsYou, edge: MarkGlyph.edge(session))
                        .modifier(SessionSwipe(session: session) { quickReply = session })
                }
            }
        }
        if !older.isEmpty {
            Section {
                ForEach(older) { session in
                    NavigationLink(value: HomeRoute.session(session.key)) { SessionRow(session: session, recent: true) }.tapHaptic(.navigate)
                        .homeRow(needsYou: false)
                        .modifier(SessionSwipe(session: session) { quickReply = session })
                }
            }
        }
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        if #available(iOS 26, *) {
            // Glass never sits behind the duck (DESIGN.md §5): no bar pill here.
            ToolbarItem(placement: .topBarLeading) { duck }.sharedBackgroundVisibility(.hidden)
        } else {
            ToolbarItem(placement: .topBarLeading) { duck }
        }
        // Only a Mac new enough to list workspaces can start a chat; Settings says so otherwise.
        // The standalone app starts one from the dock; an embedded host has no dock, so the button stays here.
        if !standalone, model.home.workspaces != nil {
            ToolbarItem(placement: .topBarTrailing) {
                Button { Haptics.play(.tap); showingNewChat = true } label: {
                    Lucide(.squarePen, size: 20, label: "New chat", color: Theme.muted)
                }
            }
        }
        // One group: on iOS 26 the system draws Usage and Settings in a single glass capsule.
        ToolbarItemGroup(placement: .topBarTrailing) {
            Button { Haptics.play(.tap); showingUsage = true } label: {
                Lucide(.gauge, size: 20, label: "Usage", color: Theme.muted)
            }
            Button { Haptics.play(.tap); showingSettings = true } label: {
                Lucide(.settings, size: 20, label: "Settings", color: Theme.muted)
            }
        }
    }

    /// The one duck on this screen (§6.3); the empty state brings its own.
    @ViewBuilder
    private var duck: some View {
        if !sessions.isEmpty {
            Image("squeak-duck-compact", bundle: .module).resizable().scaledToFit().frame(width: 28, height: 28)
                .accessibilityLabel("Squeak")
        }
    }

    private var subtitle: String { Presentation.headerCount(sessions) }

    private func openPending() {
        guard let id = router.pendingSessionId,
              let session = (model.home.sessions + model.home.recent).first(where: { $0.conductorSessionId == id })
        else { return }
        path = [.session(session.key)]
        router.consume()
    }

    /* ---------- pieces ---------- */

    private var restingDuck: some View {
        VStack(spacing: 12) {
            Image("duck-asleep", bundle: .module).resizable().scaledToFit().frame(width: 88, height: 88).accessibilityHidden(true)
            Text("Nothing's running. The duck is resting.").foregroundStyle(Theme.muted)
        }
        .frame(maxWidth: .infinity).padding(.top, 32).padding(.bottom, 40)
    }

    private var waiting: some View {
        VStack(spacing: 16) {
            SkeletonRows(word: model.problem ?? "Waiting for your Mac…", rows: 4, rowHeight: 64)
        }
        .padding(.horizontal, 20).padding(.vertical, 24)
    }
}

/// The embedded layout keeps the system search field in the navigation bar; the standalone app searches in its dock.
private struct NavSearch: ViewModifier {
    let enabled: Bool
    @Binding var text: String

    func body(content: Content) -> some View {
        if enabled { content.searchable(text: $text, prompt: "Search chats…") } else { content }
    }
}

/// One group's chats: a project's, a state's, or the older ones. Needs you shows each chat as a
/// card with its question and one-tap answers; every other group is plain rows.
struct GroupView: View {
    @Environment(AppModel.self) private var model
    let route: HomeRoute
    @Binding var path: [HomeRoute]
    @State private var quickReply: PhoneSnapshot.Session?
    @State private var startingChat = false
    /// The order the chats were shown in since this page opened (`StableOrder`): they hold still under a finger.
    @State private var shownOrder: [String] = []

    private var active: [PhoneSnapshot.Session] {
        let all = model.home.sessions
        switch route {
        case .project(let name): return Presentation.newestFirst(all.filter { Presentation.projectName($0) == name })
        case .status(let filter): return Presentation.newestFirst(all.filter { Presentation.inFilter($0, filter) })
        case .recent, .session, .film: return []
        }
    }

    /// Older chats: a project's own under its active ones, or all of them under Earlier.
    private var older: [PhoneSnapshot.Session] {
        switch route {
        case .project(let name): return model.recentChats.filter { Presentation.projectName($0) == name && !model.isHiddenHere($0) }
        case .recent: return model.recentChats
        case .status, .session, .film: return []
        }
    }

    private var title: String {
        switch route {
        case .project(let name): return name
        case .status(let filter): return filter.heading
        case .recent, .session, .film: return "Older chats"
        }
    }

    var body: some View {
        if case .recent = route { EarlierView(path: $path) }
        else if case .status(.needsYou) = route { NeedsYouPage(path: $path) }
        else { list }
    }

    private var list: some View {
        let both = StableOrder.arrange(active + older, previous: shownOrder) { $0.key }
        let activeKeys = Set(active.map(\.key))
        let active = both.filter { activeKeys.contains($0.key) }
        let older = both.filter { !activeKeys.contains($0.key) }
        return List {
            if !active.isEmpty {
                Section {
                    ForEach(active) { session in
                        NavigationLink(value: HomeRoute.session(session.key)) {
                            SessionRow(session: session, inProject: isProject)
                        }.tapHaptic(.navigate)
                        .homeRow(needsYou: session.needsYou, edge: MarkGlyph.edge(session))
                        .modifier(SessionSwipe(session: session) { quickReply = session })
                    }
                }
            }
            if !older.isEmpty {
                Section {
                    ForEach(older) { session in
                        NavigationLink(value: HomeRoute.session(session.key)) { SessionRow(session: session, recent: true, inProject: isProject) }.tapHaptic(.navigate)
                            .homeRow(needsYou: false)
                            .modifier(SessionSwipe(session: session) { quickReply = session })
                    }
                    if route == .recent, model.home.recentMore { showMore }
                } header: {
                    if !active.isEmpty { Text("Earlier") }
                }
            }
            if active.isEmpty && older.isEmpty {
                ContentUnavailableView {
                    Label { Text("Nothing here now") } icon: { Lucide(.circleCheck, size: 28, color: Theme.muted) }
                } description: {
                    Text("Pull down to refresh.")
                }
                .listRowBackground(Color.clear).listRowSeparator(.hidden)
            }
        }
        .listStyle(.insetGrouped)
        .listSectionSpacing(16)
        .scrollContentBackground(.hidden)
        .background(Theme.bg.ignoresSafeArea())
        .navigationTitle(title)
        // A pushed list gets the compact bar and the ordinary back button, not a tall header.
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { Haptics.play(.refresh); shownOrder = []; await model.refresh() }
        // Opened (or come back to from a chat): newest first again, then held while you look.
        .onAppear { shownOrder = [] }
        .onChange(of: both.map(\.key), initial: true) { _, keys in shownOrder = keys }
        .safeAreaInset(edge: .bottom) { ConnectionBar() }
        .sheet(item: $quickReply) { session in QuickReply(session: session) }
        .toolbar {
            // A project's own page starts a chat right there, in that project.
            if case .project(let name) = route, model.home.workspaces != nil {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { Haptics.play(.tap); startingChat = true } label: {
                        Lucide(.squarePen, size: 20, label: "New chat in \(name)", color: Theme.muted)
                    }
                }
            }
        }
        .sheet(isPresented: $startingChat) {
            if case .project(let name) = route { NewChatEntry(project: name) }
        }
        .foregroundStyle(Theme.ink)
    }

    private var isProject: Bool { if case .project = route { true } else { false } }

    private var showMore: some View {
        let waiting = model.recentWanted > older.count
        return Button { Haptics.play(.tap); model.showMoreRecent() } label: {
            HStack(spacing: 8) {
                if waiting && model.recentWanted > 10 { GlyphLoader() }
                Text(waiting && model.recentWanted > 10 ? "Loading older chats…" : "Show more")
                    .font(.subheadline.weight(.medium)).foregroundStyle(Theme.muted)
            }
            .frame(maxWidth: .infinity, minHeight: 44)
        }
        .disabled(waiting && model.recentWanted > 10)
        .listRowBackground(Theme.surface)
        .accessibilityHint("Loads older chats from your Mac")
    }
}

extension AppModel {
    /// The snapshot's older chats, without any that are active again.
    var recentChats: [PhoneSnapshot.Session] {
        home.recent
    }
}

extension Presentation.Filter {
    /// The state as a list's heading: "Waiting for you", "Working", "Finished", "Failed".
    var heading: String { self == .needsYou ? "Waiting for you" : word.prefix(1).uppercased() + word.dropFirst() }
}

extension View {
    /// A Home list row: the surface, the insets, and the one accent Home uses (§3.3): a left
    /// edge in the needs-you colour on what is waiting for you. Nothing else is coloured.
    func homeRow(needsYou: Bool, edge: Color = Theme.warning) -> some View {
        listRowBackground(Theme.surface)
            .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
            .overlay(alignment: .leading) {
                if needsYou {
                    Capsule().fill(edge).frame(width: 3).padding(.vertical, 6).offset(x: -14)
                        .accessibilityHidden(true)
                }
            }
    }
}

/// Answer from a list (§8.2): a swipe offers the agent's lettered options (up to three, as
/// many as fit) and Reply, for a chat this phone can answer. A letter goes out at once, like a
/// tap on its card; Reply opens a small field over the list.
struct SessionSwipe: ViewModifier {
    @Environment(AppModel.self) private var model
    let session: PhoneSnapshot.Session
    let onReply: () -> Void

    private var canReply: Bool { Presentation.replyBlock(session) == nil && session.conductorSessionId != nil }

    func body(content: Content) -> some View {
        content
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                if canReply {
                    Button(action: { Haptics.play(.tap); onReply() }) { Label("Reply", systemImage: "arrowshape.turn.up.left") }
                        .tint(Theme.subtle)
                    if session.state != "working", session.question == nil, let choices = session.choices {
                        ForEach(choices.options.prefix(3).reversed(), id: \.letter) { option in
                            Button { Task { await model.send(option.sent, to: session) } } label: { Text(option.letter) }
                                .tint(option.letter == choices.recommended ? Theme.ink.opacity(0.7) : Theme.lineStrong)
                                .accessibilityLabel("Send \(option.letter): \(option.title)")
                        }
                    }
                }
            }
            // The same actions on a long press, so a swipe is never the only route.
            .contextMenu {
                if canReply {
                    Button(action: onReply) { Label("Reply", systemImage: "arrowshape.turn.up.left") }
                    if session.state != "working", session.question == nil, let choices = session.choices {
                        ForEach(choices.options.prefix(3), id: \.letter) { option in
                            Button { Task { await model.send(option.sent, to: session) } } label: {
                                Text("Send \(option.letter): \(Presentation.splitOption(option.title).title)")
                            }
                        }
                    }
                }
            }
    }
}

/// A chat that needs you: its question and, when the phone can answer it in one tap, the
/// answers (§8.4). Reply opens the small field; anything else opens the chat.
struct AskCard: View {
    @Environment(AppModel.self) private var model
    let session: PhoneSnapshot.Session
    let onReply: () -> Void
    let onOpen: () -> Void
    @State private var sending: Presentation.QuickAnswer?
    @State private var outcome: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button(action: { Haptics.play(.tap); onOpen() }) {
                HStack(alignment: .top, spacing: 10) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(Presentation.displayTitle(session)).font(.headline).lineLimit(1)
                        Text("\(Presentation.subtitle(session)) · \(Age.describe(session.lastActivityAt))")
                            .font(.subheadline).foregroundStyle(Theme.muted).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Theme.subtle)
                        .padding(.top, 6).accessibilityHidden(true)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.press)
            .accessibilityHint("Opens the chat")
            Text(Presentation.ask(session)).font(.body).foregroundStyle(Theme.ink).lineLimit(3)
            let answers = Presentation.quickAnswers(session)
            if !answers.isEmpty {
                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) { answerButtons(answers) }
                    VStack(alignment: .leading, spacing: 8) { answerButtons(answers) }
                }
            }
            HStack(spacing: 16) {
                if Presentation.replyBlock(session) == nil {
                    Button("Reply", action: onReply).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
                        .frame(minHeight: 44)
                } else if answers.isEmpty {
                    Button(session.workflow.map { _ in "Open the call" } ?? "Open chat", action: onOpen).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
                        .frame(minHeight: 44)
                }
                if let outcome { Text(outcome).font(.footnote).foregroundStyle(Theme.muted).lineLimit(2) }
            }
            .buttonStyle(.press)
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .overlay(alignment: .leading) {
            Capsule().fill(MarkGlyph.edge(session)).frame(width: 3).padding(.vertical, 12).padding(.leading, 2).accessibilityHidden(true)
        }
    }

    @ViewBuilder
    private func answerButtons(_ answers: [Presentation.QuickAnswer]) -> some View {
        ForEach(answers, id: \.title) { answer in
            Button {
                Task { await send(answer) }
            } label: {
                HStack(spacing: 6) {
                    if sending == answer { GlyphLoader().controlSize(.small) }
                    Text(answer.title).font(.subheadline.weight(.medium)).lineLimit(1)
                }
                .foregroundStyle(Theme.ink)
                .padding(.horizontal, 12)
                .frame(minHeight: 40)
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.lineStrong))
                .contentShape(RoundedRectangle(cornerRadius: 10))
            }
            .buttonStyle(.press)
            .disabled(sending != nil)
            .settleGuard()
        }
    }

    private func send(_ answer: Presentation.QuickAnswer) async {
        sending = answer
        defer { sending = nil }
        switch answer {
        case .option(let label):
            let result = await model.answer([AnswerCommand.Answer(question: 0, picked: [label])], to: session)
            outcome = result.line.isEmpty ? nil : result.line
        case .letter(let letter, _):
            outcome = await model.send(letter, to: session) ? "Sent \(letter)" : nil
        }
    }
}

/// A chat the Mac accepted that the snapshot does not have yet.
struct StartingRow: View {
    let label: String

    var body: some View {
        HStack(spacing: 12) {
            GlyphLoader(size: 14).padding(.trailing, 0)
            VStack(alignment: .leading, spacing: 3) {
                Text("Starting…").font(.headline)
                Text(label).font(.subheadline).foregroundStyle(Theme.muted).lineLimit(1)
            }
        }
        .padding(.vertical, 6).padding(.horizontal, 4).frame(minHeight: 44)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Starting a chat in \(label)")
    }
}

/// One chat in a list (§8.2): title and age; then the state in words (or the live step) with
/// `repo · agent`; then, when it waits on you or failed, why. No dot: the words carry the state.
struct SessionRow: View {
    @Environment(AppModel.self) private var model
    let session: PhoneSnapshot.Session
    /// A chat from Earlier: its second line is what the agent last said, not a state word.
    var recent = false
    /// Inside its project: the project is the screen's title, so the row says only the agent.
    var inProject = false

    /// "Starting" while this phone's own message is about to begin a turn: the same rule the chat uses
    /// (ChatTimeline.isStarting), so the two agree.
    private var starting: Bool { ChatTimeline.isStarting(session: session, sends: model.outbox[session.key] ?? []) }

    private var mark: Presentation.Mark {
        starting ? .working : Presentation.mark(session, unread: model.isUnread(session))
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            AgentAvatar(session: session, size: recent ? 36 : 28, conductorBadge: false).padding(.top, 2)
            rowText
        }
        .padding(.vertical, recent ? 6 : 2)
        .frame(minHeight: 44)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(Presentation.rowLabel(session, mark: mark))\(secondLine.map { ": \($0)" } ?? ""), \(Presentation.subtitle(session))")
        .accessibilityHint(session.state == "error" ? "Opens the chat to see what failed" : "")
        .renameMenu(session, model: model)
    }

    private var unread: Bool { model.isUnread(session) }

    /// Finished and unread is ink and semibold; ordinary and paused titles stay regular.
    private var loud: Bool { unread }

    /// One muted line: the step, the ask, the failure reason, or the agent's last words (an Earlier chat: its last words).
    private var secondLine: String? {
        // A menu action on this chat the Mac has not answered ("Renaming…"): the row says so, since menus can't spin.
        if let pending = model.inFlight[session.key] { return pending }
        if starting { return "Starting" }
        if recent { return Presentation.firstLine(session.message ?? session.detail) }
        return Presentation.secondLine(session)
    }

    private var titleLine: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            if !recent, !inProject { ProjectMark(name: Presentation.projectName(session), size: 20) }
            Text(Presentation.displayTitle(session)).font(.headline).fontWeight(loud ? .semibold : .regular)
                .foregroundStyle(loud ? Theme.ink : Theme.muted).lineLimit(2)
            if session.conductorSessionId != nil { ConductorMarker() }
            Spacer(minLength: 4)
            CornerMark(mark: mark, age: session.lastActivityAt, session: session)
        }
        .runningGlyphs(starting || session.state == "working", still: !model.macIsLive)
    }

    /// An Earlier row gets a third line so the marks do not crowd the title: where it ran (project mark, project,
    /// agent) with Open/Closed at the end.
    private var recentText: some View {
        VStack(alignment: .leading, spacing: 4) {
            titleLine
            if let secondLine {
                Text(secondLine).font(.subheadline).foregroundStyle(Theme.muted).lineLimit(2)
            }
            HStack(spacing: 6) {
                if !inProject { ProjectMark(name: Presentation.projectName(session), size: 18) }
                Text(inProject ? Presentation.agentName(session.agent) : Presentation.subtitle(session))
                    .font(.footnote).foregroundStyle(Theme.muted).lineLimit(1)
                Spacer(minLength: 4)
                if let open = session.open { OpenTag(open: open) }
            }
            .padding(.top, 2)
        }
    }

    @ViewBuilder
    private var rowText: some View {
        if recent { recentText } else { activeText }
    }

    /// Title and one muted line; no state word, no agent, no repo (the mark and the avatar say them).
    private var activeText: some View {
        VStack(alignment: .leading, spacing: 2) {
            titleLine
            if let secondLine { Text(secondLine).font(.subheadline).foregroundStyle(Theme.muted).lineLimit(1) }
        }
    }
}

/// Whether a chat's tab is open in Conductor, in words on an Earlier row: the words say it, the outline only frames them.
struct OpenTag: View {
    let open: Bool

    var body: some View {
        Text(open ? "Open" : "Closed")
            .font(.caption2.weight(.semibold)).foregroundStyle(open ? Theme.ink : Theme.subtle)
            .padding(.horizontal, 6).padding(.vertical, 2)
            .overlay(RoundedRectangle(cornerRadius: 6).stroke(open ? Theme.lineStrong : Theme.line))
            .accessibilityLabel(open ? "Open in Conductor" : "Closed in Conductor")
    }
}

/// "Mac connected", and honest when it is not: the phone only knows its
/// last successful read of the Mac's snapshot, so that is all it claims.
struct ConnectionBar: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        TimelineView(.periodic(from: .now, by: 2)) { _ in
            let state = model.connection()
            if !state.healthy {
            HStack(spacing: 8) {
                StatusDot(color: state.color)
                Text(state.text).font(.footnote.weight(.medium)).foregroundStyle(Theme.muted)
            }
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity)
            .background(Theme.bg)
            .accessibilityElement(children: .combine)
            }
        }
    }
}

extension AppModel {
    /// The connection as the header, the bar and Settings show it.
    func connection(now: Date = Date()) -> Connection.State {
        Connection.read(snapshot: snapshot, problem: problem, demo: demo, lastFetch: lastFetch, mac: macLiveness(now: now),
                        route: route, phoneOffline: phoneOffline && !demo, macAliveAt: macAliveAt,
                        streamDownSince: streamDownSince, saved: showingSaved, now: now)
    }
}

enum Connection {
    /// How the Mac is being reached, in words: "Connected · same Wi-Fi" / "Connected · via cloud" only while it answers.
    static func routeText(_ route: ChannelRoute, mac: MacLiveness = .answering, now: Date = Date()) -> String {
        ConnectionStatus.routeText(route, mac: mac, now: now)
    }

    struct State {
        let text: String
        let color: Color
        /// Fine: no bar is shown; the header's dot still says so.
        var healthy = false
    }

    static func color(_ tone: ConnectionStatus.Tone) -> Color {
        switch tone {
        case .connected: Theme.working
        case .notConnected: Theme.offline
        case .unverified, .neutral: Theme.subtle
        }
    }

    static func read(snapshot: PhoneSnapshot?, problem: String?, demo: Bool, lastFetch: Date? = nil,
                     mac: MacLiveness = .unknown, route: ChannelRoute = .cloud, phoneOffline: Bool = false,
                     macAliveAt: Date? = nil, streamDownSince: Date? = nil, saved: Bool = false, now: Date = Date()) -> State {
        let status = ConnectionStatus.read(snapshot: snapshot, problem: problem, demo: demo, lastFetch: lastFetch, mac: mac,
                                           route: route, phoneOffline: phoneOffline, macAliveAt: macAliveAt,
                                           streamDownSince: streamDownSince, saved: saved, now: now)
        return State(text: status.text, color: color(status.tone), healthy: status.healthy)
    }
}

/// Reply to a chat from the list: one field and Send, over the list. The answer then shows in the
/// chat like any other send.
struct QuickReply: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let session: PhoneSnapshot.Session
    @State private var text = ""
    @FocusState private var focused: Bool

    private var agentName: String { Presentation.agentName(session.agent) }
    private var empty: Bool { text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    private func send() {
        let reply = text
        dismiss()
        Task { await model.send(reply, to: session) }
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                if let line = Presentation.firstLine(session.message ?? session.detail) {
                    Text(line).font(.subheadline).foregroundStyle(Theme.muted).lineLimit(3)
                }
                ComposerBox(
                    placeholder: "Reply to \(agentName)…", text: $text, photos: .constant([]), focused: $focused,
                    attachEnabled: false, accessibilityLabel: "Reply to \(Presentation.displayTitle(session))",
                    hasContent: !empty, minFieldHeight: 72
                ) {
                    EmptyView()
                } primary: {
                    Button(action: send) {
                        ComposerRound(filled: !empty) { Lucide(.arrowUp, size: 18, color: empty ? Theme.muted : Theme.primaryText) }
                    }
                    .buttonStyle(.press).disabled(empty)
                    .accessibilityLabel(session.state == "working" ? "Queue" : "Send")
                }
                Spacer(minLength: 0)
            }
            .padding(20)
            .background(Theme.bg.ignoresSafeArea())
            .navigationTitle(Presentation.displayTitle(session))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { Haptics.play(.tap); dismiss() } }
            }
        }
        .foregroundStyle(Theme.ink)
        .presentationDetents([.medium])
        .onAppear { focused = true }
    }
}



/// Home's Mac status strip: awake, lid and power in one or two muted lines, tapping through to Settings.
/// Hidden when there is nothing worth saying. All wording comes from `MacStrip.compose`.
struct MacStripView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dynamicTypeSize) private var type
    let open: () -> Void

    private func strip() -> MacStrip? {
        MacStrip.compose(awake: model.awake.map { .init(until: $0.until, lid: $0.lid, safety: $0.safety, pending: $0.pending) }, power: model.snapshot?.macPower, liveness: model.macLiveness(),
                         sleepProblem: model.snapshot?.awakeSleepProblem, lastEnd: model.snapshot?.awakeLastEnd,
                         offered: model.awakeOffered, hotspot: model.snapshot?.hotspot)
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 15)) { _ in
            if let strip = strip() {
                Button(action: { Haptics.play(.tap); open() }) {
                    HStack(alignment: .top, spacing: 10) {
                        StatusDot(color: color(strip.tone)).padding(.top, 5)
                        VStack(alignment: .leading, spacing: 1) {
                            ForEach(Array(strip.lines.enumerated()), id: \.offset) { i, line in
                                Text(line).font(.footnote).foregroundStyle(i == 0 ? Theme.ink : Theme.muted).monospacedDigit()
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                        Spacer(minLength: 0)
                        Lucide(.chevronRight, size: 14, color: Theme.subtle).padding(.top, 2)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 8).frame(minHeight: 44)
                    .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
                    .contentShape(RoundedRectangle(cornerRadius: 12))
                }
                .buttonStyle(.press)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(strip.spoken)
                .accessibilityHint("Opens Keep Mac awake settings")
                .accessibilityAddTraits(.isButton)
                .accessibilityIdentifier("mac-strip")
            }
        }
    }

    private func color(_ tone: MacStrip.Tone) -> Color {
        switch tone {
        case .awake: Theme.working
        case .off: Theme.idle
        case .failed: Theme.error
        case .silent: Theme.offline
        }
    }
}

#endif
