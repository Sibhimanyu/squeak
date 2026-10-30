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
        if model.projectFilter != nil, !model.isSearching {
            ProjectPageView()
        } else {
            homeBody
        }
    }

    private var homeBody: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                header
                if model.isSearching {
                    results
                } else {
                    let projects = model.homeProjects
                    if projects.isEmpty {
                        empty
                    } else {
                        ForEach(projects) { ProjectCard(project: $0) }
                    }
                }
            }
            .padding(.horizontal, 12).padding(.top, 8).padding(.bottom, Space.xl)
        }
        .scrollContentBackground(.hidden)
        .task(id: model.hasLoaded) { await model.pollLiveSteps() }
    }

    private var header: some View {
        HStack(alignment: .top, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Home").font(.system(size: Metrics.pageTitle, weight: .bold)).accessibilityAddTraits(.isHeader)
                Text(model.sessionsSummary).font(.system(size: 12)).foregroundStyle(Theme.muted)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 8) {
                HStack(spacing: 6) {
                    Circle().fill(model.homeConnectionColor).frame(width: 8, height: 8)
                    Text(model.homeConnectionText).font(.system(size: 11)).foregroundStyle(Theme.ink).lineLimit(1)
                }
                .accessibilityElement(children: .combine)
                .padding(.top, 4)
                if !model.isSearching { strip }
            }
        }
        .padding(.horizontal, 4).padding(.bottom, 2)
    }

    /// The Mac's status (awake, power) as one pill under the connection line, the way the mockup has it.
    @ViewBuilder private var strip: some View {
        let items = model.macStatusItems
        if !items.isEmpty {
            VStack(alignment: .trailing, spacing: 4) {
                ForEach(items) { item in
                    Button { model.openSettings(item.tone == .warning ? .connections : .awake) } label: {
                        HStack(spacing: 6) {
                            Lucide(.monitor, size: 12, color: color(item.tone))
                            Text(verbatim: item.text).font(.system(size: 11)).foregroundStyle(Theme.ink).lineLimit(1).fixedSize()
                        }
                        .padding(.horizontal, 10).frame(height: Metrics.pill)
                        .background(Theme.surface.opacity(0.7), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.lineStrong))
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .help(item.tone == .warning ? "Open Settings › Connections" : "Open Settings › Keep awake")
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
        HomeCardChrome {
            VStack(spacing: 0) {
                let rows = hits.compactMap { hit in model.session(hit.key).map { ($0, hit) } }
                ForEach(Array(rows.enumerated()), id: \.offset) { i, pair in
                    if i > 0 { HomeRowDivider() }
                    HomeSessionRow(session: pair.0, snippet: pair.1.titleMatch ? nil : pair.1.snippet)
                }
            }
            .padding(.vertical, 4)
        }
    }
}

/// The card all of Home's lists sit in: surface, hairline stroke, radius 12.
struct HomeCardChrome<Content: View>: View {
    @ViewBuilder var content: () -> Content
    var body: some View {
        content()
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface.opacity(0.7), in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(Theme.lineStrong))
    }
}

struct HomeRowDivider: View {
    var body: some View { Rectangle().fill(Theme.line).frame(height: 1).padding(.horizontal, 12) }
}

/// One project: its name, what waits on you in it, and its chats.
struct ProjectCard: View {
    let project: HomeProject
    @Environment(AppModel.self) private var model

    var body: some View {
        HomeCardChrome {
            VStack(alignment: .leading, spacing: 0) {
                Button { model.openProject(project.name) } label: {
                HStack(spacing: 8) {
                    Text(verbatim: project.name).font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                    Spacer(minLength: 8)
                    if project.needsYouCount > 0 {
                        Text("\(project.needsYouCount) needs you").font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(Theme.needsYou)
                            .padding(.horizontal, 8).frame(height: 20)
                            .background(Theme.needsYou.opacity(0.16), in: Capsule())
                    }
                    Lucide(.chevronRight, size: Metrics.iconSmall, color: Theme.muted)
                }
                .padding(.horizontal, 12).frame(height: 40).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Open project \(project.name)")
                .accessibilityAddTraits(.isHeader)
                VStack(spacing: 0) {
                    ForEach(Array(project.sessions.enumerated()), id: \.element.id) { i, session in
                        if i > 0 { HomeRowDivider() }
                        HomeSessionRow(session: session)
                    }
                }
                .padding(.bottom, 4)
            }
        }
    }
}

/// A chat inside a card, as the mockup draws it: a status dot, the title, the state word in muted
/// text beneath, and the age at the right. A tap opens it in the detail column.
struct HomeSessionRow: View {
    let session: HostSession
    var snippet: String?
    @Environment(AppModel.self) private var model
    @State private var hovering = false

    private var word: String {
        if let snippet { return snippet }
        let w = SessionText.stateWord(session)
        return w.prefix(1).uppercased() + w.dropFirst()
    }

    var body: some View {
        let selected = model.selected == session.key
        Button { model.select(session.key) } label: {
            HStack(alignment: .top, spacing: 10) {
                StateDot(state: session.state).frame(width: 10, height: 18)
                AgentAvatar(session: session, size: 20)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(verbatim: SessionText.headline(session)).font(.system(size: Metrics.rowTitle, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                        if model.pinned.contains(session.key) { Lucide(.pin, size: 12, label: "Pinned", color: Theme.subtle) }
                    }
                    Text(verbatim: word).font(.system(size: Metrics.rowMeta)).foregroundStyle(Theme.muted).lineLimit(1)
                }
                Spacer(minLength: 8)
                TimelineView(.periodic(from: .now, by: 30)) { ctx in
                    if let at = session.lastActivityAt {
                        Text(verbatim: ShortRelativeTime.format(at, now: ctx.date))
                            .font(.system(size: Metrics.rowMeta)).monospacedDigit().foregroundStyle(Theme.muted)
                    }
                }
                .padding(.top, 1)
            }
            .padding(.horizontal, 10).padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: 8, style: .continuous).fill(selected ? Theme.selected : Theme.surfaceRaised.opacity(hovering ? 0.6 : 0)))
            .padding(.horizontal, 6)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(SessionText.headline(session)), \(SessionText.secondLine(session)), \(SessionText.stateWord(session))")
        .contextMenu {
            Button(model.pinned.contains(session.key) ? "Unpin" : "Pin to top") { model.togglePin(session.key) }
        }
    }
}

/// One project, drilled into from Home: "‹ Home", the project's name, its counts, and its chats grouped
/// by status (the Sessions list's groups and order). Esc or the back button returns to Home.
struct ProjectPageView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Button { model.closeProject() } label: {
                    HStack(spacing: 4) {
                        Lucide(.chevronLeft, size: Metrics.iconSmall, color: Theme.muted)
                        Text("Home").font(.system(size: 12)).foregroundStyle(Theme.muted)
                    }
                    .frame(height: Metrics.pill).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .keyboardShortcut(.escape, modifiers: [])
                .accessibilityLabel("Back to Home")
                if let page = model.projectPage {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: page.name).font(.system(size: Metrics.pageTitle, weight: .bold)).lineLimit(1)
                            .accessibilityAddTraits(.isHeader)
                        Text(verbatim: page.summary).font(.system(size: 12)).foregroundStyle(Theme.muted)
                    }
                    .padding(.horizontal, 4)
                    ForEach(page.sections) { section in
                        SectionLabel(section.kind.title, count: section.sessions.count)
                        HomeCardChrome {
                            VStack(spacing: 0) {
                                ForEach(Array(section.sessions.enumerated()), id: \.element.id) { i, session in
                                    if i > 0 { HomeRowDivider() }
                                    HomeSessionRow(session: session)
                                }
                            }
                            .padding(.vertical, 4)
                        }
                    }
                } else {
                    Text("Nothing active in this project.").font(Typo.body).foregroundStyle(Theme.muted).padding(.vertical, 12)
                }
            }
            .padding(.horizontal, 12).padding(.top, 8).padding(.bottom, Space.xl)
        }
        .scrollContentBackground(.hidden)
        .task(id: model.hasLoaded) { await model.pollLiveSteps() }
    }
}
