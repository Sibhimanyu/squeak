#if os(iOS)
import SqueakCore
import SqueakIcons
import SwiftUI

/// DESIGN.md §8.2: Home's cards. One neutral surface (12pt, a hairline, no shadow) per group, with a
/// header that opens the group and up to a few chats under it that open themselves. The only colour
/// is the needs-you left edge and badge; every state is in words.
struct HomeGroupCard<Content: View>: View {
    var needsYou = false
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) { content }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
            .overlay(alignment: .leading) {
                if needsYou {
                    Capsule().fill(Theme.needsYou).frame(width: 3).padding(.vertical, 12).padding(.leading, 3)
                        .accessibilityHidden(true)
                }
            }
    }
}

/// §8.3: the red pill for what waits on you. Absent at zero, so the caller never draws "0".
struct CountBadge: View {
    let count: Int

    var body: some View {
        Text("\(count)")
            .font(.caption2.weight(.bold)).monospacedDigit().foregroundStyle(.white)
            .padding(.horizontal, 7).frame(minWidth: 20, minHeight: 20)
            .background(Theme.needsYou, in: Capsule())
            .accessibilityHidden(true)
    }
}

/// A card's last row: an obvious link or button, never a caption. `View all 5 sessions` opens a
/// project's or a long state's own list; `Show all 3` / `Show less` opens and closes a small state in place.
private struct CardFooterRow<Wrapper: View>: View {
    let title: String
    let symbol: LucideName
    let wrap: (AnyView) -> Wrapper

    var body: some View {
        wrap(AnyView(
            HStack(spacing: 6) {
                Text(title).font(.subheadline.weight(.medium)).foregroundStyle(Theme.ink)
                Spacer(minLength: 8)
                Lucide(symbol, size: 16, color: Theme.subtle)
            }
            .padding(.horizontal, 14)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
        ))
        .overlay(alignment: .top) { Rectangle().fill(Theme.line).frame(height: 1).padding(.horizontal, 14).accessibilityHidden(true) }
    }
}

/// One project on Home, kept short: its name and a line of counts, then its one or two most urgent
/// chats, then a way to the rest. The only needs-you mark is the left edge; the words say the rest.
struct ProjectCard: View {
    let project: Presentation.Project
    @ScaledMetric(relativeTo: .body) private var tile = 32

    var body: some View {
        let preview = Presentation.preview(project.sessions)
        let summary = Presentation.projectSummary(project.sessions)
        let needs = Presentation.needsYouCount(project.sessions)
        HomeGroupCard(needsYou: needs > 0) {
            NavigationLink(value: HomeRoute.project(project.name)) {
                HStack(spacing: 12) {
                    Lucide(.folder, size: 16, color: Theme.muted)
                        .frame(width: tile, height: tile)
                        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.line))
                    VStack(alignment: .leading, spacing: 1) {
                        Text(project.name).font(.headline).foregroundStyle(Theme.ink).lineLimit(2)
                        Text(summary).font(.footnote).foregroundStyle(Theme.muted).lineLimit(2)
                    }
                    Spacer(minLength: 8)
                    Lucide(.chevronRight, size: 16, color: Theme.subtle)
                }
                .padding(.horizontal, 14).padding(.vertical, 10).frame(minHeight: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .combine)
            .accessibilityLabel("\(project.name), \(summary)")
            .accessibilityHint("Opens the project")
            ForEach(preview.shown) { SessionPreviewRow(session: $0, context: .project) }
            if preview.more > 0 {
                CardFooterRow(title: "View all \(project.sessions.count) sessions", symbol: .chevronRight) { content in
                    NavigationLink(value: HomeRoute.project(project.name)) { content }.buttonStyle(.plain)
                }
                .accessibilityHint("Opens the project")
            } else {
                Color.clear.frame(height: 4)
            }
        }
    }
}

/// One state on Home: its word and how many chats are in it, then the chats that are. A small group
/// opens in place (its header is a disclosure, the chevron turns); a long one, and Needs you, open
/// their own list, so a tap never lands on a nearly empty page.
struct StatusGroupCard: View {
    let filter: Presentation.Filter
    let sessions: [PhoneSnapshot.Session]
    @Binding var expanded: Bool

    private var tone: Color {
        switch filter {
        case .needsYou: Theme.needsYou
        case .working: Theme.working
        case .done: Theme.done
        case .error: Theme.error
        case .all, .idle: Theme.subtle
        }
    }

    private var inline: Bool { Presentation.expandsInline(filter, count: sessions.count) }

    var body: some View {
        let ordered = Presentation.byAttention(sessions)
        let preview = Presentation.preview(sessions, limit: Presentation.previewLimit(for: filter))
        let shown = inline && expanded ? ordered : preview.shown
        let count = sessions.count
        let label = "\(filter.heading), \(count == 1 ? "1 session" : "\(count) sessions")"
        HomeGroupCard(needsYou: filter == .needsYou) {
            header(count: count)
                .accessibilityElement(children: .combine)
                .accessibilityLabel(label)
                .accessibilityValue(inline ? (expanded ? "Expanded" : "Collapsed") : "")
                .accessibilityHint(inline ? (expanded ? "Shows fewer sessions" : "Shows all sessions") : "Opens the list")
                .accessibilityAddTraits(inline ? .isButton : [])
            ForEach(shown) { SessionPreviewRow(session: $0, context: .status) }
            if preview.more > 0 {
                if inline {
                    CardFooterRow(title: expanded ? "Show less" : "Show all \(count)", symbol: expanded ? .chevronUp : .chevronDown) { content in
                        Button { toggle() } label: { content }.buttonStyle(.plain)
                    }
                } else {
                    CardFooterRow(title: "View all \(count) sessions", symbol: .chevronRight) { content in
                        NavigationLink(value: HomeRoute.status(filter)) { content }.buttonStyle(.plain)
                    }
                }
            } else {
                Color.clear.frame(height: 4)
            }
        }
    }

    private func toggle() {
        withAnimation(.easeOut(duration: 0.2)) { expanded.toggle() }
    }

    @ViewBuilder
    private func header(count: Int) -> some View {
        let row = HStack(spacing: 10) {
            // Needs you has its left edge and its badge; a third red mark would only repeat them.
            if filter != .needsYou { StatusDot(color: tone) }
            Text(filter.heading).font(.headline).foregroundStyle(Theme.ink)
            Spacer(minLength: 8)
            if filter == .needsYou {
                CountBadge(count: count)
            } else {
                Text("\(count)").font(.body).foregroundStyle(Theme.muted).monospacedDigit()
            }
            Lucide(inline ? (expanded ? .chevronUp : .chevronDown) : .chevronRight, size: 16, color: Theme.subtle)
        }
        .padding(.horizontal, 14).padding(.vertical, 10).frame(minHeight: 44).contentShape(Rectangle())
        if inline {
            Button { toggle() } label: { row }.buttonStyle(.plain)
        } else {
            NavigationLink(value: HomeRoute.status(filter)) { row }.buttonStyle(.plain)
        }
    }
}

/// A chat inside a card: title and age, then its state in words with `repo · agent` (the project's own
/// card leaves the repo out), then, if it waits on you, failed, or (under Status) finished, the
/// agent's own words. A distinct tap target: it opens the chat, the header above opens the group.
struct SessionPreviewRow: View {
    enum Context { case project, status }

    @Environment(AppModel.self) private var model
    let session: PhoneSnapshot.Session
    let context: Context

    /// The same rule as SessionRow: "starting" while this phone's own message is about to begin a turn.
    private var status: Presentation.Status {
        ChatTimeline.isStarting(session: session, sends: model.outbox[session.key] ?? [])
            ? .init(text: "starting", tone: .working)
            : Presentation.status(session)
    }

    private var detail: String? { Presentation.previewDetail(session, finished: context == .status) }

    private var second: Text {
        let rest = context == .project ? Presentation.agentName(session.agent) : Presentation.subtitle(session)
        let loud = status.tone == .needsYou || status.tone == .error
        let word = Text(status.text).fontWeight(loud ? .semibold : .regular).foregroundStyle(loud ? Theme.ink : Theme.muted)
        return Text("\(word)\(Text(" · \(rest)").foregroundStyle(Theme.muted))")
    }

    var body: some View {
        NavigationLink(value: HomeRoute.session(session.key)) {
            HStack(alignment: .top, spacing: 10) {
                AgentAvatar(session: session).padding(.top, 1)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(Presentation.displayTitle(session)).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                        Spacer(minLength: 4)
                        Text(Age.describe(session.lastActivityAt)).font(.footnote).foregroundStyle(Theme.muted).monospacedDigit()
                    }
                    second.font(.footnote).lineLimit(1)
                    if let detail {
                        Text(detail).font(.footnote).foregroundStyle(Theme.muted).lineLimit(context == .project ? 1 : 2)
                    }
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(alignment: .top) { Rectangle().fill(Theme.line).frame(height: 1).padding(.horizontal, 14).accessibilityHidden(true) }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(Presentation.displayTitle(session)), \(status.text)\(detail.map { ": \($0)" } ?? ""), \(Presentation.subtitle(session)), last active \(Age.spoken(session.lastActivityAt))")
        .accessibilityHint(session.state == "error" ? "Opens the chat to see what failed" : "Opens the chat")
    }
}

/// The apps' own icons: which agent a chat runs on, with Conductor as a corner badge when Conductor
/// holds it. Decorative to VoiceOver, since the agent's name is in the row's text. An agent we have no
/// icon for gets a neutral terminal tile, never another app's icon.
struct AgentAvatar: View {
    let session: PhoneSnapshot.Session
    var size: CGFloat = 28

    static func asset(_ agent: String) -> String? {
        switch agent.lowercased() {
        case "claude": "agent-claude"
        case "codex": "agent-codex"
        default: nil
        }
    }

    var body: some View {
        Group {
            if let name = Self.asset(session.agent) {
                Image(name, bundle: .module).resizable().scaledToFit()
            } else {
                Lucide(.squareTerminal, size: size * 0.6, color: Theme.muted)
                    .frame(width: size, height: size)
                    .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: size * 0.25))
                    .overlay(RoundedRectangle(cornerRadius: size * 0.25).stroke(Theme.line))
            }
        }
        .frame(width: size, height: size)
        .overlay(alignment: .bottomTrailing) {
            if session.conductorSessionId != nil {
                Image("agent-conductor", bundle: .module).resizable().scaledToFit()
                    .frame(width: size * 0.5, height: size * 0.5)
                    .background(Theme.surface, in: Circle().inset(by: -1.5))
                    .offset(x: size * 0.12, y: size * 0.12)
            }
        }
        .accessibilityHidden(true)
    }
}

/// The chats that went quiet, as one quiet card at the foot of Home.
struct EarlierCard: View {
    var body: some View {
        HomeGroupCard {
            NavigationLink(value: HomeRoute.recent) {
                HStack(spacing: 12) {
                    Lucide(.history, size: 18, color: Theme.muted).frame(width: 24)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Earlier").font(.headline).foregroundStyle(Theme.ink)
                        Text("Chats that went quiet, to pick up again").font(.subheadline).foregroundStyle(Theme.muted).lineLimit(2)
                    }
                    Spacer(minLength: 8)
                    Lucide(.chevronRight, size: 16, color: Theme.subtle)
                }
                .padding(14).frame(minHeight: 44).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .combine)
            .accessibilityHint("Opens older chats")
        }
    }
}
#endif
