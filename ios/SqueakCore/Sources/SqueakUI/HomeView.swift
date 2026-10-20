#if os(iOS)
import SqueakCore
import SqueakIcons
import SwiftUI

/// DESIGN.md §8.2: every active session, in attention order,
/// under a native large title with search and a segmented filter.
struct HomeView: View {
    @Environment(AppModel.self) private var model
    @ObservedObject private var router = SqueakRouter.shared
    @State private var filter = Presentation.Filter.all
    @State private var query = ""
    @State private var showingSettings = ProcessInfo.processInfo.arguments.contains("-squeak-settings")
    @State private var showingNewChat = ProcessInfo.processInfo.arguments.contains("-squeak-newchat")
        || ProcessInfo.processInfo.arguments.contains("-squeak-newchat-filled")
        || ProcessInfo.processInfo.arguments.contains("-squeak-newchat-error")
    @State private var showingUsage = ProcessInfo.processInfo.arguments.contains("-squeak-usage")
    /// The chat a swipe's Reply is answering, without opening it.
    @State private var quickReply: PhoneSnapshot.Session?
    /// `-squeak-open <key>` starts inside a session: screenshots of the demo only.
    @State private var path: [String] = {
        let args = ProcessInfo.processInfo.arguments
        guard let index = args.firstIndex(of: "-squeak-open"), index + 1 < args.count else { return [] }
        return [args[index + 1]]
    }()

    private var sessions: [PhoneSnapshot.Session] { model.snapshot?.sessions ?? [] }
    /// Chats that are not active any more, to pick up again: only under All, searched like the rest.
    private var recent: [PhoneSnapshot.Session] {
        guard filter == .all, let snapshot = model.snapshot else { return [] }
        let active = Set(sessions.map(\.key))
        return (snapshot.recent ?? []).filter { !active.contains($0.key) && Presentation.matches($0, query: query) }
    }
    private var needsCount: Int { sessions.filter(\.needsYou).count }
    /// Projects whose chats pass the filter and the search ("Projects", DESIGN.md §8.2's rows by repository).
    private var projects: [Presentation.Project] {
        Presentation.projects(sessions.filter { Presentation.inFilter($0, filter) && Presentation.matches($0, query: query) })
    }
    /// Projects showing all their chats, not just the first three.
    @State private var expanded: Set<String> = []
    private static let projectRows = 3

    var body: some View {
        NavigationStack(path: $path) {
            List {
                if model.snapshot != nil {
                    tiles
                    if let starting = model.startingChat { Section { StartingRow(label: starting.label) } }
                    if filter == .all, query.isEmpty, let urgent = Presentation.urgent(sessions) {
                        Section {
                            UrgentCard(session: urgent, onReply: { quickReply = urgent }, onOpen: { path = [urgent.key] })
                                .listRowInsets(EdgeInsets())
                                .listRowBackground(Theme.surface)
                        } footer: {
                            if needsCount > 1 {
                                Text("\(needsCount - 1) more \(needsCount - 1 == 1 ? "needs" : "need") you").font(.footnote).foregroundStyle(Theme.muted)
                            }
                        }
                    }
                    let visible = projects
                    ForEach(Array(visible.enumerated()), id: \.element.id) { index, project in
                        Section {
                            let open = expanded.contains(project.id) || !query.isEmpty
                            let shown = open ? project.sessions : Array(project.sessions.prefix(Self.projectRows))
                            ForEach(shown) { session in
                                NavigationLink(value: session.key) { SessionRow(session: session, inProject: true) }
                                    .listRowBackground(Theme.surface)
                                    .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
                                    .overlay(alignment: .leading) { edge(session) }
                                    .swipeActions(edge: .trailing, allowsFullSwipe: false) { swipeActions(session) }
                            }
                            if project.sessions.count > shown.count {
                                Button { withAnimation { _ = expanded.insert(project.id) } } label: {
                                    Text("\(project.sessions.count - shown.count) more").font(.subheadline.weight(.medium))
                                        .foregroundStyle(Theme.muted).frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                                }
                                .listRowBackground(Theme.surface)
                            }
                        } header: {
                            VStack(alignment: .leading, spacing: 10) {
                                if index == 0 {
                                    Text(filter == .all ? "Projects" : "\(filter.word.prefix(1).uppercased())\(filter.word.dropFirst())")
                                        .font(.headline).foregroundStyle(Theme.ink).accessibilityAddTraits(.isHeader)
                                }
                                ProjectHeader(project: project)
                            }
                        }
                    }
                    let older = recent
                    if !older.isEmpty {
                        Section {
                            ForEach(older) { session in
                                NavigationLink(value: session.key) { SessionRow(session: session, recent: true) }
                                    .listRowBackground(Theme.surface)
                                    .listRowInsets(EdgeInsets(top: 4, leading: 16, bottom: 4, trailing: 16))
                                    .swipeActions(edge: .trailing, allowsFullSwipe: false) { swipeActions(session) }
                            }
                            if query.isEmpty, model.snapshot?.recentMore == true {
                                let waiting = model.recentWanted > older.count
                                Button { model.showMoreRecent() } label: {
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
                        } header: {
                            SectionHeader(title: "Recent", count: older.count)
                        }
                    }
                    if visible.isEmpty && older.isEmpty { noResults }
                } else {
                    waiting
                }
            }
            .listStyle(.insetGrouped)
            .listSectionSpacing(8)
            .scrollContentBackground(.hidden)
            .background(Theme.bg.ignoresSafeArea())
            // Inline, two lines in the bar (like a chat's header): the list is what this screen is for.
            .navigationTitle("Sessions")
            .navigationBarTitleDisplayMode(.inline)
            .searchable(text: $query, prompt: "Search sessions…")
            .navigationDestination(for: String.self) { key in SessionView(key: key) }
            .refreshable { await model.refresh() }
            .toolbar { toolbar }
            .safeAreaInset(edge: .bottom) { ConnectionBar() }
            .sheet(isPresented: $showingSettings) { SettingsView() }
            .sheet(item: $quickReply) { session in QuickReply(session: session) }
            .onAppear {
                // `-squeak-quick <key>`: the swipe's Reply sheet, for screenshots of the demo.
                let args = ProcessInfo.processInfo.arguments
                if let i = args.firstIndex(of: "-squeak-quick"), i + 1 < args.count { quickReply = model.snapshot?.session(args[i + 1]) }
                // `-squeak-filter <working|needsYou|…>`: a tile already tapped, for screenshots.
                if let i = args.firstIndex(of: "-squeak-filter"), i + 1 < args.count, let f = Presentation.Filter(rawValue: args[i + 1]) { filter = f }
            }
            .sheet(isPresented: $showingUsage) { UsageView() }
            .sheet(isPresented: $showingNewChat) { NewChatView(workspaces: model.snapshot?.workspaces ?? []) }
            // A link from a Telegram card: open its session as soon as the
            // snapshot has it, on a fresh stack so Back leads to the list.
            .onChange(of: router.pendingSessionId, initial: true) { _, _ in openPending() }
            .onChange(of: model.snapshot) { _, _ in openPending() }
        }
        .foregroundStyle(Theme.ink)
    }

    /// The status filter (DESIGN.md §3.3): one compact chip per state with its count. Tapping the
    /// one that is on goes back to everything. A state with nothing in it stays (the strip keeps its
    /// shape) but recedes, and scrolls sideways when the words do not fit.
    /// A section header, not a row: an inset-grouped section clips its rows to its own large
    /// rounded shape, which cut the outer chips' corners like a mask.
    private var tiles: some View {
        Section {
        } header: {
            ScrollViewReader { strip in
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 4) {
                        ForEach(Presentation.tiles(sessions), id: \.filter) { tile in
                            StatusTile(filter: tile.filter, count: tile.count, selected: filter == tile.filter) {
                                UISelectionFeedbackGenerator().selectionChanged()
                                withAnimation(.easeOut(duration: 0.15)) { filter = filter == tile.filter ? .all : tile.filter }
                            }
                            .id(tile.filter)
                        }
                    }
                    .padding(.horizontal, 16)
                }
                .scrollBounceBehavior(.basedOnSize, axes: .horizontal)
                // The chip that is on is never left half off the edge.
                .onChange(of: filter, initial: true) { _, now in
                    guard now != .all else { return }
                    withAnimation(.easeOut(duration: 0.15)) { strip.scrollTo(now) }
                }
            }
            .textCase(nil)
            .padding(.horizontal, -32)
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
        ToolbarItem(placement: .principal) {
            VStack(spacing: 1) {
                Text("Sessions").font(.headline)
                if model.snapshot != nil {
                    // The connection lives here while it is fine: a dot, not a bar (ConnectionBar says when it is not).
                    TimelineView(.periodic(from: .now, by: 5)) { _ in
                        let connection = model.connection()
                        HStack(spacing: 5) {
                            StatusDot(color: connection.color).accessibilityHidden(true)
                            Text(subtitle).font(.caption).foregroundStyle(Theme.muted).monospacedDigit()
                        }
                        .accessibilityLabel("\(subtitle), \(connection.text)")
                    }
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isHeader)
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
        ToolbarItem(placement: .topBarTrailing) {
            Button { showingSettings = true } label: {
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
        path = [session.key]
        router.consume()
    }

    /// Answer from the list (§8.2): a swipe offers the agent's lettered options (up to three, as
    /// many as fit) and Reply, for a chat this phone can answer. A letter goes out at once, like a
    /// tap on its card; Reply opens a small field over the list.
    @ViewBuilder
    private func swipeActions(_ session: PhoneSnapshot.Session) -> some View {
        if Presentation.replyBlock(session) == nil, session.conductorSessionId != nil {
            Button { quickReply = session } label: { Label("Reply", systemImage: "arrowshape.turn.up.left") }
                .tint(Theme.subtle)
            if session.state != "working", session.question == nil, let choices = session.choices {
                ForEach(choices.options.prefix(3).reversed(), id: \.letter) { option in
                    Button { Task { await model.send(option.letter, to: session) } } label: { Text(option.letter) }
                        .tint(option.letter == choices.recommended ? Theme.done : Theme.lineStrong)
                        .accessibilityLabel("Send \(option.letter): \(option.title)")
                }
            }
        }
    }

    /// A state colour lives on the dot or the left edge (§3.3), never as a fill.
    @ViewBuilder
    private func edge(_ session: PhoneSnapshot.Session) -> some View {
        // An error carries its colour on the edge too, so it is not just one more dot in the list.
        if session.needsYou || session.state == "error" {
            Capsule().fill(session.needsYou ? Theme.needsYou : Theme.error).frame(width: 3).padding(.vertical, 6).offset(x: -14)
                .accessibilityHidden(true)
        }
    }

    /* ---------- pieces ---------- */

    private var noResults: some View {
        Group {
            if !query.isEmpty {
                ContentUnavailableView.search(text: query)
            } else if sessions.isEmpty {
                VStack(spacing: 12) {
                    Image("duck-asleep", bundle: .module).resizable().scaledToFit().frame(width: 88, height: 88).accessibilityHidden(true)
                    Text("Nothing's running. The duck is resting.").foregroundStyle(Theme.muted)
                }
                .frame(maxWidth: .infinity).padding(.vertical, 40)
            } else {
                ContentUnavailableView {
                    Label {
                        Text(filter == .needsYou ? "Nothing needs you" : "Nothing is \(filter.word)")
                    } icon: {
                        Lucide(filter == .needsYou ? .circleCheck : .moon, size: 28, color: Theme.muted)
                    }
                } description: {
                    Text("Pull down to refresh.")
                }
            }
        }
        .listRowBackground(Color.clear).listRowSeparator(.hidden)
    }

    private var waiting: some View {
        VStack(spacing: 12) {
            ProgressView()
            Text(model.problem ?? "Waiting for your Mac…").foregroundStyle(Theme.muted).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity).padding(.vertical, 40)
        .listRowBackground(Color.clear).listRowSeparator(.hidden)
    }
}

/// The colour for a tone (§3.3): on a dot or an edge only.
func toneColor(_ tone: Presentation.Tone) -> Color {
    switch tone {
    case .needsYou: return Theme.needsYou
    case .working: return Theme.working
    case .done: return Theme.done
    case .error: return Theme.error
    case .idle: return Theme.idle
    }
}

extension Presentation.Filter {
    var tone: Presentation.Tone {
        switch self {
        case .needsYou: return .needsYou
        case .working: return .working
        case .done: return .done
        case .error: return .error
        case .all, .idle: return .idle
        }
    }
}

/// One status chip: its dot, the count, the state's word. A filter: selected, it has an ink edge.
/// A zero recedes (muted, no dot colour) so the states with something in them stand out.
struct StatusTile: View {
    let filter: Presentation.Filter
    let count: Int
    let selected: Bool
    let action: () -> Void

    private var empty: Bool { count == 0 && !selected }

    var body: some View {
        Button(action: action) {
            HStack(spacing: 4) {
                StatusDot(color: empty ? Theme.lineStrong : toneColor(filter.tone))
                Text("\(count)").font(.footnote.weight(.semibold)).monospacedDigit()
                    .foregroundStyle(empty ? Theme.subtle : Theme.ink)
                Text(filter.word).font(.footnote).foregroundStyle(empty ? Theme.subtle : Theme.muted).lineLimit(1)
            }
            .padding(.horizontal, 9)
            .frame(minHeight: 30)
            .background(selected ? Theme.surfaceRaised : Theme.surface, in: Capsule())
            .overlay(Capsule().stroke(selected ? Theme.ink : Theme.line, lineWidth: selected ? 1.5 : 1))
            .overlay(alignment: .leading) {
                // Something needs you: the chip carries the state's edge, like its rows.
                if filter == .needsYou, count > 0 {
                    Capsule().fill(Theme.needsYou).frame(width: 3).padding(.vertical, 8).padding(.leading, 3).accessibilityHidden(true)
                }
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(count) \(filter.word)")
        .accessibilityAddTraits(selected ? .isSelected : [])
        .accessibilityHint(selected ? "Shows everything again" : "Shows only these")
    }
}

/// A project card's heading: the repository, and what its chats are doing in words
/// ("1 working · 1 error"). The rows carry the dots; the heading only sums them up.
struct ProjectHeader: View {
    let project: Presentation.Project

    var body: some View {
        let summary = Presentation.projectSummary(project.sessions)
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(project.name).font(.headline).foregroundStyle(Theme.ink).lineLimit(1)
            Spacer(minLength: 8)
            Text(summary).font(.subheadline).foregroundStyle(Theme.muted).monospacedDigit().lineLimit(1)
        }
        .textCase(nil)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(project.name), \(project.sessions.count == 1 ? "1 chat" : "\(project.sessions.count) chats"), \(summary)")
        .accessibilityAddTraits(.isHeader)
    }
}

/// The newest chat that needs you, first on Home: its question and, when the phone can answer
/// it in one tap, the answers (§8.4). Reply opens the small field; anything else opens the chat.
struct UrgentCard: View {
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
                    StatusDot(color: Theme.needsYou, pulses: true).padding(.top, 7)
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
                    Button("Open chat", action: onOpen).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
                        .frame(minHeight: 44)
                }
                if let outcome { Text(outcome).font(.footnote).foregroundStyle(Theme.muted).lineLimit(2) }
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .overlay(alignment: .leading) {
            Capsule().fill(Theme.needsYou).frame(width: 3).padding(.vertical, 12).padding(.leading, 6).accessibilityHidden(true)
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
        .padding(.vertical, 6).frame(minHeight: 44)
        .listRowBackground(Color.clear)
        .listRowInsets(EdgeInsets(top: 4, leading: 20, bottom: 4, trailing: 20))
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Starting a chat in \(label)")
    }
}

struct SectionHeader: View {
    let title: String
    let count: Int

    var body: some View {
        HStack(spacing: 8) {
            Text(title)
            Text("\(count)").monospacedDigit()
        }
        .font(.subheadline.weight(.semibold))
        .foregroundStyle(Theme.muted)
        .textCase(nil)
        .padding(.leading, 20)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isHeader)
    }
}

struct SessionRow: View {
    @Environment(AppModel.self) private var model
    let session: PhoneSnapshot.Session
    /// A chat from Recent: its second line is what the agent last said, not a state word.
    var recent = false
    /// Inside its project's card: the repo is the card's heading, so the row says only the agent.
    var inProject = false

    /// The Mac's state, except while this phone's own message is about to start a turn: then
    /// "starting", the same rule the chat uses (ChatTimeline.isStarting), so the two agree.
    private var status: Presentation.Status {
        ChatTimeline.isStarting(session: session, sends: model.outbox[session.key] ?? [])
            ? .init(text: "starting", tone: .working)
            : Presentation.status(session)
    }

    var body: some View {
        // §8.2, two lines: dot, title and age; then the state word (or the live step) and
        // `repo · agent`. A recent chat's second line is the agent's last words instead.
        HStack(alignment: .top, spacing: 12) {
            StatusDot(color: dotColor, pulses: status.tone == .needsYou || status.tone == .working, period: status.tone == .working ? 1.6 : 1.0)
                .padding(.top, 7)
            VStack(alignment: .leading, spacing: 2) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(Presentation.displayTitle(session)).font(.headline).lineLimit(2)
                    Spacer(minLength: 4)
                    Text(Age.describe(session.lastActivityAt)).font(.subheadline).foregroundStyle(Theme.muted).monospacedDigit()
                }
                secondLine.font(.subheadline).lineLimit(1)
                // An error says why, in the agent's words, so it can be told apart from a quiet chat.
                if !recent, let reason = failure {
                    Text(reason).font(.footnote).foregroundStyle(Theme.muted).lineLimit(2)
                }
            }
        }
        .padding(.vertical, 4)
        .frame(minHeight: 44)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(Presentation.displayTitle(session)), \(recent ? (lastWords ?? "") : status.text)\(failure.map { ": \($0)" } ?? ""), \(Presentation.subtitle(session)), \(Age.spoken(session.lastActivityAt))")
        .accessibilityHint(failure != nil || status.tone == .error ? "Opens the chat to see what failed" : "")
    }

    private var failure: String? { Presentation.failureReason(session) }

    private var lastWords: String? { Presentation.firstLine(session.message ?? session.detail) }

    private var secondLine: Text {
        if recent, let lastWords {
            return Text(lastWords).foregroundStyle(Theme.muted)
        }
        // Needs you and error are the two a glance must catch: their word is in ink, not grey.
        let loud = status.tone == .needsYou || status.tone == .error
        let word = Text(status.text)
            .fontWeight(loud ? .semibold : .regular)
            .foregroundStyle(loud ? Theme.ink : Theme.muted)
        let rest = inProject ? Presentation.agentName(session.agent) : Presentation.subtitle(session)
        return Text("\(word)\(Text(" · \(rest)").foregroundStyle(Theme.muted))")
    }

    private var dotColor: Color {
        switch status.tone {
        case .needsYou: return Theme.needsYou
        case .working: return Theme.working
        case .done: return Theme.done
        case .error: return Theme.error
        case .idle: return Theme.idle
        }
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
