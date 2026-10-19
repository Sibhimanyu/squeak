#if os(iOS)
import SqueakCore
import SqueakIcons
import SwiftUI

/// DESIGN.md §8.2: every active session, in attention order,
/// under a native large title with search and a segmented filter.
struct HomeView: View {
    @EnvironmentObject var model: AppModel
    @ObservedObject private var router = SqueakRouter.shared
    @State private var filter = Presentation.Filter.all
    @State private var query = ""
    @State private var showingSettings = ProcessInfo.processInfo.arguments.contains("-squeak-settings")
    @State private var showingNewChat = ProcessInfo.processInfo.arguments.contains("-squeak-newchat")
        || ProcessInfo.processInfo.arguments.contains("-squeak-newchat-filled")
        || ProcessInfo.processInfo.arguments.contains("-squeak-newchat-error")
    @State private var showingUsage = ProcessInfo.processInfo.arguments.contains("-squeak-usage")
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

    /// Sections in attention order (DESIGN.md §8.2), filtered and searched.
    private var groups: [(title: String, members: [PhoneSnapshot.Session])] {
        PhoneSnapshot.groups.compactMap { group in
            let members = sessions.filter {
                group.states.contains($0.state) && Presentation.inFilter($0, filter) && Presentation.matches($0, query: query)
            }
            return members.isEmpty ? nil : (group.title, members)
        }
    }

    var body: some View {
        NavigationStack(path: $path) {
            List {
                if model.snapshot != nil {
                    controls
                    if let starting = model.startingChat { StartingRow(label: starting.label) }
                    let visible = groups
                    ForEach(visible, id: \.title) { group in
                        let rows = group.members
                        Section {
                            ForEach(rows) { session in
                                NavigationLink(value: session.key) { SessionRow(session: session) }
                                    .listRowBackground(Color.clear)
                                    .listRowInsets(EdgeInsets(top: 4, leading: 20, bottom: 4, trailing: 20))
                                    .overlay(alignment: .leading) { edge(session) }
                            }
                        } header: {
                            SectionHeader(title: group.title, count: rows.count)
                        }
                    }
                    let older = recent
                    if !older.isEmpty {
                        Section {
                            ForEach(older) { session in
                                NavigationLink(value: session.key) { SessionRow(session: session, recent: true) }
                                    .listRowBackground(Color.clear)
                                    .listRowInsets(EdgeInsets(top: 4, leading: 20, bottom: 4, trailing: 20))
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
                                .listRowBackground(Color.clear)
                                .listRowSeparator(.hidden)
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
            .listStyle(.plain)
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
            .sheet(isPresented: $showingUsage) { UsageView() }
            .sheet(isPresented: $showingNewChat) { NewChatView(workspaces: model.snapshot?.workspaces ?? []) }
            // A link from a Telegram card: open its session as soon as the
            // snapshot has it, on a fresh stack so Back leads to the list.
            .onChange(of: router.pendingSessionId, initial: true) { _, _ in openPending() }
            .onChange(of: model.snapshot) { _, _ in openPending() }
        }
        .foregroundStyle(Theme.ink)
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
                        let connection = Connection.read(snapshot: model.snapshot, problem: model.problem, demo: model.demo, lastFetch: model.lastFetch)
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
        let count = sessions.count
        return count == 0 ? "Nothing active" : "\(count) active"
    }

    private func openPending() {
        guard let id = router.pendingSessionId,
              let session = model.snapshot?.allSessions.first(where: { $0.conductorSessionId == id })
        else { return }
        path = [session.key]
        router.consume()
    }

    /// A state colour lives on the dot or the left edge (§3.3), never as a fill.
    @ViewBuilder
    private func edge(_ session: PhoneSnapshot.Session) -> some View {
        if session.needsYou {
            Capsule().fill(Theme.needsYou).frame(width: 3).padding(.vertical, 6).offset(x: -12)
                .accessibilityHidden(true)
        }
    }

    /* ---------- pieces ---------- */

    @ViewBuilder
    private var controls: some View {
        Section {
            Picker("Show", selection: $filter) {
                Text("All").tag(Presentation.Filter.all)
                Text(needsCount > 0 ? "Needs you \(needsCount)" : "Needs you").tag(Presentation.Filter.needsYou)
                Text("Working").tag(Presentation.Filter.working)
            }
            .pickerStyle(.segmented)
            .controlSize(.small)
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: 2, leading: 20, bottom: 4, trailing: 20))
        }
    }

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
                        Text(filter == .needsYou ? "Nothing needs you" : "Nothing is working")
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
    @EnvironmentObject var model: AppModel
    let session: PhoneSnapshot.Session
    /// A chat from Recent: its second line is what the agent last said, not a state word.
    var recent = false

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
                    Text(Presentation.displayTitle(session)).font(.headline).lineLimit(1)
                    Spacer(minLength: 4)
                    Text(Age.describe(session.lastActivityAt)).font(.subheadline).foregroundStyle(Theme.muted).monospacedDigit()
                }
                secondLine.font(.subheadline).lineLimit(1)
            }
        }
        .padding(.vertical, 4)
        .frame(minHeight: 44)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(Presentation.displayTitle(session)), \(recent ? (lastWords ?? "") : status.text), \(Presentation.subtitle(session)), \(Age.spoken(session.lastActivityAt))")
    }

    private var lastWords: String? { Presentation.firstLine(session.message ?? session.detail) }

    private var secondLine: Text {
        if recent, let lastWords {
            return Text(lastWords).foregroundStyle(Theme.muted)
        }
        let word = Text(status.text)
            .fontWeight(status.tone == .needsYou ? .semibold : .regular)
            .foregroundStyle(status.tone == .needsYou ? Theme.ink : Theme.muted)
        return Text("\(word)\(Text(" · \(Presentation.subtitle(session))").foregroundStyle(Theme.muted))")
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
    @EnvironmentObject var model: AppModel

    var body: some View {
        TimelineView(.periodic(from: .now, by: 2)) { _ in
            let state = Connection.read(snapshot: model.snapshot, problem: model.problem, demo: model.demo, lastFetch: model.lastFetch)
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

enum Connection {
    struct State {
        let text: String
        let color: Color
        /// Fine: the header's dot says so and no bar is shown.
        var healthy = false
    }

    static func read(snapshot: PhoneSnapshot?, problem: String?, demo: Bool, lastFetch: Date? = nil, now: Date = Date()) -> State {
        if demo { return State(text: "Mac connected", color: Theme.working, healthy: true) }
        guard let snapshot else {
            return problem == nil
                ? State(text: "Connecting to your Mac…", color: Theme.subtle)
                : State(text: "Can't reach Squeak's server", color: Theme.offline)
        }
        if problem != nil { return State(text: "Can't reach Squeak's server. Showing the last view.", color: Theme.offline) }
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

#endif
