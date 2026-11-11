import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md §8.10, Pond home, Workspaces: one soft card per workspace, its chats as rows, and the people in each chat
// as an avatar stack. What goes where is decided in `PondHomeLayout`; this only draws.

struct PondWorkspacesView: View {
    let layout: PondHomeLayout
    let members: [FlockMember]
    let open: (PondChatRow) -> Void

    static func countSuffix(_ n: Int?) -> String {
        guard let n, n > 0 else { return "" }
        return " \u{00B7} \(n) \(n == 1 ? "thread" : "threads")"
    }

    var body: some View {
        if !layout.workspaces.isEmpty {
            PondSection("Branches") {
                VStack(spacing: Space.s) {
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

    var body: some View {
        VStack(alignment: .leading, spacing: Space.xs) {
            HStack(spacing: Space.s) {
                Text(verbatim: card.name).font(Typo.label).foregroundStyle(Theme.ink).lineLimit(1)
                if let b = card.branch {
                    HStack(spacing: 4) {
                        Lucide(.gitBranch, size: 11, color: Theme.muted)
                        Text(verbatim: b).font(.system(size: 11, design: .monospaced)).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.middle)
                    }
                }
                Spacer(minLength: 0)
                if let m = card.mark { ChatMarkGlyph(mark: m.mark).help(m.words) }
            }
            .padding(.horizontal, Space.m).padding(.top, Space.s)
            ForEach(card.chats) { r in PondChatRowView(row: r, members: members, open: open) }
        }
        .padding(.bottom, Space.xs).frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
    }
}

private struct PondChatRowView: View {
    let row: PondChatRow
    let members: [FlockMember]
    let open: (PondChatRow) -> Void

    var body: some View {
        Button { open(row) } label: {
            HStack(spacing: Space.s) {
                Text(verbatim: row.title).font(Typo.body).foregroundStyle(Theme.ink).lineLimit(1)
                if row.shared { Lucide(.users, size: 12, color: Theme.muted).help("Shared with the flock") }
                Spacer(minLength: Space.s)
                if let a = AgentMark(agent: row.agent, size: 16) { a.help(SessionText.agentName(row.agent) ?? "") }
                if let m = row.mark { ChatMarkGlyph(mark: m) } else { PondStateMark(state: row.state) }
                if let at = row.lastAt {
                    Text(verbatim: RelativeAge.short(at)).font(Typo.meta).monospacedDigit().foregroundStyle(Theme.subtle)
                }
                PondAvatarStack(people: row.people)
            }
            .padding(.horizontal, Space.m).padding(.vertical, 6).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(row.title), \(PondSentence.stateWord(row.state.session)), \(row.people.map { $0.you ? "you" : $0.name }.joined(separator: ", "))")
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
