#if os(iOS)
import SqueakCore
import SqueakIcons
import SwiftUI

/// DESIGN.md §8.2: Home's cards. One neutral surface (12pt, a hairline, no shadow) per group, with a
/// header that opens the group and up to a few chats under it that open themselves. The only colour
/// is a state-coloured left edge and badge (red for needs you, blue for unread replies); states are marks, not words (labels-v2).
struct HomeGroupCard<Content: View>: View {
    var needsYou = false
    /// An edge colour other than needs-you red, e.g. `Theme.done` for unreviewed finishes.
    var edge: Color? = nil
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) { content }
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
            .overlay(alignment: .leading) {
                if needsYou || edge != nil {
                    Capsule().fill(edge ?? Theme.warning).frame(width: 3).padding(.vertical, 12).padding(.leading, 3)
                        .accessibilityHidden(true)
                }
            }
    }
}

/// §8.3: the pill for a count: red for what waits on you, blue (`Theme.done`) for unreviewed finishes.
/// Absent at zero, so the caller never draws "0".
struct CountBadge: View {
    let count: Int
    var color: Color = Theme.needsYou

    var body: some View {
        Text("\(count)")
            .font(.caption2.weight(.bold)).monospacedDigit().foregroundStyle(.white)
            .padding(.horizontal, 7).frame(minWidth: 20, minHeight: 20)
            .background(color, in: Capsule())
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

/// One project on Home: a flat row, like a conversation list. Its icon, its name and age, its newest chat's title,
/// then the counts. The whole row opens the project; a chat is opened from there, never from here.
struct ProjectRow: View {
    @Environment(AppModel.self) private var model
    let project: Presentation.Project
    /// The last row carries no hairline under it.
    var last = false
    @ScaledMetric(relativeTo: .body) private var mark = 52

    var body: some View {
        let newest = project.sessions.first
        let summary = Presentation.chatCount(project.sessions.count)
        let unread = project.sessions.contains { model.isProjectUnread($0) }
        let running = project.sessions.contains {
            $0.state == "working" || ChatTimeline.isStarting(session: $0, sends: model.outbox[$0.key] ?? [])
        }
        let top = Presentation.projectMark(project.sessions, unread: { model.isUnread($0) }).mark
        let markWords = Presentation.projectMarkWords(project.sessions, unread: { model.isUnread($0) })
        let newestAt = newest?.lastActivityAt
        let chat = newest.map(Presentation.displayTitle)
        NavigationLink(value: HomeRoute.project(project.name)) {
            HStack(alignment: .top, spacing: 12) {
                ProjectMark(name: project.name, size: mark, folder: true, round: true)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(project.name).font(.body.weight(unread ? .semibold : .regular))
                            .foregroundStyle(unread || running ? Theme.ink : Theme.muted).lineLimit(1)
                            .runningTextLight(running, identity: "project:\(project.name)", still: !model.macIsLive)
                        Spacer(minLength: 8)
                        if let newestAt { CornerMark(mark: top, age: newestAt, font: .footnote, session: project.sessions.first { Presentation.mark($0, unread: model.isUnread($0)) == top }) }
                    }
                    HStack(spacing: 12) {
                        if let chat {
                            Text(chat).font(.subheadline.weight(unread ? .semibold : .regular))
                                .foregroundStyle(unread ? Theme.ink : Theme.muted).lineLimit(running ? 2 : 1)
                                .runningTextLight(running, identity: "project:\(project.name)", still: !model.macIsLive)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        } else { Spacer(minLength: 0) }
                        if running { ChatActivityGlyph(identity: "project:\(project.name)") }
                    }
                    Text(summary).font(.footnote).foregroundStyle(Theme.subtle).lineLimit(1)
                }
            }
            .padding(.vertical, 10)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }.tapHaptic(.navigate)
        .buttonStyle(.press)
        .overlay(alignment: .bottom) {
            if !last { Rectangle().fill(Theme.line).frame(height: 1).padding(.leading, mark + 12).accessibilityHidden(true) }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(project.name), \(summary)\(running ? ", Running" : "")\(unread ? ", Unread finished replies" : "")\(markWords.map { ", \($0)" } ?? "")\(chat.map { ", latest chat \($0)" } ?? "")")
        .accessibilityHint("Opens the project")
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
        case .needsYou: Theme.warning
        case .working: Theme.muted
        case .done: Theme.done
        case .error: Theme.negative
        case .all, .idle: Theme.subtle
        }
    }

    private var inline: Bool { Presentation.expandsInline(filter, count: sessions.count) }

    var body: some View {
        let ordered = Presentation.newestFirst(sessions)
        let preview = Presentation.preview(sessions, limit: Presentation.previewLimit(for: filter))
        let shown = inline && expanded ? ordered : preview.shown
        let count = sessions.count
        let label = "\(filter.heading), \(Presentation.chatCount(count))"
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
                        Button { Haptics.play(.tap); toggle() } label: { content }.buttonStyle(.press)
                    }
                } else {
                    CardFooterRow(title: "View all \(count) chats", symbol: .chevronRight) { content in
                        NavigationLink(value: HomeRoute.status(filter)) { content }.tapHaptic(.navigate).buttonStyle(.press)
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
            if filter == .working { WorkingGlyph() } else if filter == .error { Lucide(.circleX, size: 15, color: Theme.negative) }
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
            Button { Haptics.play(.tap); toggle() } label: { row }.buttonStyle(.press)
        } else {
            NavigationLink(value: HomeRoute.status(filter)) { row }.tapHaptic(.navigate).buttonStyle(.press)
        }
    }
}

/// A chat inside a card: title and its trailing mark (the age when it has none), then one muted second line
/// (labels-v2: the step, the ask, the failure reason, or the agent's last words; no state word). A distinct tap
/// target: it opens the chat, the header above opens the group.
struct SessionPreviewRow: View {
    enum Context { case project, status }

    @Environment(AppModel.self) private var model
    let session: PhoneSnapshot.Session
    let context: Context

    /// "starting" while this phone's own message is about to begin a turn, as SessionRow does.
    private var starting: Bool { ChatTimeline.isStarting(session: session, sends: model.outbox[session.key] ?? []) }

    var body: some View {
        let mark = Presentation.mark(session, unread: model.isUnread(session))
        let loud = model.isUnread(session)
        let second = starting ? "Starting" : Presentation.secondLine(session)
        NavigationLink(value: HomeRoute.session(session.key)) {
            HStack(alignment: .top, spacing: 10) {
                AgentAvatar(session: session, conductorBadge: false).padding(.top, 1)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(alignment: .center, spacing: 8) {
                        // Under Status the project is not the card's title, so its icon says which one this is.
                        if context == .status { ProjectMark(name: Presentation.projectName(session), size: 18) }
                        Text(Presentation.displayTitle(session)).font(.subheadline.weight(loud ? .semibold : .regular))
                            .foregroundStyle(loud ? Theme.ink : Theme.muted).lineLimit(1)
                            .runningTextLight(starting || session.state == "working", identity: session.key, still: !model.macIsLive)
                        if session.conductorSessionId != nil { ConductorMarker() }
                        Spacer(minLength: 4)
                        CornerMark(mark: starting ? .working : mark, age: session.lastActivityAt, font: .footnote, session: session)
                    }
                    HStack(spacing: 8) {
                        if let second {
                            Text(second).font(.footnote).foregroundStyle(Theme.muted).lineLimit(1)
                                .runningTextLight(starting || session.state == "working", identity: session.key, still: !model.macIsLive)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        } else { Spacer(minLength: 0) }
                        if starting || session.state == "working" { ChatActivityGlyph(identity: session.key) }
                    }
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }.tapHaptic(.navigate)
        .buttonStyle(.press)
        .renameMenu(session, model: model)
        .overlay(alignment: .top) { Rectangle().fill(Theme.line).frame(height: 1).padding(.horizontal, 14).accessibilityHidden(true) }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(Presentation.rowLabel(session, mark: mark))\(second.map { ": \($0)" } ?? "")")
        .accessibilityHint(mark == .failed ? "Opens the chat to see what failed" : "Opens the chat")
    }
}

/// Conductor's icon for a project, as the Mac sent it: a small rounded square. Without one, a neutral folder
/// when `folder` is set (a project's own card), else nothing, so a row never carries a made-up mark.
struct ProjectMark: View {
    @Environment(AppModel.self) private var model
    let name: String
    var size: CGFloat = 16
    var folder = false
    /// A circle, for the Home list's project rows.
    var round = false

    var body: some View {
        let radius = round ? size / 2 : size * 0.25
        if round, let logo = model.projectLogo(name) {
            // Fitted by its own shape: drawn at `fit.scale` of the circle, on its own ground, so artwork that
            // reaches the image's corners is not cut by the circle.
            let fit = logo.fit
            let side = max(min(logo.image.size.width, logo.image.size.height), 1)
            let ground = fit.background.map { Color(red: $0.r, green: $0.g, blue: $0.b) } ?? Theme.surfaceRaised
            ZStack {
                Circle().fill(ground)
                Image(uiImage: logo.image).resizable()
                    .frame(width: size * fit.scale * logo.image.size.width / side,
                           height: size * fit.scale * logo.image.size.height / side)
            }
            .frame(width: size, height: size)
            .clipShape(Circle())
            .overlay(Circle().stroke(Theme.line))
            .accessibilityHidden(true)
        } else if let image = model.projectIcon(name) {
            Image(uiImage: image).resizable().scaledToFill()
                .frame(width: size, height: size)
                .clipShape(RoundedRectangle(cornerRadius: radius))
                .overlay(RoundedRectangle(cornerRadius: radius).stroke(Theme.line))
                .accessibilityHidden(true)
        } else if folder {
            Lucide(.folder, size: size * 0.5, color: Theme.muted)
                .frame(width: size, height: size)
                .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: radius))
                .overlay(RoundedRectangle(cornerRadius: radius).stroke(Theme.line))
        }
    }
}

/// The apps' own icons: which agent a chat runs on, with Conductor as a corner badge when Conductor
/// holds it. Decorative to VoiceOver, since the agent's name is in the row's text. An agent we have no
/// icon for gets a neutral terminal tile, never another app's icon.
struct AgentAvatar: View {
    let session: PhoneSnapshot.Session
    var size: CGFloat = 28
    /// Conductor's corner badge; the rows draw `ConductorMarker` after the title instead.
    var conductorBadge = true

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
            if conductorBadge, session.conductorSessionId != nil {
                Image("agent-conductor", bundle: .module).resizable().scaledToFit()
                    .frame(width: size * 0.5, height: size * 0.5)
                    .background(Theme.surface, in: Circle().inset(by: -1.5))
                    .offset(x: size * 0.12, y: size * 0.12)
            }
        }
        .accessibilityHidden(true)
    }
}

/// The age stays quiet: activity has a trailing glyph, unread is title weight, and decisions live in the chat.
struct CornerMark: View {
    let mark: Presentation.Mark
    let age: String
    var font: Font = .subheadline
    var session: PhoneSnapshot.Session? = nil

    var body: some View {
        Group {
            // Activity is carried by the row's trailing glyph and unread title weight.
            // Approval and failure details remain in the conversation, not a separate navigation state.
            Text(Age.describe(age)).font(font).foregroundStyle(Theme.muted).monospacedDigit()
        }
        .frame(minWidth: 28, minHeight: 16, alignment: .trailing)
        .accessibilityHidden(true)
    }
}

/// A compact glyph field, static under Reduce Motion or while the Mac is unavailable.
struct WorkingGlyph: View {
    @Environment(AppModel.self) private var model
    var quiet = false

    var body: some View {
        if model.macIsLive { GlyphLoader(size: 14, quiet: quiet) } else { GlyphLoader(size: 14, quiet: quiet, color: Theme.subtle, still: true) }
    }
}

/// Marks a chat that lives in Conductor: a 14pt outlined square with a C, after the title. Native chats have none.
struct ConductorMarker: View {
    var body: some View {
        Text("C").font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.subtle)
            .frame(width: 14, height: 14)
            .overlay(RoundedRectangle(cornerRadius: 3).stroke(Theme.lineStrong))
            .accessibilityLabel("Conductor chat")
    }
}

struct UnreadMark: View {
    var body: some View {
        Circle().fill(Theme.done).frame(width: 8, height: 8).accessibilityHidden(true)
    }
}

/// Replies you have not read, however long ago they came: a chat does not drop off Home just because the
/// quarter hour passed. Quiet Done blue (left edge, count), placed below every active group so needs-you
/// stays first and the only red on screen.
struct NewRepliesCard: View {
    let sessions: [PhoneSnapshot.Session]

    var body: some View {
        HomeGroupCard(edge: Theme.done) {
            HStack(spacing: 10) {
                Text("New replies").font(.headline).foregroundStyle(Theme.ink)
                Spacer(minLength: 8)
                CountBadge(count: sessions.count, color: Theme.done)
            }
            .padding(.horizontal, 14).padding(.vertical, 10).frame(minHeight: 44)
            .accessibilityElement(children: .combine).accessibilityAddTraits(.isHeader)
            ForEach(sessions.prefix(6)) { session in
                Rectangle().fill(Theme.line).frame(height: 1).padding(.leading, 14).accessibilityHidden(true)
                NavigationLink(value: HomeRoute.session(session.key)) {
                    SessionRow(session: session, recent: true)
                        .padding(.horizontal, 14).padding(.vertical, 4).frame(maxWidth: .infinity, alignment: .leading).contentShape(Rectangle())
                }.tapHaptic(.navigate)
                .buttonStyle(.press)
            }
            Color.clear.frame(height: 4)
        }
    }
}

/// The end of Home's project list: a plain line to the older chats, with no card around it.
struct FindOlderChatsLine: View {
    var body: some View {
        NavigationLink(value: HomeRoute.recent) {
            Text("Find older chats")
                .font(.subheadline).foregroundStyle(Theme.muted)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .contentShape(Rectangle())
        }.tapHaptic(.navigate)
        .buttonStyle(.press)
        .accessibilityHint("Opens older chats")
    }
}
#endif
