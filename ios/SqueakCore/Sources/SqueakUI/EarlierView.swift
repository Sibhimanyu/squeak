#if os(iOS)
import SqueakCore
import SqueakIcons
import SwiftUI

/// Earlier: the chats that went quiet, with the controls to find one. Which are open as tabs in Conductor
/// (the Mac says so per chat), a project, an agent, how it ended, and how to order them. Narrowing is pure
/// (`EarlierFilter`) over the chats already on the phone; "Show more" loads older ones from the Mac, and
/// the filters apply to those too.
struct EarlierView: View {
    @Environment(AppModel.self) private var model
    @Binding var path: [HomeRoute]
    /// `-squeak-earlier-open` and `-squeak-earlier-project <name>` start narrowed: screenshots of the demo only.
    @State private var filter: EarlierFilter = {
        let args = ProcessInfo.processInfo.arguments
        var f = EarlierFilter()
        f.openOnly = args.contains("-squeak-earlier-open")
        if let i = args.firstIndex(of: "-squeak-earlier-project"), i + 1 < args.count { f.project = args[i + 1] }
        return f
    }()
    @State private var query = ""
    @State private var quickReply: PhoneSnapshot.Session?

    private var all: [PhoneSnapshot.Session] { model.recentChats }

    var body: some View {
        let shown = filter.apply(all, query: query)
        List {
            if !all.isEmpty {
                Section { controls(shown: shown.count) }
                    .listRowBackground(Color.clear).listRowInsets(EdgeInsets()).listRowSeparator(.hidden)
            }
            if all.isEmpty {
                ContentUnavailableView {
                    Label { Text("Nothing here now") } icon: { Lucide(.circleCheck, size: 28, color: Theme.muted) }
                } description: { Text("Pull down to refresh.") }
                .listRowBackground(Color.clear).listRowSeparator(.hidden)
            } else if shown.isEmpty {
                ContentUnavailableView {
                    Label { Text("No earlier chats match") } icon: { Lucide(.search, size: 28, color: Theme.muted) }
                } description: {
                    Text(model.snapshot?.recentMore == true ? "Show more loads older chats from your Mac." : "Try fewer filters.")
                } actions: {
                    if filter.isNarrowing || !query.isEmpty { Button("Clear filters") { filter.clear(); query = "" } }
                }
                .listRowBackground(Color.clear).listRowSeparator(.hidden)
            } else if filter.sort == .project {
                ForEach(EarlierFilter.byProject(shown), id: \.name) { group in
                    Section(group.name) { rows(group.sessions) }
                }
            } else {
                Section { rows(shown) }
            }
            if model.snapshot?.recentMore == true { Section { showMore } }
        }
        .listStyle(.insetGrouped)
        .listSectionSpacing(16)
        .scrollContentBackground(.hidden)
        .background(Theme.bg.ignoresSafeArea())
        .navigationTitle("Earlier")
        .navigationBarTitleDisplayMode(.inline)
        .searchable(text: $query, prompt: "Search earlier chats…")
        .refreshable { await model.refresh() }
        .safeAreaInset(edge: .bottom) { ConnectionBar() }
        .sheet(item: $quickReply) { session in QuickReply(session: session) }
        .foregroundStyle(Theme.ink)
    }

    @ViewBuilder
    private func rows(_ sessions: [PhoneSnapshot.Session]) -> some View {
        ForEach(sessions) { session in
            NavigationLink(value: HomeRoute.session(session.key)) { SessionRow(session: session, recent: true) }
                .homeRow(needsYou: false)
                .modifier(SessionSwipe(session: session) { quickReply = session })
        }
    }

    /* ---------- controls ---------- */

    private func controls(shown: Int) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            if let open = EarlierFilter.openCount(all) {
                Picker("Show", selection: $filter.openOnly) {
                    Text("All \(all.count)").tag(false)
                    Text("Open in Conductor \(open)").tag(true)
                }
                .pickerStyle(.segmented)
                .padding(.horizontal, 20)
                .onChange(of: filter.openOnly) { _, _ in UISelectionFeedbackGenerator().selectionChanged() }
            }
            // The chips scroll edge to edge and start in line with everything else.
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    projectMenu
                    agentMenu
                    outcomeMenu
                    sortMenu
                }
            }
            .contentMargins(.horizontal, 20, for: .scrollContent)
            HStack {
                Text(EarlierFilter.countLine(shown: shown, of: all.count)).font(.footnote).foregroundStyle(Theme.muted).monospacedDigit()
                Spacer(minLength: 8)
                if filter.isNarrowing {
                    Button("Clear filters") { filter.clear() }
                        .font(.footnote.weight(.semibold)).foregroundStyle(Theme.ink).frame(minHeight: 44)
                }
            }
            .padding(.horizontal, 20)
        }
        .padding(.top, 4)
    }

    private var projectMenu: some View {
        Menu {
            Picker("Project", selection: $filter.project) {
                Text("All projects").tag(String?.none)
                ForEach(EarlierFilter.projects(all), id: \.name) { Text("\($0.name) · \($0.count)").tag(String?.some($0.name)) }
            }
        } label: { FilterChip(title: filter.project ?? "Project", active: filter.project != nil) }
            .accessibilityLabel("Project, \(filter.project ?? "all")")
    }

    private var agentMenu: some View {
        Menu {
            Picker("Agent", selection: $filter.agent) {
                Text("Any agent").tag(String?.none)
                ForEach(EarlierFilter.agents(all), id: \.agent) { Text("\(Presentation.agentName($0.agent)) · \($0.count)").tag(String?.some($0.agent)) }
            }
        } label: { FilterChip(title: filter.agent.map(Presentation.agentName) ?? "Agent", active: filter.agent != nil) }
            .accessibilityLabel("Agent, \(filter.agent.map(Presentation.agentName) ?? "any")")
    }

    private var outcomeMenu: some View {
        Menu {
            Picker("How it ended", selection: $filter.outcome) {
                Text("Any").tag(Presentation.Filter?.none)
                ForEach([Presentation.Filter.done, .error, .idle], id: \.self) { Text($0.heading).tag(Presentation.Filter?.some($0)) }
            }
        } label: { FilterChip(title: filter.outcome?.heading ?? "Outcome", active: filter.outcome != nil) }
            .accessibilityLabel("Outcome, \(filter.outcome?.word ?? "any")")
    }

    private var sortMenu: some View {
        Menu {
            Picker("Order", selection: $filter.sort) {
                ForEach(EarlierFilter.Sort.allCases) { Text($0.title).tag($0) }
            }
        } label: { FilterChip(title: filter.sort.title, active: false) }
            .accessibilityLabel("Order, \(filter.sort.title)")
    }

    private var showMore: some View {
        let waiting = model.recentWanted > all.count
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

/// A filter's button: its name, or what it is set to, in a pill; the set ones are lifted, never coloured.
private struct FilterChip: View {
    let title: String
    let active: Bool

    var body: some View {
        HStack(spacing: 6) {
            Text(title).font(.subheadline.weight(.medium)).lineLimit(1)
            Lucide(.chevronDown, size: 12, color: Theme.subtle)
        }
        .foregroundStyle(active ? Theme.ink : Theme.muted)
        .padding(.horizontal, 12)
        .frame(minHeight: 36)
        .background(active ? Theme.surfaceRaised : Theme.surface, in: Capsule())
        .overlay(Capsule().stroke(active ? Theme.lineStrong : Theme.line))
        .frame(minHeight: 44)
        .contentShape(Rectangle())
    }
}
#endif
