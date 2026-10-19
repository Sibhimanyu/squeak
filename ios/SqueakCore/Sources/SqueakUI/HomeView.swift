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
    @State private var showingUsage = ProcessInfo.processInfo.arguments.contains("-squeak-usage")
    /// `-squeak-open <key>` starts inside a session: screenshots of the demo only.
    @State private var path: [String] = {
        let args = ProcessInfo.processInfo.arguments
        guard let index = args.firstIndex(of: "-squeak-open"), index + 1 < args.count else { return [] }
        return [args[index + 1]]
    }()

    private var sessions: [PhoneSnapshot.Session] { model.snapshot?.sessions ?? [] }
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
                    Text(subtitle).font(.body).foregroundStyle(Theme.muted)
                        .listRowBackground(Color.clear).listRowSeparator(.hidden)
                        .listRowInsets(EdgeInsets(top: 0, leading: 20, bottom: 0, trailing: 20))
                    controls
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
                    if visible.isEmpty { noResults }
                } else {
                    waiting
                }
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Theme.bg.ignoresSafeArea())
            .navigationTitle("Sessions")
            .navigationBarTitleDisplayMode(.large)
            .searchable(text: $query, prompt: "Search sessions…")
            .navigationDestination(for: String.self) { key in SessionView(key: key) }
            .refreshable { await model.refresh() }
            .toolbar { toolbar }
            .safeAreaInset(edge: .bottom) { ConnectionBar() }
            .sheet(isPresented: $showingSettings) { SettingsView() }
            .sheet(isPresented: $showingUsage) { UsageView() }
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
        return count == 0 ? "Nothing active on your Mac" : "\(count) active across your Mac"
    }

    private func openPending() {
        guard let id = router.pendingSessionId,
              let session = model.snapshot?.sessions.first(where: { $0.conductorSessionId == id })
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
            .listRowBackground(Color.clear)
            .listRowSeparator(.hidden)
            .listRowInsets(EdgeInsets(top: 4, leading: 20, bottom: 8, trailing: 20))
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
    let session: PhoneSnapshot.Session

    private var status: Presentation.Status { Presentation.status(session) }

    var body: some View {
        // §8.2: dot, then title and age, `repo · agent`, and the state word or the live step.
        HStack(alignment: .top, spacing: 12) {
            StatusDot(color: dotColor, pulses: status.tone == .needsYou || status.tone == .working, period: status.tone == .working ? 1.6 : 1.0)
                .padding(.top, 7)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(Presentation.displayTitle(session)).font(.headline).lineLimit(1)
                    Spacer(minLength: 4)
                    Text(Age.describe(session.lastActivityAt)).font(.subheadline).foregroundStyle(Theme.muted).monospacedDigit()
                }
                Text(Presentation.subtitle(session)).font(.subheadline).foregroundStyle(Theme.muted).lineLimit(1)
                Text(status.text).font(.subheadline.weight(status.tone == .needsYou ? .semibold : .regular))
                    .foregroundStyle(status.tone == .needsYou ? Theme.ink : Theme.muted).lineLimit(1)
            }
        }
        .padding(.vertical, 6)
        .frame(minHeight: 44)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(Presentation.displayTitle(session)), \(Presentation.subtitle(session)), \(status.text), \(Age.spoken(session.lastActivityAt))")
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
        TimelineView(.periodic(from: .now, by: 20)) { _ in
            let state = Connection.read(snapshot: model.snapshot, problem: model.problem, demo: model.demo)
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

enum Connection {
    struct State { let text: String; let color: Color }

    static func read(snapshot: PhoneSnapshot?, problem: String?, demo: Bool) -> State {
        if demo { return State(text: "Mac connected", color: Theme.working) }
        guard let snapshot else {
            return problem == nil
                ? State(text: "Connecting to your Mac…", color: Theme.subtle)
                : State(text: "Can't reach Squeak's server", color: Theme.offline)
        }
        if problem != nil { return State(text: "Can't reach Squeak's server. Showing the last view.", color: Theme.offline) }
        let age = Age.describe(snapshot.generatedAt)
        let minutes = Age.minutes(snapshot.generatedAt) ?? 0
        return State(text: minutes >= 2 ? "Mac connected · updated \(age) ago" : "Mac connected", color: Theme.working)
    }
}

#endif
