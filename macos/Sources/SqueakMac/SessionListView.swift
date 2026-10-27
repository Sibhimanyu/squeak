import AppKit
import SqueakIcons
import SqueakMarkup
import SqueakMacCore
import SwiftUI

// MARK: - Session list

struct SessionListView: View {
    @Environment(AppModel.self) private var model
    @State private var showEarlier = false

    var body: some View {
        List(selection: selection) {
            if model.isSearching {
                searchRows
            } else {
                ForEach(model.grouped) { section in
                    sectionView(section)
                }
            }
        }
        .listStyle(.inset)
        .scrollContentBackground(.hidden)
        .safeAreaInset(edge: .top, spacing: 0) { header }
        .overlay { if model.sessions.isEmpty { emptyNote } }
        .task(id: model.hasLoaded) { await model.pollLiveSteps() }
    }

    private var selection: Binding<SessionKey?> {
        Binding(get: { model.selected }, set: { model.select($0) })
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text("Sessions").font(Typo.title).accessibilityAddTraits(.isHeader)
            Text(model.sessionsSummary).font(Typo.body).foregroundStyle(Theme.muted)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 20).padding(.top, 6).padding(.bottom, 12)
    }

    @ViewBuilder private func sectionView(_ section: SessionSection) -> some View {
        // Idle for more than a day is tucked away behind one quiet row.
        let now = Date()
        let earlier = section.kind == .idle ? section.sessions.filter { SessionGrouping.isEarlier($0, now: now) } : []
        let shown = section.sessions.filter { !earlier.contains($0) }
        Section {
            SectionLabel(section.kind.title, count: shown.count)
                .padding(.top, 6)
                .listRowSeparator(.hidden)
            ForEach(shown) { s in row(s) }
            if !earlier.isEmpty {
                ShowEarlierRow(count: earlier.count, expanded: showEarlier) { showEarlier.toggle() }
                    .listRowSeparator(.hidden)
                if showEarlier { ForEach(earlier) { s in row(s) } }
            }
        }
    }

    private func row(_ s: HostSession, snippet: String? = nil) -> some View {
        SessionListRow(session: s, isPinned: model.pinned.contains(s.key), subtitleOverride: snippet)
            .tag(s.key)
            .listRowSeparator(.visible)
            .contextMenu {
                Button(model.pinned.contains(s.key) ? "Unpin" : "Pin to top") { model.togglePin(s.key) }
            }
    }

    @ViewBuilder private var searchRows: some View {
        let hits = model.searchHits
        if hits.isEmpty {
            Text("No matches. Search covers titles and messages Squeak has already opened on this Mac.")
                .font(Typo.body).foregroundStyle(Theme.muted).padding(.vertical, 12)
        } else {
            ForEach(hits, id: \.key) { hit in
                if let s = model.session(hit.key) { row(s, snippet: hit.titleMatch ? nil : hit.snippet) }
            }
        }
    }

    @ViewBuilder private var emptyNote: some View {
        Text(model.isConnected ? "No chats yet. Start one in Conductor and it shows up here." : "No chats to show yet.")
            .font(Typo.body).foregroundStyle(Theme.muted).multilineTextAlignment(.center).padding(24)
    }
}

/// 8.2: dot, then three lines (SessionRowLines). No icon.
struct SessionListRow: View {
    let session: HostSession
    var isPinned = false
    var subtitleOverride: String?

    var body: some View {
        HStack(alignment: .top, spacing: Space.m) {
            StateDot(state: session.state).frame(height: 19)
            SessionRowLines(session: session, isPinned: isPinned, subtitleOverride: subtitleOverride)
        }
        .padding(.vertical, 3)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(SessionText.headline(session)), \(SessionText.secondLine(session)), \(SessionText.stateWord(session))")
    }
}

