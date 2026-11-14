#if os(iOS)
import SqueakCore
import SqueakIcons
import SwiftUI
import UIKit

/// Where a stack's routes land: a chat, a film, a pond and what is in it, or a group of chats.
struct RouteView: View {
    let route: HomeRoute
    @Binding var path: [HomeRoute]

    var body: some View {
        switch route {
        case .session(let key): SessionView(key: key, path: $path)
        case .film(let id): FilmView(id: id)
        case .pond(let id): PondDashboard(id: id, path: $path).screenName("Pond")
        case .stream(let pond, let id): StreamPage(pondId: pond, streamId: id).screenName("Stream")
        case .scope(let pond, let scope): ScopePage(pondId: pond, scope: scope)
        case .archived(let pond): ArchivedStreamsPage(pondId: pond)
        case .status, .recent: GroupView(route: route, path: $path)
        }
    }
}

extension PondItem {
    /// The pond's colour from the Mac, if it sent one.
    var tint: Color? { PondList.colourHex(meta.colour).map { Color(UIColor(hex: $0)) } }
}

/* ---------- the Ponds tab ---------- */

/// Ponds: every project is a pond. Inset-grouped list, your order or newest first, hide what you do not need,
/// search across ponds, streams and threads. Chats with no pond sit under Other.
struct PondsTab: View {
    @Environment(AppModel.self) private var model
    @Environment(\.squeakScreen) private var screen
    @Bindable var nav: AppNav
    /// An app that hosts this view as its own tab has no bar here: Usage and Settings come from the toolbar.
    var embedded = false
    @AppStorage("pondsShowHidden") private var showHidden = ProcessInfo.processInfo.arguments.contains("-squeak-show-hidden")
    @State private var query = ""
    @State private var label: String?
    @State private var editMode: EditMode = .inactive
    @State private var newThread: NewThreadTarget?
    @State private var startingChat = ProcessInfo.processInfo.arguments.contains { $0.hasPrefix("-squeak-newchat") }
    @State private var showingSettings = false
    @State private var otherOpen = false

    var body: some View {
        NavigationStack(path: $nav.ponds) {
            Group {
                if !model.home.present { ScrollView { waiting } } else { list }
            }
            .background(Theme.bg.ignoresSafeArea())
            .navigationTitle("Ponds")
            .navigationBarTitleDisplayMode(.large)
            .searchable(text: $query, prompt: "Search ponds, streams, threads")
            .navigationDestination(for: HomeRoute.self) { RouteView(route: $0, path: $nav.ponds) }
            .refreshable { Haptics.play(.refresh); await model.refresh() }
            .toolbar { toolbar }
            .overlay(alignment: .bottom) { ConnectionBar() }
            .sheet(isPresented: $startingChat) { NewChatEntry() }
            .sheet(item: $newThread) { NewChatEntry(project: $0.pond, workspaceId: $0.workspaceId) }
            .sheet(isPresented: $showingSettings) { SettingsView().screenName("Settings") }
        }
        .foregroundStyle(Theme.ink)
        .navigationHaptic(count: nav.ponds.count)
        .onAppear { if nav.ponds.isEmpty { screen.report?("Ponds") } }
    }

    private var built: PondList.Built { model.pondBuilt }

    private var list: some View {
        let ordered = PondList.ordered(built.ponds, mode: model.pondOrderMode)
        let shown = PondList.visible(ordered, showHidden: showHidden, label: label, query: query)
        let other = label == nil ? PondList.otherMatching(built.other, query: query) : []
        return List {
            if let starting = model.startingChat { StartingRow(label: starting.label) }
            if !shown.items.isEmpty {
                Section {
                    ForEach(shown.items) { item in
                        PondRow(item: item)
                            .swipeActions(edge: .trailing, allowsFullSwipe: true) { hideButton(item) }
                            .contextMenu {
                                Button { Haptics.play(.tap); newThread = NewThreadTarget(pond: item.name) } label: { Label("New thread", systemImage: "square.and.pencil") }
                                hideButton(item)
                                Button { Haptics.play(.navigate); nav.ponds.append(.pond(item.id)) } label: { Label("Open dashboard", systemImage: "rectangle.grid.2x2") }
                            }
                    }
                    .onMove { from, to in
                        let full = ordered.map(\.orderKey)
                        model.setPondOrder(.manual(PondList.reordered(full: full, visible: shown.items.map(\.orderKey), moving: from, to: to)))
                    }
                } footer: { hiddenFooter(shown.hiddenCount) }
            } else if shown.hiddenCount > 0 {
                Section { EmptyView() } footer: { hiddenFooter(shown.hiddenCount) }
            }
            if !other.isEmpty {
                Section {
                    DisclosureGroup(isExpanded: $otherOpen) {
                        ForEach(other) { session in
                            NavigationLink(value: HomeRoute.session(session.key)) { SessionRow(session: session, recent: false) }
                                .tapHaptic(.navigate)
                        }
                    } label: {
                        HStack {
                            Label("Other", systemImage: "tray").frame(minHeight: 44)
                            Spacer(minLength: 4)
                            Text("\(other.count)").font(.footnote).monospacedDigit().foregroundStyle(Theme.muted)
                        }
                    }
                    .accessibilityLabel("Other, \(PondList.threadCount(other.count)) in no pond")
                }
            }
            if shown.items.isEmpty, other.isEmpty, shown.hiddenCount == 0 { empty }
            if !model.recentChats.isEmpty, query.isEmpty {
                Section {
                    NavigationLink(value: HomeRoute.recent) {
                        Label("Older threads", systemImage: "clock.arrow.circlepath").frame(minHeight: 44)
                    }.tapHaptic(.navigate)
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .environment(\.editMode, $editMode)
        .contentMargins(.bottom, 24, for: .scrollContent)
    }

    @ViewBuilder private func hiddenFooter(_ count: Int) -> some View {
        if count > 0 {
            HStack {
                Text("\(count) hidden")
                Button("Show") { Haptics.play(.tap); showHidden = true }
            }
            .font(.footnote)
        }
    }

    private func hideButton(_ item: PondItem) -> some View {
        Button { Haptics.play(.tap); model.setPondHidden(item.id, !item.hidden) } label: {
            Label(item.hidden ? "Unhide" : "Hide", systemImage: item.hidden ? "eye" : "eye.slash")
        }
        .tint(Theme.subtle)
    }

    @ViewBuilder private var empty: some View {
        if query.isEmpty && label == nil {
            VStack(spacing: 12) {
                Image("duck-asleep", bundle: .module).resizable().scaledToFit().frame(width: 88, height: 88).accessibilityHidden(true)
                Text("No ponds yet. Start a thread on your Mac and its project appears here.").foregroundStyle(Theme.muted)
                    .multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity).padding(.vertical, 32)
            .listRowBackground(Color.clear).listRowSeparator(.hidden)
        } else {
            ContentUnavailableView.search(text: query).listRowBackground(Color.clear).listRowSeparator(.hidden)
        }
    }

    private var waiting: some View {
        SkeletonRows(word: model.problem ?? "Waiting for your Mac…", rows: 4, rowHeight: 64)
            .padding(.horizontal, 20).padding(.vertical, 24)
    }

    @ToolbarContentBuilder private var toolbar: some ToolbarContent {
        if built.ponds.count > 1 {
            ToolbarItem(placement: .topBarLeading) { EditButton() }
        }
        if embedded {
            ToolbarItem(placement: .topBarLeading) {
                Button { Haptics.play(.tap); showingSettings = true } label: { Image(systemName: "gearshape") }
                    .accessibilityLabel("Settings")
            }
        }
        ToolbarItem(placement: .topBarTrailing) { MacSwitcherButton() }
        ToolbarItem(placement: .topBarTrailing) { filterMenu }
        if model.home.workspaces != nil || model.snapshot?.nativeProjects?.isEmpty == false {
            ToolbarItem(placement: .topBarTrailing) {
                Button { Haptics.play(.tap); startingChat = true } label: { Image(systemName: "square.and.pencil") }
                    .accessibilityLabel("New thread")
            }
        }
    }

    private var filterMenu: some View {
        let labels = PondList.labels(built.ponds)
        return Menu {
            Picker("Order", selection: Binding(
                get: { if case .manual = model.pondOrderMode { true } else { false } },
                set: { manual in
                    Haptics.play(.pick)
                    model.setPondOrder(manual ? .manual(PondList.ordered(built.ponds, mode: model.pondOrderMode).map(\.orderKey)) : .newest)
                })) {
                Text("Newest first").tag(false)
                Text("Your order").tag(true)
            }
            Toggle("Show hidden ponds", isOn: $showHidden)
            if !labels.isEmpty {
                Picker("Label", selection: $label) {
                    Text("All labels").tag(String?.none)
                    ForEach(labels, id: \.self) { Text($0).tag(String?.some($0)) }
                }
            }
        } label: {
            Image(systemName: label != nil || showHidden ? "line.3.horizontal.decrease.circle.fill" : "line.3.horizontal.decrease.circle")
        }
        .accessibilityLabel("Filter and order")
    }
}

extension NewThreadTarget: Identifiable { var id: String { pond + "/" + (workspaceId ?? "") } }

/// One pond in a list: its icon, name, the newest thread, and what needs you or runs.
struct PondRow: View {
    @Environment(AppModel.self) private var model
    let item: PondItem
    @ScaledMetric(relativeTo: .body) private var mark = 44

    private var subtitle: String {
        let newest = item.sessions.first.map(Presentation.displayTitle)
        var parts: [String] = []
        if item.hidden { parts.append("Hidden") }
        if item.joined { parts.append("Joined") }
        parts.append(newest ?? "No threads yet")
        if item.shared, item.online > 0 { parts.append("\(item.online) online") }
        return parts.joined(separator: " · ")
    }

    var body: some View {
        NavigationLink(value: HomeRoute.pond(item.id)) {
            HStack(spacing: 12) {
                PondMark(item: item, size: mark)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(item.name).font(.headline).foregroundStyle(item.hidden ? Theme.muted : Theme.ink).lineLimit(1)
                        if item.shared { SharedPondMark(pond: item.pond) }
                    }
                    Text(subtitle).font(.subheadline).foregroundStyle(Theme.muted).lineLimit(1)
                }
                Spacer(minLength: 4)
                VStack(alignment: .trailing, spacing: 4) {
                    if item.needsYou > 0 { CountBadge(count: item.needsYou) }
                    if item.working > 0 {
                        HStack(spacing: 4) {
                            StatusDot(color: Theme.working)
                            Text("\(item.working)").font(.footnote).monospacedDigit().foregroundStyle(Theme.muted)
                        }
                    }
                }
            }
            .frame(minHeight: 52)
        }
        .tapHaptic(.navigate)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(item.name), \(item.shared ? "shared pond, " : "")\(PondList.threadCount(item.sessions.count))"
            + (item.needsYou > 0 ? ", \(item.needsYou) waiting for you" : "") + (item.working > 0 ? ", \(item.working) working" : "")
            + (item.hidden ? ", hidden" : ""))
    }
}

/* ---------- a pond's dashboard ---------- */

struct PondDashboard: View {
    @Environment(AppModel.self) private var model
    let id: String
    @Binding var path: [HomeRoute]
    @State private var newThread: NewThreadTarget?

    var body: some View {
        if let item = model.pondItem(id) {
            dashboard(item)
        } else {
            ContentUnavailableView("This pond isn't here", systemImage: "drop", description: Text("Pull down on Ponds to refresh."))
                .background(Theme.bg.ignoresSafeArea())
        }
    }

    private func dashboard(_ item: PondItem) -> some View {
        let streams = PondList.streams(item)
        let detail = model.pondDetail(item.id)
        return List {
            Section { header(item) }
                .listRowBackground(Color.clear).listRowInsets(EdgeInsets(top: 0, leading: 16, bottom: 4, trailing: 16))
            Section { tiles(item) }
                .listRowBackground(Color.clear).listRowInsets(EdgeInsets())
            if let waiting = detail?.waiting, !waiting.isEmpty {
                Section {
                    ForEach(waiting, id: \.self) { name in
                        Label { Text(name) } icon: { Image(systemName: "person.badge.clock").foregroundStyle(Theme.muted) }.frame(minHeight: 44)
                    }
                } header: { Text("Waiting to join") } footer: { Text("Approve people on your Mac.") }
            }
            Section("Streams") {
                if streams.live.isEmpty && streams.archived == 0 {
                    Text("No streams yet").foregroundStyle(Theme.muted).frame(minHeight: 44)
                }
                ForEach(streams.live) { stream in
                    NavigationLink(value: HomeRoute.stream(item.id, stream.id)) { StreamRow(stream: stream) }.tapHaptic(.navigate)
                }
                if streams.archived > 0 {
                    NavigationLink(value: HomeRoute.archived(item.id)) {
                        Label { Text("Archived (\(streams.archived))") } icon: { Image(systemName: "archivebox").foregroundStyle(Theme.muted) }
                            .frame(minHeight: 44)
                    }.tapHaptic(.navigate)
                }
            }
            if let pond = item.pond, !pond.members.isEmpty || !(detail?.invites ?? []).isEmpty {
                Section("Flock") {
                    ForEach(Array(pond.members.enumerated()), id: \.offset) { _, member in
                        HStack(spacing: 10) {
                            Circle().fill(member.online ? Theme.success : Theme.subtle.opacity(0.5)).frame(width: 8, height: 8)
                            Text(member.name)
                            Spacer()
                            Text(member.online ? "Online" : "Away").font(.footnote).foregroundStyle(Theme.muted)
                        }
                        .frame(minHeight: 44)
                        .accessibilityElement(children: .combine)
                        .accessibilityLabel("\(member.name), \(member.online ? "online" : "away")")
                    }
                    ForEach(detail?.invites ?? [], id: \.label) { invite in
                        HStack {
                            Label(invite.label, systemImage: "envelope").foregroundStyle(Theme.muted)
                            Spacer()
                            if let at = invite.expiresAt { Text("Expires \(Age.describe(at))").font(.footnote).foregroundStyle(Theme.subtle) }
                        }.frame(minHeight: 44)
                    }
                }
            }
            if let ripples = detail?.ripples, !ripples.isEmpty {
                Section("Ripples") {
                    ForEach(ripples) { ripple in
                        VStack(alignment: .leading, spacing: 2) {
                            Text(ripple.text)
                            Text([ripple.who, Age.describe(ripple.at)].compactMap { $0 }.joined(separator: " · "))
                                .font(.footnote).foregroundStyle(Theme.muted)
                        }
                        .padding(.vertical, 4)
                        .accessibilityElement(children: .combine)
                    }
                }
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Theme.bg.ignoresSafeArea())
        .navigationTitle(item.name)
        .navigationBarTitleDisplayMode(.large)
        .refreshable { Haptics.play(.refresh); await model.refresh() }
        .onAppear { model.openPond(item.id) }
        // Pushing a page inside the pond (its threads, a chat) covers the dashboard but leaves the pond open here.
        .onDisappear { if !path.contains(.pond(item.id)) { model.openPond(nil, if: item.id) } }
        .contentMargins(.bottom, 24, for: .scrollContent)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    Button { Haptics.play(.tap); newThread = NewThreadTarget(pond: item.name) } label: { Label("New thread in this pond", systemImage: "square.and.pencil") }
                    Button { Haptics.play(.tap); model.setPondHidden(item.id, !item.hidden) } label: {
                        Label(item.hidden ? "Unhide pond" : "Hide pond", systemImage: item.hidden ? "eye" : "eye.slash")
                    }
                } label: { Image(systemName: "plus") }
                    .accessibilityLabel("Add")
            }
        }
        .sheet(item: $newThread) { NewChatEntry(project: $0.pond, workspaceId: $0.workspaceId) }
        .foregroundStyle(Theme.ink)
    }

    private func header(_ item: PondItem) -> some View {
        HStack(spacing: 14) {
            PondMark(item: item, size: 56)
            VStack(alignment: .leading, spacing: 3) {
                Text(accessLine(item)).font(.subheadline).foregroundStyle(Theme.muted)
                Text(PondList.threadCount(model.pondThreads(item.id)?.total ?? item.sessions.count)).font(.footnote).foregroundStyle(Theme.subtle)
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
    }

    private func accessLine(_ item: PondItem) -> String {
        guard let pond = item.pond else { return "Only on this Mac" }
        guard pond.shared else { return "Only you" }
        let names = pond.members.map(\.name)
        return names.isEmpty ? "Shared pond" : "Shared with " + names.prefix(3).joined(separator: ", ") + (names.count > 3 ? " and \(names.count - 3) more" : "")
    }

    private func tiles(_ item: PondItem) -> some View {
        Grid(horizontalSpacing: 12, verticalSpacing: 12) {
            GridRow {
                tile(item, .all, "tray.full", Theme.ink)
                tile(item, .needsYou, "exclamationmark.bubble", Theme.needsYou)
            }
            GridRow {
                tile(item, .working, "bolt.horizontal", Theme.working)
                tile(item, .shared, "person.2", Theme.info)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 4)
    }

    private func tile(_ item: PondItem, _ scope: PondScope, _ symbol: String, _ tint: Color) -> some View {
        let count = scope == .all ? (model.pondThreads(item.id)?.total ?? item.sessions.count) : PondList.sessions(item, scope: scope).count
        return Button { Haptics.play(.navigate); path.append(.scope(item.id, scope)) } label: {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    Image(systemName: symbol).font(.title3.weight(.semibold)).foregroundStyle(count > 0 || scope == .all ? tint : Theme.subtle)
                    Spacer()
                    Text("\(count)").font(.title.bold()).monospacedDigit().foregroundStyle(Theme.ink)
                }
                Text(scope.title).font(.subheadline.weight(.medium)).foregroundStyle(Theme.muted)
            }
            .padding(14)
            .frame(maxWidth: .infinity, minHeight: 84, alignment: .leading)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .buttonStyle(.press)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(scope.title), \(count)")
        .accessibilityHint("Opens the threads")
    }
}

/// One stream: its name, branch, and what its threads are doing.
struct StreamRow: View {
    let stream: StreamItem
    private var needsYou: Int { stream.sessions.filter(\.needsYou).count }
    private var working: Int { stream.sessions.filter { $0.state == "working" && !$0.needsYou }.count }

    var body: some View {
        HStack(spacing: 12) {
            Image(systemName: stream.pinned ? "pin" : "arrow.triangle.branch").foregroundStyle(Theme.muted).frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(stream.name).font(.body).lineLimit(1)
                Text([stream.branch.flatMap { $0 == stream.name ? nil : $0 }, PondList.threadCount(stream.sessions.count)]
                    .compactMap { $0 }.joined(separator: " · "))
                    .font(.footnote).foregroundStyle(Theme.muted).lineLimit(1)
            }
            Spacer(minLength: 4)
            if needsYou > 0 { CountBadge(count: needsYou) } else if working > 0 { StatusDot(color: Theme.working) }
            if let at = stream.lastActivity { Text(Age.describe(at)).font(.footnote).foregroundStyle(Theme.subtle).monospacedDigit() }
        }
        .frame(minHeight: 44)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(stream.pinned ? "Pinned stream " : "Stream ")\(stream.name), \(PondList.threadCount(stream.sessions.count))"
            + (needsYou > 0 ? ", \(needsYou) waiting for you" : ""))
    }
}

/// A stream's threads, newest first; "+" starts a thread in it.
struct StreamPage: View {
    @Environment(AppModel.self) private var model
    let pondId: String
    let streamId: String

    var body: some View {
        if let item = model.pondItem(pondId),
           let stream = PondList.streams(item).live.first(where: { $0.id == streamId }) ?? PondList.archivedStreams(item).first(where: { $0.id == streamId }) {
            ThreadListPage(title: stream.name, sessions: stream.sessions, emptyTitle: "No threads yet", emptyText: "Start one with the pencil.",
                           inPond: true, newThread: NewThreadTarget(pond: item.name, stream: stream.name, workspaceId: stream.id))
        } else {
            ContentUnavailableView("This stream isn't here", systemImage: "arrow.triangle.branch").background(Theme.bg.ignoresSafeArea())
        }
    }
}

/// Every non-archived thread of a pond, as the Mac listed them (grouped and ordered there: Main first, then streams
/// newest first, threads newest first inside). A thread the phone's view also carries draws from that copy.
struct PondAllThreadsPage: View {
    @Environment(AppModel.self) private var model
    let item: PondItem
    let all: PondThreads

    var body: some View {
        let live = Set(model.home.sessions.map(\.key))
        List {
            ForEach(all.streams) { stream in
                Section {
                    ForEach(stream.threads) { thread in
                        NavigationLink(value: HomeRoute.session(thread.key)) {
                            SessionRow(session: model.session(thread.key) ?? thread.asSession, recent: !live.contains(thread.key), inProject: true)
                        }.tapHaptic(.navigate)
                    }
                } header: { Text(stream.name) }
            }
            if all.total > all.threads.count {
                Text("Showing the newest \(all.threads.count) of \(all.total)").font(.footnote).foregroundStyle(Theme.muted)
                    .listRowBackground(Color.clear)
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Theme.bg.ignoresSafeArea())
        .navigationTitle(PondScope.all.title)
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { Haptics.play(.refresh); await model.refresh() }
        .onAppear { model.openPond(item.id) }
        .overlay(alignment: .bottom) { ConnectionBar() }
        .foregroundStyle(Theme.ink)
    }
}

/// One of the dashboard's scope tiles: the pond's threads that are waiting, working, shared, or all of them.
struct ScopePage: View {
    @Environment(AppModel.self) private var model
    let pondId: String
    let scope: PondScope

    var body: some View {
        if let item = model.pondItem(pondId), scope == .all, let all = model.pondThreads(pondId) {
            PondAllThreadsPage(item: item, all: all)
        } else if let item = model.pondItem(pondId) {
            ThreadListPage(title: scope.title, sessions: PondList.sessions(item, scope: scope),
                           emptyTitle: scope == .shared && !item.shared ? "Only you" : "Nothing here now",
                           emptyText: scope == .shared && !item.shared ? "Invite someone from Squeak on your Mac to share this pond." : "Pull down to refresh.",
                           inPond: true, newThread: NewThreadTarget(pond: item.name))
                .overlay(alignment: .top) {
                    // The first time only: the rest of the pond's threads are on their way from the Mac.
                    if scope == .all, model.pondThreadsLoading {
                        HStack(spacing: 8) { ProgressView(); Text("Loading all threads").font(.footnote).foregroundStyle(Theme.muted) }
                            .padding(.vertical, 8).padding(.horizontal, 14)
                            .background(.regularMaterial, in: Capsule())
                            .padding(.top, 8)
                    }
                }
        } else {
            ContentUnavailableView("This pond isn't here", systemImage: "drop").background(Theme.bg.ignoresSafeArea())
        }
    }
}

struct ArchivedStreamsPage: View {
    @Environment(AppModel.self) private var model
    let pondId: String

    var body: some View {
        let streams = model.pondItem(pondId).map(PondList.archivedStreams) ?? []
        List {
            if streams.isEmpty {
                Text("The archived streams are on your Mac.").foregroundStyle(Theme.muted).frame(minHeight: 44)
            }
            ForEach(streams) { stream in
                NavigationLink(value: HomeRoute.stream(pondId, stream.id)) { StreamRow(stream: stream) }.tapHaptic(.navigate)
            }
        }
        .listStyle(.insetGrouped)
        .scrollContentBackground(.hidden)
        .background(Theme.bg.ignoresSafeArea())
        .navigationTitle("Archived")
        .navigationBarTitleDisplayMode(.inline)
        .foregroundStyle(Theme.ink)
    }
}
#endif
