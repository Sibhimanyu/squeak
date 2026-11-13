#if os(iOS)
import SqueakCore
import SqueakIcons
import SwiftUI

/// Where a tab's stack can go: a pond and what is in it, a group of chats (a state, the older ones) or one chat.
enum HomeRoute: Hashable {
    case session(String)
    case pond(String)
    case stream(String, String)
    case scope(String, PondScope)
    case archived(String)
    case status(Presentation.Filter)
    case recent
    case film(String)
}

/// One group's chats: a state's, or the older ones. Needs you shows each chat as a card with its question and
/// one-tap answers; every other group is plain rows.
struct GroupView: View {
    @Environment(AppModel.self) private var model
    let route: HomeRoute
    @Binding var path: [HomeRoute]

    var body: some View {
        switch route {
        case .recent: EarlierView(path: $path)
        case .status(.needsYou): NeedsYouPage(path: $path)
        case .status(let filter):
            ThreadListPage(title: filter.heading, sessions: Presentation.newestFirst(model.home.sessions.filter { Presentation.inFilter($0, filter) }))
        default: ThreadListPage(title: "Older chats", sessions: [])
        }
    }
}

/// A flat list of chats, newest first, held still under a finger (`StableOrder`): a state's, a scope's of one pond, a
/// stream's; quiet chats list under Earlier. A pond or stream page starts a thread right there.
struct ThreadListPage: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    var title: String
    var sessions: [PhoneSnapshot.Session]
    var emptyTitle = "Nothing here now"
    var emptyText = "Pull down to refresh."
    /// In a pond the rows leave out the pond's name.
    var inPond = false
    /// Where "New thread" starts: a pond (by name) and optionally one of its streams.
    var newThread: NewThreadTarget?
    @State private var quickReply: PhoneSnapshot.Session?
    @State private var starting = false
    @State private var shownOrder: [String] = []

    var body: some View {
        // Chats the Mac still lists as active read as live rows; the rest wait under Earlier.
        let live = Set(model.home.sessions.map(\.key))
        let both = StableOrder.arrange(sessions, previous: shownOrder) { $0.key }
        let activeKeys = live
        let active = both.filter { activeKeys.contains($0.key) }
        let quiet = both.filter { !activeKeys.contains($0.key) }
        List {
            if !active.isEmpty {
                Section { ForEach(active) { row($0, recent: false) } }
            }
            if !quiet.isEmpty {
                Section { ForEach(quiet) { row($0, recent: true) } } header: { if !active.isEmpty { Text("Earlier") } }
            }
            if active.isEmpty && quiet.isEmpty {
                ContentUnavailableView {
                    Label { Text(emptyTitle) } icon: { Lucide(.circleCheck, size: 28, color: Theme.muted) }
                } description: { Text(emptyText) }
                    .listRowBackground(Color.clear).listRowSeparator(.hidden)
            }
        }
        .listStyle(.insetGrouped)
        .listSectionSpacing(16)
        .scrollContentBackground(.hidden)
        .background(Theme.bg.ignoresSafeArea())
        .navigationTitle(title)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { Haptics.play(.refresh); shownOrder = []; await model.refresh() }
        .onAppear { shownOrder = [] }
        .onChange(of: both.map(\.key), initial: true) { _, keys in shownOrder = keys }
        .overlay(alignment: .bottom) { ConnectionBar() }
        .sheet(item: $quickReply) { session in QuickReply(session: session) }
        .toolbar {
            if let target = newThread, model.home.workspaces != nil || model.snapshot?.nativeProjects?.isEmpty == false {
                ToolbarItem(placement: .topBarTrailing) {
                    Button { Haptics.play(.tap); starting = true } label: {
                        Lucide(.squarePen, size: 20, label: "New thread in \(target.stream ?? target.pond)", color: Theme.muted)
                    }
                }
            }
        }
        .sheet(isPresented: $starting) { if let target = newThread { NewChatEntry(project: target.pond, workspaceId: target.workspaceId) } }
        .foregroundStyle(Theme.ink)
    }

    private func row(_ session: PhoneSnapshot.Session, recent: Bool) -> some View {
        NavigationLink(value: HomeRoute.session(session.key)) {
            SessionRow(session: session, recent: recent, inProject: inPond)
        }.tapHaptic(.navigate)
            .homeRow(needsYou: !recent && session.needsYou, edge: MarkGlyph.edge(session))
            .modifier(SessionSwipe(session: session) { quickReply = session })
    }
}

/// Which pond (and stream) a New thread sheet starts in.
struct NewThreadTarget: Equatable {
    var pond: String
    var stream: String?
    var workspaceId: String?
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

    private var canReply: Bool { Presentation.replyBlock(session) == nil && session.can(.reply) }
    /// Archive is offered only when the Mac lists it for this chat, and not while the chat works or waits on you.
    private var canArchive: Bool { session.can(.archiveChat) && session.state != "working" && !session.needsYou }

    func body(content: Content) -> some View {
        content
            .swipeActions(edge: .trailing, allowsFullSwipe: false) {
                if canArchive {
                    Button(action: { Haptics.play(.tap); model.archiveChatTarget = session }) { Label("Archive", systemImage: "archivebox") }
                        .tint(Theme.subtle)
                }
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
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let session: PhoneSnapshot.Session
    /// A chat from Earlier: its second line is what the agent last said, not a state word.
    var recent = false
    /// Inside its project: the project is the screen's title, so the row says only the agent.
    var inProject = false

    /// "Starting" while this phone's own message is about to begin a turn: the same rule the chat uses
    /// (ChatTimeline.isStarting), so the two agree.
    private var starting: Bool { ChatTimeline.isStarting(session: session, sends: model.outbox[session.key] ?? []) }

    private var mark: Presentation.Mark {
        starting ? .working : Presentation.mark(session, unread: unread)
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            AgentAvatar(session: session, size: inProject ? 24 : (recent ? 36 : 28), conductorBadge: false).padding(.top, 2)
            rowText
        }
        .padding(.vertical, inProject ? 8 : (recent ? 6 : 2))
        .frame(minHeight: 44)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(Presentation.rowLabel(session, mark: mark))\(secondLine.map { ": \($0)" } ?? ""), \(Presentation.subtitle(session))")
        .accessibilityHint(session.state == "error" ? "Opens the chat to see what failed" : "")
        .renameMenu(session, model: model)
    }

    private var unread: Bool { inProject ? model.isProjectUnread(session) : model.isUnread(session) }

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
                .runningTextLight(starting || session.state == "working", identity: session.key, still: !model.macIsLive)
            if session.isConductor { ConductorMarker() }
            Spacer(minLength: 4)
            CornerMark(mark: mark, age: session.lastActivityAt, session: session)
        }
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
                if session.isConductor, let open = session.open { OpenTag(open: open) }
            }
            .padding(.top, 2)
        }
    }

    @ViewBuilder
    private var rowText: some View {
        if inProject { activeText } else if recent { recentText } else { activeText }
    }

    /// Title and one muted line; no state word, no agent, no repo (the mark and the avatar say them).
    private var activeText: some View {
        VStack(alignment: .leading, spacing: inProject ? 4 : 2) {
            titleLine
            HStack(spacing: 12) {
                if let secondLine {
                    Text(secondLine).font(.subheadline).foregroundStyle(Theme.muted)
                        .lineLimit(dynamicTypeSize.isAccessibilitySize ? 2 : 1)
                        .runningTextLight(starting || session.state == "working", identity: session.key, still: !model.macIsLive)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else { Spacer(minLength: 0) }
                DucklingCount(session: session)
                if starting || session.state == "working" { ChatActivityGlyph(identity: session.key) }
            }
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
            .accessibilityLabel(open ? "Open on your Mac" : "Closed on your Mac")
    }
}

/// "Mac connected", and honest when it is not: the phone only knows its
/// last successful read of the Mac's snapshot, so that is all it claims. It is drawn over the bottom edge, never as a
/// safe-area inset: coming and going must not resize the scroll area under the person's finger.
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
        // A failed read or a saved view shows only once it has lasted: one slow request that the retry heals is not news.
        // With no view at all there is nothing to jump, so the problem is said at once.
        let problemLasts = statusDebounce.settled("problem", active: problem != nil, after: 4, now: now)
        let savedLasts = statusDebounce.settled("saved", active: showingSaved, after: 2, now: now)
        return Connection.read(snapshot: snapshot, problem: problemLasts || snapshot == nil ? problem : nil, demo: demo,
                        lastFetch: lastFetch, mac: macLiveness(now: now),
                        route: route, phoneOffline: phoneOffline && !demo, macAliveAt: macAliveAt,
                        streamDownSince: streamDownSince, saved: savedLasts, now: now)
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
        case .connected: Theme.success
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



#endif
