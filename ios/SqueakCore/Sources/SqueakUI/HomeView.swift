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
}

/// DESIGN.md §8.2: Home is a stack of group cards, by project or by state; a card's header opens
/// the group's chats and the few chats it previews open themselves. Nothing else competes for the
/// first glance: one accent colour (needs you), everything else in ink and grey.
struct HomeView: View {
    /// In the app's own tab bar Settings is a tab, so the gear stays out of the toolbar.
    var inTabs = false
    /// In the tab bar, Home is always by project and Sessions always by status, so there is no switch;
    /// nil (an embedded host, which has no bar) keeps the switch and remembers its choice.
    var fixedGrouping: Presentation.Grouping?
    /// Only one Home in the tab bar opens a linked chat.
    var opensLinks = true
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ObservedObject private var router = SqueakRouter.shared
    /// Projects or Status, remembered between launches.
    @AppStorage("homeGrouping") private var storedGrouping = Presentation.Grouping.projects
    private var grouping: Presentation.Grouping { fixedGrouping ?? storedGrouping }
    @State private var query = ""
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
    @State private var showingUsage = ProcessInfo.processInfo.arguments.contains("-squeak-usage")
    /// The chat a swipe's Reply is answering, without opening it.
    @State private var quickReply: PhoneSnapshot.Session?
    /// `-squeak-open <key>` starts inside a session: screenshots of the demo only.
    @State private var path: [HomeRoute] = {
        let args = ProcessInfo.processInfo.arguments
        guard let index = args.firstIndex(of: "-squeak-open"), index + 1 < args.count else { return [] }
        return [.session(args[index + 1])]
    }()

    private var sessions: [PhoneSnapshot.Session] { model.snapshot?.sessions ?? [] }
    /// Chats that are not active any more, to pick up again.
    private var recent: [PhoneSnapshot.Session] { model.recentChats }
    /// The large title: the grouping's, except that by status in the tab bar is the Sessions tab.
    private var title: String { inTabs && grouping == .status ? "Sessions" : grouping.title }
    private var projects: [Presentation.Project] { Presentation.projects(sessions) }

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if model.snapshot == nil {
                    ScrollView { waiting }
                } else if !query.isEmpty {
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
                        // The last card scrolls clear of the floating tab bar.
                        .contentMargins(.bottom, 24, for: .scrollContent)
                }
            }
            .background(Theme.bg.ignoresSafeArea())
            .navigationTitle(query.isEmpty && model.snapshot != nil ? title : "Sessions")
            .navigationBarTitleDisplayMode(.large)
            .searchable(text: $query, prompt: "Search sessions…")
            .navigationDestination(for: HomeRoute.self) { route in
                if case .session(let key) = route { SessionView(key: key) } else { GroupView(route: route, path: $path) }
            }
            .refreshable { await model.refresh() }
            .toolbar { toolbar }
            .safeAreaInset(edge: .bottom) { ConnectionBar() }
            .sheet(isPresented: $showingSettings) { SettingsView() }
            .sheet(item: $quickReply) { session in QuickReply(session: session) }
            .onAppear {
                let args = ProcessInfo.processInfo.arguments
                // `-squeak-quick <key>`: the swipe's Reply sheet, for screenshots of the demo.
                if let i = args.firstIndex(of: "-squeak-quick"), i + 1 < args.count { quickReply = model.snapshot?.session(args[i + 1]) }
                // `-squeak-group <projects|status>` and `-squeak-filter <needsYou|…>`: for screenshots.
                if let i = args.firstIndex(of: "-squeak-group"), i + 1 < args.count, let g = Presentation.Grouping(rawValue: args[i + 1]) { storedGrouping = g }
                if let i = args.firstIndex(of: "-squeak-filter"), i + 1 < args.count, let f = Presentation.Filter(rawValue: args[i + 1]) { path = [.status(f)] }
                if let i = args.firstIndex(of: "-squeak-project"), i + 1 < args.count { path = [.project(args[i + 1])] }
            }
            .sheet(isPresented: $showingUsage) { UsageView() }
            .sheet(isPresented: $showingNewChat) { NewChatView(workspaces: model.snapshot?.workspaces ?? []) }
            // A link from a Telegram card: open its session as soon as the
            // snapshot has it, on a fresh stack so Back leads to the list.
            .onChange(of: router.pendingSessionId, initial: true) { _, _ in if opensLinks { openPending() } }
            .onChange(of: model.snapshot) { _, _ in if opensLinks { openPending() } }
        }
        .foregroundStyle(Theme.ink)
    }

    /* ---------- the two views ---------- */

    /// The switch, one line of what is on screen in words, then the cards. Both presentations read the
    /// same snapshot, so the switch changes only how it is laid out and needs no round trip.
    private var cards: some View {
        LazyVStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 10) {
                if fixedGrouping == nil {
                    Picker("Group by", selection: $storedGrouping) {
                        ForEach(Presentation.Grouping.allCases) { Text($0.title).tag($0) }
                    }
                    .pickerStyle(.segmented)
                    .onChange(of: storedGrouping) { _, _ in UISelectionFeedbackGenerator().selectionChanged() }
                }
                if !sessions.isEmpty { summary }
            }
            .padding(.bottom, 4)
            if let starting = model.startingChat { StartingRow(label: starting.label) }
            if sessions.isEmpty {
                restingDuck
            } else {
                switch grouping {
                case .projects:
                    ForEach(projects) { ProjectCard(project: $0) }
                case .status:
                    ForEach(Presentation.statusGroups(sessions), id: \.filter) { group in
                        StatusGroupCard(filter: group.filter, sessions: sessions.filter { Presentation.inFilter($0, group.filter) },
                                        expanded: Binding(get: { expanded.contains(group.filter) },
                                                          set: { if $0 { expanded.insert(group.filter) } else { expanded.remove(group.filter) } }))
                    }
                }
            }
            if !recent.isEmpty { EarlierCard() }
            Color.clear.frame(height: 1).id("end")
        }
        .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 16)
        .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: grouping)
    }

    /// "6 sessions · 3 working", or the Mac awake's countdown, in words only: ConnectionBar speaks up
    /// when the connection is not fine.
    private var summary: some View {
        TimelineView(.periodic(from: .now, by: 5)) { _ in
            Text(subtitle).font(.subheadline).foregroundStyle(Theme.muted).monospacedDigit()
                .accessibilityLabel("\(subtitle), \(model.connection().text)")
        }
    }

    /// Searching skips the groups: every chat that matches, active ones first.
    @ViewBuilder
    private var results: some View {
        let active = Presentation.byAttention(sessions.filter { Presentation.matches($0, query: query) })
        let older = recent.filter { Presentation.matches($0, query: query) }
        if active.isEmpty && older.isEmpty {
            ContentUnavailableView.search(text: query).listRowBackground(Color.clear).listRowSeparator(.hidden)
        }
        if !active.isEmpty {
            Section {
                ForEach(active) { session in
                    NavigationLink(value: HomeRoute.session(session.key)) { SessionRow(session: session) }
                        .homeRow(needsYou: session.needsYou)
                        .modifier(SessionSwipe(session: session) { quickReply = session })
                }
            }
        }
        if !older.isEmpty {
            Section("Earlier") {
                ForEach(older) { session in
                    NavigationLink(value: HomeRoute.session(session.key)) { SessionRow(session: session, recent: true) }
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
        if model.snapshot?.workspaces != nil {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showingNewChat = true } label: {
                    Lucide(.squarePen, size: 20, label: "New chat", color: Theme.muted)
                }
            }
        }
        ToolbarItem(placement: .topBarTrailing) {
            Button { showingUsage = true } label: {
                Lucide(.gauge, size: 20, label: "Usage", color: Theme.muted)
            }
        }
        if !inTabs {
            ToolbarItem(placement: .topBarTrailing) {
                Button { showingSettings = true } label: {
                    Lucide(.settings, size: 20, label: "Settings", color: Theme.muted)
                }
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

    private var subtitle: String {
        let active = Presentation.headerCount(sessions)
        // While an awake session runs its countdown takes the line: the list shows the count anyway.
        // A Mac that stopped answering is not awake, whatever it said last.
        if case .silent = model.macLiveness() { return "Mac not answering" }
        guard let awake = model.awake else { return active }
        return awake.until.map { "Mac awake · \(AppModel.awakeLeft($0))" } ?? "Mac kept awake"
    }

    private func openPending() {
        guard let id = router.pendingSessionId,
              let session = model.snapshot?.allSessions.first(where: { $0.conductorSessionId == id })
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
        .frame(maxWidth: .infinity).padding(.vertical, 40)
    }

    private var waiting: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text(model.problem ?? "Waiting for your Mac…").foregroundStyle(Theme.muted).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity).padding(.vertical, 40)
    }
}

/// One group's chats: a project's, a state's, or the older ones. Needs you shows each chat as a
/// card with its question and one-tap answers; every other group is plain rows.
struct GroupView: View {
    @Environment(AppModel.self) private var model
    let route: HomeRoute
    @Binding var path: [HomeRoute]
    @State private var quickReply: PhoneSnapshot.Session?

    private var active: [PhoneSnapshot.Session] {
        let all = model.snapshot?.sessions ?? []
        switch route {
        case .project(let name): return Presentation.byAttention(all.filter { Presentation.projectName($0) == name })
        case .status(let filter): return Presentation.byAttention(all.filter { Presentation.inFilter($0, filter) })
        case .recent, .session: return []
        }
    }

    /// Older chats: a project's own under its active ones, or all of them under Earlier.
    private var older: [PhoneSnapshot.Session] {
        switch route {
        case .project(let name): return model.recentChats.filter { Presentation.projectName($0) == name }
        case .recent: return model.recentChats
        case .status, .session: return []
        }
    }

    private var title: String {
        switch route {
        case .project(let name): return name
        case .status(let filter): return filter.heading
        case .recent, .session: return "Earlier"
        }
    }

    var body: some View {
        List {
            if case .status(.needsYou) = route {
                ForEach(active) { session in
                    Section {
                        AskCard(session: session, onReply: { quickReply = session }, onOpen: { path.append(.session(session.key)) })
                            .listRowInsets(EdgeInsets())
                            .listRowBackground(Theme.surface)
                    }
                }
            } else if !active.isEmpty {
                Section {
                    ForEach(active) { session in
                        NavigationLink(value: HomeRoute.session(session.key)) {
                            SessionRow(session: session, inProject: isProject)
                        }
                        .homeRow(needsYou: session.needsYou)
                        .modifier(SessionSwipe(session: session) { quickReply = session })
                    }
                }
            }
            if !older.isEmpty {
                Section {
                    ForEach(older) { session in
                        NavigationLink(value: HomeRoute.session(session.key)) { SessionRow(session: session, recent: true, inProject: isProject) }
                            .homeRow(needsYou: false)
                            .modifier(SessionSwipe(session: session) { quickReply = session })
                    }
                    if route == .recent, model.snapshot?.recentMore == true { showMore }
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
        .refreshable { await model.refresh() }
        .safeAreaInset(edge: .bottom) { ConnectionBar() }
        .sheet(item: $quickReply) { session in QuickReply(session: session) }
        .foregroundStyle(Theme.ink)
    }

    private var isProject: Bool { if case .project = route { true } else { false } }

    private var showMore: some View {
        let waiting = model.recentWanted > older.count
        return Button { model.showMoreRecent() } label: {
            HStack(spacing: 8) {
                if waiting && model.recentWanted > 10 { ProgressView() }
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
        guard let snapshot else { return [] }
        let active = Set(snapshot.sessions.map(\.key))
        return (snapshot.recent ?? []).filter { !active.contains($0.key) }
    }
}

extension Presentation.Filter {
    /// The state as a list's heading: "Needs you", "Working".
    var heading: String { word.prefix(1).uppercased() + word.dropFirst() }
}

extension View {
    /// A Home list row: the surface, the insets, and the one accent Home uses (§3.3): a left
    /// edge in the needs-you colour on what is waiting for you. Nothing else is coloured.
    func homeRow(needsYou: Bool) -> some View {
        listRowBackground(Theme.surface)
            .listRowInsets(EdgeInsets(top: 6, leading: 16, bottom: 6, trailing: 16))
            .overlay(alignment: .leading) {
                if needsYou {
                    Capsule().fill(Theme.needsYou).frame(width: 3).padding(.vertical, 6).offset(x: -14)
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

    func body(content: Content) -> some View {
        content.swipeActions(edge: .trailing, allowsFullSwipe: false) {
            if Presentation.replyBlock(session) == nil, session.conductorSessionId != nil {
                Button(action: onReply) { Label("Reply", systemImage: "arrowshape.turn.up.left") }
                    .tint(Theme.subtle)
                if session.state != "working", session.question == nil, let choices = session.choices {
                    ForEach(choices.options.prefix(3).reversed(), id: \.letter) { option in
                        Button { Task { await model.send(option.letter, to: session) } } label: { Text(option.letter) }
                            .tint(option.letter == choices.recommended ? Theme.ink.opacity(0.7) : Theme.lineStrong)
                            .accessibilityLabel("Send \(option.letter): \(option.title)")
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
            Button(action: onOpen) {
                HStack(alignment: .top, spacing: 10) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(Presentation.displayTitle(session)).font(.headline).lineLimit(1)
                        Text("\(Presentation.status(session).text) · \(Presentation.subtitle(session)) · \(Age.describe(session.lastActivityAt))")
                            .font(.subheadline).foregroundStyle(Theme.muted).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                    Image(systemName: "chevron.right").font(.footnote.weight(.semibold)).foregroundStyle(Theme.subtle)
                        .padding(.top, 6).accessibilityHidden(true)
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
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
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .overlay(alignment: .leading) {
            Capsule().fill(Theme.needsYou).frame(width: 3).padding(.vertical, 12).padding(.leading, 2).accessibilityHidden(true)
        }
    }

    @ViewBuilder
    private func answerButtons(_ answers: [Presentation.QuickAnswer]) -> some View {
        ForEach(answers, id: \.title) { answer in
            Button {
                Task { await send(answer) }
            } label: {
                HStack(spacing: 6) {
                    if sending == answer { ProgressView().controlSize(.small) }
                    Text(answer.title).font(.subheadline.weight(.medium)).lineLimit(1)
                }
                .foregroundStyle(Theme.ink)
                .padding(.horizontal, 12)
                .frame(minHeight: 40)
                .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.lineStrong))
                .contentShape(RoundedRectangle(cornerRadius: 10))
            }
            .buttonStyle(.plain)
            .disabled(sending != nil)
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
            ProgressView().frame(width: 9)
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

    /// The Mac's state, except while this phone's own message is about to start a turn: then
    /// "starting", the same rule the chat uses (ChatTimeline.isStarting), so the two agree.
    private var status: Presentation.Status {
        ChatTimeline.isStarting(session: session, sends: model.outbox[session.key] ?? [])
            ? .init(text: "starting", tone: .working)
            : Presentation.status(session)
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            AgentAvatar(session: session).padding(.top, 2)
            rowText
        }
        .padding(.vertical, 2)
        .frame(minHeight: 44)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(Presentation.displayTitle(session)), \(recent ? (lastWords ?? "") : status.text)\(third.map { ": \($0)" } ?? ""), \(Presentation.subtitle(session)), last active \(Age.spoken(session.lastActivityAt))")
        .accessibilityHint(session.state == "error" ? "Opens the chat to see what failed" : "")
    }

    private var rowText: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(Presentation.displayTitle(session)).font(.headline).lineLimit(2)
                Spacer(minLength: 4)
                Text(Age.describe(session.lastActivityAt)).font(.subheadline).foregroundStyle(Theme.muted).monospacedDigit()
            }
            secondLine.font(.subheadline).lineLimit(1)
            if !recent, let why = third {
                Text(why).font(.footnote).foregroundStyle(Theme.muted).lineLimit(2)
            }
        }
    }

    /// What it asks you, or why it failed, in the agent's own words.
    private var third: String? {
        if session.needsYou { return Presentation.ask(session) }
        return Presentation.failureReason(session)
    }

    private var lastWords: String? { Presentation.firstLine(session.message ?? session.detail) }

    private var secondLine: Text {
        let rest = inProject ? Presentation.agentName(session.agent) : Presentation.subtitle(session)
        if recent, let lastWords {
            return Text(inProject ? lastWords : "\(rest) · \(lastWords)").foregroundStyle(Theme.muted)
        }
        // Needs you and error are the two a glance must catch: their word is in ink, not grey.
        let loud = status.tone == .needsYou || status.tone == .error
        let word = Text(status.text)
            .fontWeight(loud ? .semibold : .regular)
            .foregroundStyle(loud ? Theme.ink : Theme.muted)
        return Text("\(word)\(Text(" · \(rest)").foregroundStyle(Theme.muted))")
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
                        streamDownSince: streamDownSince, now: now)
    }
}

enum Connection {
    struct State {
        let text: String
        let color: Color
        /// Fine: the header's dot says so and no bar is shown.
        var healthy = false
    }

    static func read(snapshot: PhoneSnapshot?, problem: String?, demo: Bool, lastFetch: Date? = nil,
                     mac: MacLiveness = .unknown, streamDownSince: Date? = nil, now: Date = Date()) -> State {
        if demo { return State(text: "Mac connected", color: Theme.working, healthy: true) }
        guard let snapshot else {
            return problem == nil
                ? State(text: "Connecting to your Mac…", color: Theme.subtle)
                : State(text: "Can't reach Squeak's server", color: Theme.offline)
        }
        if problem != nil { return State(text: "Can't reach Squeak's server. Showing the last view.", color: Theme.offline) }
        // A blip is reconnected within a second or two; longer, the view on screen may be out of date, so say so.
        if let down = streamDownSince, now.timeIntervalSince(down) > 5 {
            return State(text: "Reconnecting… showing the view from \(Age.sync(lastFetch ?? down, now: now))", color: Theme.offline)
        }
        // The server answering says nothing about the Mac: asleep, it leaves its last view standing.
        if case .silent(let since) = mac {
            return State(text: "Mac not answering, maybe asleep · last heard \(Age.sync(since, now: now))", color: Theme.offline)
        }
        // "Synced" is when this phone last heard from the server, which is what
        // it can honestly say. The Mac only writes a new view when something
        // changed, so the view's own age is "last change", not staleness.
        let synced = lastFetch.map { "Synced \(Age.sync($0, now: now))" } ?? "Mac connected"
        let minutes = Age.minutes(snapshot.generatedAt, now: now) ?? 0
        let change = minutes >= 2 ? " · last change \(Age.describe(snapshot.generatedAt, now: now)) ago" : ""
        // Healthy while the phone heard from the server in the last minute (a streamed tick is 20s).
        let fresh = lastFetch.map { now.timeIntervalSince($0) < 60 } ?? false
        return State(text: synced + change, color: fresh ? Theme.working : Theme.subtle, healthy: fresh)
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

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 12) {
                if let line = Presentation.firstLine(session.message ?? session.detail) {
                    Text(line).font(.subheadline).foregroundStyle(Theme.muted).lineLimit(3)
                }
                TextField("Reply to \(agentName)…", text: $text, axis: .vertical)
                    .lineLimit(1...6)
                    .focused($focused)
                    .padding(.horizontal, 14).padding(.vertical, 12)
                    .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
                Spacer(minLength: 0)
            }
            .padding(20)
            .background(Theme.bg.ignoresSafeArea())
            .navigationTitle(Presentation.displayTitle(session))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(session.state == "working" ? "Queue" : "Send") {
                        let reply = text
                        dismiss()
                        Task { await model.send(reply, to: session) }
                    }
                    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
        .foregroundStyle(Theme.ink)
        .presentationDetents([.medium])
        .onAppear { focused = true }
    }
}

#endif
