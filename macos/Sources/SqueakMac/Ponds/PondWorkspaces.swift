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
        return " \u{00B7} \(n) \(n == 1 ? "thread" : "threads")"
    }

    var body: some View {
        if !layout.workspaces.isEmpty {
            VStack(alignment: .leading, spacing: Space.s) {
                if showsHeading { Text("Streams").font(Typo.heading).foregroundStyle(Theme.ink).accessibilityAddTraits(.isHeader) }
                LazyVStack(spacing: 14) {
                    ForEach(layout.workspaces) { w in PondWorkspaceCardView(card: w, members: members, open: open) }
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

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: Space.s) {
                StreamGlyph(state: .of(rows: card.chats), size: 15, name: card.displayTitle)
                Text(verbatim: card.displayTitle).font(Typo.label).foregroundStyle(Theme.ink).lineLimit(1)
                Spacer(minLength: 0)
                Text(verbatim: "\(card.chats.count)")
                    .font(Typo.meta).monospacedDigit().foregroundStyle(Theme.muted)
                    .accessibilityLabel("\(card.chats.count) threads")
                if let m = card.mark { ChatMarkGlyph(mark: m.mark).help(m.words) }
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
            ForEach(card.chats) { r in PondChatRowView(row: r, members: members, open: open) }
            if let w = card.empty {
                HStack(spacing: Space.s) {
                    Text("Ready for a new thread").font(Typo.footnote).foregroundStyle(Theme.muted)
                    Spacer(minLength: Space.s)
                    Button("New thread") { model.openNewThread(projectId: w.projectId, workspaceId: w.id) }
                        .buttonStyle(.borderless).font(Typo.footnote).foregroundStyle(Theme.ink)
                }
                .padding(.horizontal, 16).padding(.bottom, 12)
            }
        }
        .padding(.bottom, Space.xs).frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
    }
}

private struct PondChatRowView: View {
    let row: PondChatRow
    let members: [FlockMember]
    let open: (PondChatRow) -> Void
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(spacing: 0) {
            rowButton
            if row.isLooping, let key = row.local {
                HStack {
                    Text("Repeating a failing step").font(Typo.meta).foregroundStyle(Theme.muted)
                    Spacer(minLength: 8)
                    Button("Tell it to stop retrying") { Task { await model.stopRetrying(sessionKey: key.hostSessionId) } }
                        .buttonStyle(SecondaryButtonStyle()).disabled(model.chatBusy)
                }
                .padding(.horizontal, 16).padding(.bottom, 10)
            }
        }
    }

    private var rowButton: some View {
        Button { open(row) } label: {
            HStack(alignment: .center, spacing: 12) {
                ThreadDuckView(id: row.local?.stringValue ?? row.id, agent: row.agent, size: ThreadDuck.Size.pondRow)
                .frame(width: 32, height: 32)
                .background(Theme.bg, in: RoundedRectangle(cornerRadius: 9))
                .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 6) {
                    Text(verbatim: row.title).font(Typo.label).foregroundStyle(Theme.ink)
                        .lineLimit(2).multilineTextAlignment(.leading)
                    HStack(spacing: 6) {
                        if let m = row.mark { ChatMarkGlyph(mark: m) } else { PondStateMark(state: row.state) }
                        Text(verbatim: row.mark?.words ?? PondSentence.stateWord(row.state.session))
                            .font(Typo.meta).foregroundStyle(Theme.muted)
                        if row.ducklingsRunning > 0 {
                            HStack(spacing: 2) {
                                DucklingView(parentId: row.local?.stringValue ?? row.id, parentSize: ThreadDuck.Size.tab)
                                Text(verbatim: "\(row.ducklingsRunning)").font(Typo.meta).monospacedDigit().foregroundStyle(Theme.muted)
                            }
                            .help("\(DucklingWords.count(row.ducklingsRunning)) running")
                            .accessibilityLabel("\(DucklingWords.count(row.ducklingsRunning)) running")
                        }
                        if let at = row.lastAt {
                            Text("·").foregroundStyle(Theme.muted)
                            Text(verbatim: RelativeAge.short(at)).font(Typo.meta).monospacedDigit().foregroundStyle(Theme.muted)
                        }
                    }
                    if row.shared {
                        Text(verbatim: "Shared · \(row.hostingLabel)")
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
            if let key = row.local, let s = model.session(key) { RenameThreadItem(session: s) }
        }
        .help(row.title)
        .accessibilityLabel("\(row.title), \(row.mark?.words ?? PondSentence.stateWord(row.state.session)), \(row.hostingLabel), \(row.people.map { $0.you ? "you" : $0.name }.joined(separator: ", "))")
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
