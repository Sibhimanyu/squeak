import SqueakIcons
import SqueakMacCore
import SwiftUI

/// Home, as on the iPhone: a large title with the counts and the connection, the Mac's status, then
/// one card per project with its active chats (newest first). Searching swaps the cards for results,
/// active chats first and then earlier ones.
struct HomeView: View {
    @Environment(AppModel.self) private var model
    @State private var showEarlier = true

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: Space.l) {
                header
                if model.isSearching {
                    results
                } else {
                    strip
                    let projects = model.homeProjects
                    if projects.isEmpty {
                        empty
                    } else {
                        ForEach(projects) { ProjectCard(project: $0) }
                    }
                }
            }
            .padding(.horizontal, 20).padding(.top, 6).padding(.bottom, Space.xl)
        }
        .scrollContentBackground(.hidden)
        .task(id: model.hasLoaded) { await model.pollLiveSteps() }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Home").font(.system(size: 26, weight: .bold)).accessibilityAddTraits(.isHeader)
            HStack(spacing: 8) {
                Text(model.sessionsSummary).font(Typo.body).foregroundStyle(Theme.muted)
                Spacer(minLength: 8)
                HStack(spacing: 6) {
                    Circle().fill(model.homeConnectionColor).frame(width: 8, height: 8)
                    Text(model.homeConnectionText).font(Typo.meta).foregroundStyle(Theme.muted).lineLimit(1)
                }
                .accessibilityElement(children: .combine)
            }
        }
    }

    @ViewBuilder private var strip: some View {
        let items = model.macStatusItems
        if !items.isEmpty {
            Card(padding: Space.s) {
                FlowLayout(spacing: Space.s) {
                    ForEach(items) { item in
                        HStack(spacing: 6) {
                            Circle().fill(color(item.tone)).frame(width: 6, height: 6)
                            Text(verbatim: item.text).font(Typo.meta).foregroundStyle(Theme.ink)
                        }
                        .padding(.horizontal, 8).padding(.vertical, 3)
                    }
                }
            }
            .accessibilityElement(children: .combine)
            .accessibilityLabel("Mac status: " + items.map(\.text).joined(separator: ", "))
        }
    }

    private func color(_ tone: MacStatusStrip.Tone) -> Color {
        switch tone { case .ok: Theme.working; case .quiet: Theme.idle; case .warning: Theme.offline }
    }

    private var empty: some View {
        VStack(spacing: Space.m) {
            DuckMark(width: 64)
            Text("Nothing running").font(Typo.heading).foregroundStyle(Theme.muted)
            Text(model.isConnected ? "Start a chat in Conductor or a terminal and it shows up here."
                                   : "No chats to show yet.")
                .font(Typo.body).foregroundStyle(Theme.subtle).multilineTextAlignment(.center).frame(maxWidth: 320)
        }
        .frame(maxWidth: .infinity).padding(.vertical, 48)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var results: some View {
        let split = model.homeSearch
        if split.active.isEmpty && split.earlier.isEmpty {
            Text("No matches. Search covers titles and messages Squeak has already opened on this Mac.")
                .font(Typo.body).foregroundStyle(Theme.muted).padding(.vertical, 12)
        } else {
            if !split.active.isEmpty {
                SectionLabel("Active", count: split.active.count)
                resultCard(split.active)
            }
            if !split.earlier.isEmpty {
                Button { showEarlier.toggle() } label: {
                    SectionLabel("Earlier", count: split.earlier.count)
                }.buttonStyle(.plain)
                if showEarlier { resultCard(split.earlier) }
            }
        }
    }

    private func resultCard(_ hits: [SearchHit]) -> some View {
        Card(padding: Space.xs) {
            VStack(spacing: 0) {
                ForEach(hits, id: \.key) { hit in
                    if let s = model.session(hit.key) {
                        HomeSessionRow(session: s, snippet: hit.titleMatch ? nil : hit.snippet)
                    }
                }
            }
        }
    }
}

/// One project: its name, what is running or waiting in it, and its chats.
struct ProjectCard: View {
    let project: HomeProject

    var body: some View {
        Card(padding: Space.xs) {
            VStack(alignment: .leading, spacing: 0) {
                HStack(spacing: 8) {
                    Text(verbatim: project.name).font(Typo.heading).foregroundStyle(Theme.ink).lineLimit(1)
                    Spacer(minLength: 8)
                    if project.needsYouCount > 0 {
                        Text("\(project.needsYouCount) needs you").font(Typo.meta).foregroundStyle(Theme.needsYou)
                    }
                    if project.workingCount > 0 {
                        Text("\(project.workingCount) working").font(Typo.meta).foregroundStyle(Theme.working)
                    }
                }
                .padding(.horizontal, Space.m).padding(.top, Space.s).padding(.bottom, Space.xs)
                .accessibilityAddTraits(.isHeader)
                ForEach(project.sessions) { HomeSessionRow(session: $0) }
            }
        }
    }
}

/// A chat inside a card: a tap opens it in the detail column.
struct HomeSessionRow: View {
    let session: HostSession
    var snippet: String?
    @Environment(AppModel.self) private var model

    var body: some View {
        Button { model.select(session.key) } label: {
            SessionRowView(session: session, isSelected: model.selected == session.key,
                           isPinned: model.pinned.contains(session.key), subtitleOverride: snippet)
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button(model.pinned.contains(session.key) ? "Unpin" : "Pin to top") { model.togglePin(session.key) }
        }
    }
}
