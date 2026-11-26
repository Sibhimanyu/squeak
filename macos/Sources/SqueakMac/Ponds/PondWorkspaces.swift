import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md §8.10, Pond home, Workspaces: one soft card per workspace, its chats as rows, and the people in each chat
// as an avatar stack. What goes where is decided in `PondHomeLayout`; this only draws.

struct PondWorkspacesView: View {
    let layout: PondHomeLayout
    let members: [FlockMember]
    var showsHeading = true
    let open: (PondChatRow) -> Void

    static func countSuffix(_ n: Int?) -> String {
        guard let n, n > 0 else { return "" }
        return " \u{00B7} \(n) \(n == 1 ? "duck" : "ducks")"
    }

    @State private var expandedStreams: Set<String> = []

    private func expandedBinding(_ id: String) -> Binding<Bool> {
        Binding(get: { expandedStreams.contains(id) },
                set: { if $0 { expandedStreams.insert(id) } else { expandedStreams.remove(id) } })
    }

    var body: some View {
        if !layout.workspaces.isEmpty {
            VStack(alignment: .leading, spacing: Space.s) {
                if showsHeading { Text("Streams").font(Typo.heading).foregroundStyle(Theme.ink).accessibilityAddTraits(.isHeader) }
                LazyVStack(spacing: 14) {
                    ForEach(layout.workspaces) { w in PondWorkspaceCardView(card: w, members: members, open: open, expanded: expandedBinding(w.id)) }
                }
            }
        }
        if !layout.fromFlock.isEmpty {
            PondSection(PondHomeLayout.fromFlockTitle) {
                VStack(spacing: 0) {
                    ForEach(layout.fromFlock) { r in PondChatRowView(row: r, members: members, open: open) }
                }
                .padding(.vertical, Space.xs).background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
            }
        }
    }
}

private struct PondWorkspaceCardView: View {
    let card: PondWorkspaceCard
    let members: [FlockMember]
    let open: (PondChatRow) -> Void
    @Environment(AppModel.self) private var model
    @Binding var expanded: Bool

    var body: some View {
        let shown = PondCardRows.visible(threads: card.chats, expanded: expanded)
        VStack(alignment: .leading, spacing: 0) {
            if !card.isDucks {
            HStack(spacing: Space.s) {
                Text(verbatim: card.displayTitle).font(Typo.label).foregroundStyle(Theme.ink).lineLimit(1)
                Spacer(minLength: 0)
                Text(verbatim: "\(card.chats.count)")
                    .font(Typo.meta).monospacedDigit().foregroundStyle(Theme.muted)
                    .accessibilityLabel("\(card.chats.count) ducks")
                if let m = card.mark, let shown = m.mark.asRollup(childrenVisible: !card.chats.isEmpty) { ChatMarkGlyph(mark: shown).help(m.words) }
            }
            .padding(.horizontal, 16).padding(.top, 16).padding(.bottom, card.branch == nil ? 12 : 6)
            if let branch = card.branch {
                Text(verbatim: branch).font(Typo.code).foregroundStyle(Theme.muted)
                    .lineLimit(1).truncationMode(.middle).help(branch)
                    .padding(.horizontal, 16).padding(.bottom, 12)
            }
            if !card.chats.isEmpty {
                Rectangle().fill(Theme.line).frame(height: 1).padding(.horizontal, 16).accessibilityHidden(true)
            }
            }
            ForEach(shown.rows) { r in PondChatRowView(row: r, members: members, open: open) }
            if shown.hiddenCount > 0 || (expanded && card.chats.count > PondCardRows.minimum) {
                Button {
                    withAnimation(Motion.standard) { expanded.toggle() }
                } label: {
                    HStack(spacing: 6) {
                        Text(verbatim: expanded ? "Show less" : "Show \(shown.hiddenCount) more").font(Typo.footnote)
                        Image(systemName: expanded ? "chevron.up" : "chevron.down").font(.system(size: 10, weight: .semibold)).accessibilityHidden(true)
                        Spacer(minLength: 0)
                    }
                    .foregroundStyle(Theme.muted)
                    .padding(.horizontal, 16).padding(.vertical, 10).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            if let m = card.emptyMain {
                HStack(spacing: Space.s) {
                    Text("The pond\u{2019}s own folder").font(Typo.footnote).foregroundStyle(Theme.muted)
                    Spacer(minLength: Space.s)
                    Button("New duck") { model.openNewMainThread(projectId: m.projectId) }
                        .buttonStyle(.borderless).font(Typo.footnote).foregroundStyle(Theme.ink)
                }
                .padding(.horizontal, 16).padding(.bottom, 12)
            }
            if let w = card.empty {
                HStack(spacing: Space.s) {
                    Text("Ready for a new duck").font(Typo.footnote).foregroundStyle(Theme.muted)
                    Spacer(minLength: Space.s)
                    Button("New duck") { model.openNewThread(projectId: w.projectId, workspaceId: w.id) }
                        .buttonStyle(.borderless).font(Typo.footnote).foregroundStyle(Theme.ink)
                }
                .padding(.horizontal, 16).padding(.bottom, 12)
            }
        }
        .padding(.bottom, Space.xs).frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
    }
}

struct PondChatRowView: View {
    let row: PondChatRow
    let members: [FlockMember]
    let open: (PondChatRow) -> Void
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 0) {
            rowButton
            if row.isLooping, let key = row.local {
                HStack {
                    Text(verbatim: row.loopSentence ?? "Repeating a failing step").font(Typo.meta).foregroundStyle(Theme.muted)
                    Spacer(minLength: 8)
                    Button("Tell it to stop retrying") { Task { await model.stopRetrying(sessionKey: key.hostSessionId) } }
                        .buttonStyle(SecondaryButtonStyle()).disabled(model.chatBusy)
                }
                .padding(.horizontal, 16).padding(.bottom, 10)
            }
            // A failure the person has not seen says why (the host's words) and can be let go without opening the chat.
            if row.failed, let key = row.local, let s = model.session(key) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(verbatim: row.failureText.map { "Failed: \($0)" } ?? "Failed").font(Typo.meta).foregroundStyle(Theme.negative)
                        .lineLimit(2).fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 8)
                    Button("Dismiss") { model.dismissFailure(s) }
                        .buttonStyle(SecondaryButtonStyle())
                        .help("Stop counting this failure under Needs you. Sending the chat a message does the same.")
                }
                .padding(.horizontal, 16).padding(.bottom, 10)
            }
        }
    }

    private var rowButton: some View {
        RowOrButton(editing: row.local.flatMap { model.session($0) }.map { model.isRenaming($0) } ?? false, action: { open(row) }) {
            HStack(alignment: .center, spacing: 12) {
                ThreadDuckView(id: row.local?.stringValue ?? row.id, agent: row.agent, size: ThreadDuck.Size.pondRow)
                .frame(width: 32, height: 32)
                .background(Theme.bg, in: RoundedRectangle(cornerRadius: 9))
                .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 6) {
                    if let key = row.local, let s = model.session(key), model.isRenaming(s) {
                        InlineTitleEditor(session: s, font: Typo.label)
                    } else {
                        // The Duck's name is the label; the chat's title is only secondary text (never the sender or the label).
                        // An Off-duty Duck wears no name: its chat title leads.
                        let name = row.heading ?? (row.offDuty != nil ? nil : row.local.flatMap { model.session($0) }.flatMap { model.duckName(of: $0) })
                        Text(verbatim: name ?? row.title).font(Typo.label).foregroundStyle(Theme.ink)
                            .lineLimit(2).multilineTextAlignment(.leading)
                        if let name, name != row.title, row.offDuty == nil {
                            Text(verbatim: row.title).font(Typo.meta).foregroundStyle(Theme.muted).lineLimit(1)
                        }
                    }
                    HStack(spacing: 6) {
                        if let m = row.mark { ChatMarkGlyph(mark: m, leading: true) } else { PondStateMark(state: row.state, leading: true) }
                        Text(verbatim: row.statusLine ?? row.offDuty?.line ?? row.mark?.words ?? PondSentence.stateWord(row.state.session))
                            .font(Typo.meta).foregroundStyle(Theme.muted)
                        if row.ducklingsRunning > 0, row.statusLine == nil {
                            HStack(spacing: 2) {
                                DucklingView(parentId: row.local?.stringValue ?? row.id, parentSize: ThreadDuck.Size.tab)
                                Text(verbatim: "\(row.ducklingsRunning)").font(Typo.meta).monospacedDigit().foregroundStyle(Theme.muted)
                            }
                            .help("\(DucklingWords.count(row.ducklingsRunning)) running")
                            .accessibilityLabel("\(DucklingWords.count(row.ducklingsRunning)) running")
                        }
                        if row.offDuty == nil, row.statusLine == nil, let at = row.lastAt {
                            Text("·").foregroundStyle(Theme.muted)
                            Text(verbatim: RelativeAge.short(at)).font(Typo.meta).monospacedDigit().foregroundStyle(Theme.muted)
                        }
                        if !row.streamLabels.isEmpty {
                            Text("·").foregroundStyle(Theme.muted)
                            Text(verbatim: row.streamLabels.joined(separator: ", ")).font(Typo.code).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.middle)
                        }
                    }
                    if let summary = row.offDuty?.summary {
                        Text(verbatim: summary).font(Typo.meta).foregroundStyle(Theme.muted).lineLimit(1)
                    }
                    if let visibility = row.visibility {
                        Text(verbatim: visibility)
                            .font(Typo.meta).foregroundStyle(Theme.muted).lineLimit(2)
                            .multilineTextAlignment(.leading)
                    }
                }
                Spacer(minLength: 0)
                PondAvatarStack(people: row.people, size: 24)
                Image(systemName: "chevron.right").font(.system(size: 10, weight: .semibold))
                    .foregroundStyle(Theme.muted).accessibilityHidden(true)
            }
            .padding(.horizontal, 16).padding(.vertical, 13).contentShape(Rectangle())
        }
        .buttonStyle(PondThreadRowStyle())
        .squeakContextMenu {
            if let key = row.local, let s = model.session(key) { RenameThreadItem(session: s); DismissFailureItem(session: s); DuckMenuItems(session: s) }
            // Someone else's thread: archiving hides it from your view only, never from the person who started it.
            if row.local == nil, let thread = row.pondThread, let pond = PondsModel.shared.ponds.first(where: { PondsModel.shared.details[$0.id]?.threads.contains { $0.id == thread } == true }) {
                Button("Archive") { PondsModel.shared.hideShared(threadId: thread, pondId: pond.id, pondName: pond.name, title: row.title, agent: row.agent) }
            }
            // The starter's switch for a thread in the pond: private (only you) or shared with the pond.
            if row.local != nil, let thread = row.pondThread, let pond = PondsModel.shared.ponds.first(where: { PondsModel.shared.details[$0.id]?.threads.contains { $0.id == thread } == true }) {
                Button(row.isPrivate ? "Share with the pond" : "Make private") {
                    Task { await PondsModel.shared.setPrivate(pond: pond.id, thread: thread, isPrivate: !row.isPrivate) }
                }
            }
        }
        .help(row.title)
        .accessibilityLabel("\(row.title), \(row.mark?.words ?? PondSentence.stateWord(row.state.session)), \(row.visibility ?? row.hostingLabel), \(row.people.map { $0.you ? "you" : $0.name }.joined(separator: ", "))")
    }
}

/// The people in a chat, overlapping; a duck ring on whoever is viewing or typing now (live avatars are not dimmed).
struct PondAvatarStack: View {
    let people: [PondChatPerson]
    var size: CGFloat = 20
    static let shown = 4

    var body: some View {
        HStack(spacing: -size * 0.3) {
            ForEach(Array(people.prefix(Self.shown).enumerated()), id: \.element.id) { i, p in
                FlockAvatar(member: FlockMember(id: p.id, name: p.name), online: false, size: size)
                    .overlay { if p.live != .none { Circle().strokeBorder(PondColour.accent, lineWidth: 2).padding(-2) } }
                    .help(p.live == .typing ? "\(p.name) is typing" : p.live == .viewing ? "\(p.name) is here now" : p.name)
                    .zIndex(Double(Self.shown - i))
            }
            if people.count > Self.shown {
                Text(verbatim: "+\(people.count - Self.shown)").font(Typo.meta).foregroundStyle(Theme.muted).padding(.leading, size * 0.45)
            }
        }
    }
}

/// Native buttons retain keyboard focus; hover and press use the same quiet surfaces as the workbench.
private struct PondThreadRowStyle: ButtonStyle {
    @Environment(\.isEnabled) private var isEnabled
    func makeBody(configuration: Configuration) -> some View {
        PondThreadRowSurface(pressed: configuration.isPressed, content: configuration.label)
            .opacity(isEnabled ? 1 : 0.5)
    }
}

private struct PondThreadRowSurface<Content: View>: View {
    let pressed: Bool
    let content: Content
    @State private var hovering = false

    var body: some View {
        content
            .background(pressed ? Theme.selected : hovering ? Theme.surfaceRaised : Color.clear,
                        in: RoundedRectangle(cornerRadius: 8))
            .onHover { hovering = $0 }
    }
}

/// Ducks mode, the pond page's "Branches": each branch, how many ducks work on it and its pull request where git knows it.
struct DuckBranchesList: View {
    let rows: [DuckRow]
    @Environment(AppModel.self) private var model

    var body: some View {
        let branches = DuckList.branches(rows)
        if !branches.isEmpty {
            VStack(alignment: .leading, spacing: Space.s) {
                Text("Branches").font(Typo.heading).foregroundStyle(Theme.ink).accessibilityAddTraits(.isHeader)
                VStack(spacing: 0) {
                    ForEach(branches) { b in
                        HStack(spacing: 10) {
                            Lucide(b.isMain ? .folder : .gitBranch, size: 13, color: Theme.muted)
                            Text(verbatim: b.isMain ? DuckRow.mainLabel : b.label).font(Typo.code).foregroundStyle(Theme.ink).lineLimit(1).truncationMode(.middle)
                            if b.isMain { Text("read-only").font(Typo.meta).foregroundStyle(Theme.subtle) }
                            Spacer(minLength: 8)
                            if let pr = duckBranchPRWord(b.lead, model: model), !b.isMain { Text(verbatim: "PR \(pr)").font(Typo.meta).foregroundStyle(Theme.muted) }
                            Text(verbatim: "\(b.duckCount) \(b.duckCount == 1 ? "duck" : "ducks")").font(Typo.meta).monospacedDigit().foregroundStyle(Theme.muted)
                        }
                        .padding(.horizontal, 16).frame(height: 36)
                        .accessibilityElement(children: .combine)
                    }
                }
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
            }
        }
    }
}
