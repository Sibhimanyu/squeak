#if os(iOS)
import SqueakCore
import SqueakIcons
import SwiftUI

/// §8.3: the pill for a count: red for what waits on you, yellow (`Theme.done`) for unreviewed finishes.
/// Absent at zero, so the caller never draws "0".
struct CountBadge: View {
    let count: Int
    var color: Color = Theme.needsYou
    /// The number's colour: white on red, `Theme.primaryText` on unread yellow (white on the duck's yellow fails).
    var onColor: Color = .white

    var body: some View {
        Text("\(count)")
            .font(.caption2.weight(.bold)).monospacedDigit().foregroundStyle(onColor)
            .padding(.horizontal, 7).frame(minWidth: 20, minHeight: 20)
            .background(color, in: Capsule())
            .accessibilityHidden(true)
    }
}

/// Two dots: this pond is shared with someone. The words are for VoiceOver.
struct SharedPondMark: View {
    let pond: PhoneSnapshot.Pond?
    var body: some View {
        let online = pond?.members.filter(\.online).count ?? 0
        HStack(spacing: 2) {
            Circle().fill(Theme.subtle).frame(width: 5, height: 5)
            Circle().fill(online > 0 ? Theme.ink : Theme.subtle).frame(width: 5, height: 5)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(online > 0 ? "Shared pond, \(online) online" : "Shared pond")
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

/// A thread's duck (DESIGN.md §6.5): the brand's template duck in the thread's own colour, picked from its id
/// (`ThreadDuck`, the same hash as the Mac), with the agent's mark as a badge at the bottom-right corner. Decorative
/// to VoiceOver, since the agent's name is in the row's text. An agent we have no icon for gets no badge.
struct AgentAvatar: View {
    let session: PhoneSnapshot.Session
    var size: CGFloat = 28
    /// Conductor's marker, at the top-right corner; the rows draw `ConductorMarker` after the title instead.
    var conductorBadge = true

    static func asset(_ agent: String) -> String? {
        switch agent.lowercased() {
        case "claude": "agent-claude"
        case "codex": "agent-codex"
        default: nil
        }
    }

    var body: some View {
        ThreadDuckImage(id: session.key, size: size)
            .overlay(alignment: .bottomTrailing) {
                if let name = Self.asset(session.agent) {
                    Image(name, bundle: .module).resizable().scaledToFit()
                        .frame(width: ThreadDuck.badgeSize(duck: size), height: ThreadDuck.badgeSize(duck: size))
                        .background(Theme.surface, in: Circle().inset(by: -1.5))
                        .offset(x: size * ThreadDuck.badgeOffsetFraction, y: size * ThreadDuck.badgeOffsetFraction)
                }
            }
            .overlay(alignment: .topTrailing) {
                if conductorBadge, session.isConductor {
                    Image(systemName: "point.3.connected.trianglepath.dotted")
                        .font(.system(size: ThreadDuck.badgeSize(duck: size)))
                        .foregroundStyle(Theme.muted)
                        .accessibilityLabel("Conductor chat")
                        .frame(width: ThreadDuck.badgeSize(duck: size), height: ThreadDuck.badgeSize(duck: size))
                        .background(Theme.surface, in: Circle().inset(by: -1.5))
                        .offset(x: size * ThreadDuck.badgeOffsetFraction, y: -size * ThreadDuck.badgeOffsetFraction)
                }
            }
            .accessibilityHidden(true)
    }
}

/// A thread row's small duck and the count of helpers running, only while some run. Decorative colour only:
/// the duck is the thread's own tint, never a state colour (DESIGN.md).
struct DucklingCount: View {
    let session: PhoneSnapshot.Session

    var body: some View {
        let n = session.ducklingsRunning
        if n > 0 {
            HStack(spacing: 3) {
                ThreadDuckImage(id: session.key, size: ThreadDuck.ducklingSize(parent: ThreadDuck.phoneRowSize))
                Text("\(n)").font(.caption2.monospacedDigit().weight(.semibold)).foregroundStyle(Theme.muted)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("\(n) \(n == 1 ? "duckling" : "ducklings") running")
        }
    }
}

/// The template duck alone, tinted from the thread id; a subagent is the same at `ThreadDuck.ducklingSize`.
struct ThreadDuckImage: View {
    let id: String
    var size: CGFloat = 28
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let c = ThreadDuck.hsb(for: id, dark: scheme == .dark)
        Image("thread-duck", bundle: .module).renderingMode(.template).resizable().scaledToFit()
            .foregroundStyle(Color(hue: c.h / 360, saturation: c.s, brightness: c.b))
            .frame(width: size, height: size)
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

#endif
