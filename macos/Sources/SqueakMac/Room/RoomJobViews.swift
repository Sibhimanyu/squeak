import SqueakIcons
import SqueakMacCore
import SwiftUI

// Room jobs (CONTRACT-jobs.md): the one quiet action line under a person's message, and the claim card in Now. Squeak
// never chats; these are its only words, and nothing is taken or started until the person presses Go or Allow.

private struct SmallButtonStyle: ButtonStyle {
    let role: RoomJobButton.Role
    @Environment(\.isEnabled) private var isEnabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: role == .primary ? .semibold : .regular))
            .foregroundStyle(role == .primary ? Theme.primaryText : (role == .quiet ? Theme.muted : Theme.ink))
            .padding(.horizontal, 10).frame(minHeight: 24)
            .background {
                switch role {
                case .primary: RoundedRectangle(cornerRadius: Radius.control, style: .continuous).fill(configuration.isPressed ? Theme.primaryPressed : Theme.primaryFill)
                case .secondary: RoundedRectangle(cornerRadius: Radius.control, style: .continuous).fill(Theme.surfaceRaised.opacity(configuration.isPressed ? 0.7 : 1))
                case .quiet: Color.clear
                }
            }
            .overlay { if role == .secondary { RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(Theme.line) } }
            .opacity(isEnabled ? 1 : 0.5)
    }
}

/// The action line. Dismissed collapses in place (zero height, same row), so the feed never jumps.
struct RoomJobLineView: View {
    let line: RoomJobLine
    let open: (String) -> Void
    let act: (RoomJobLine, RoomJobAction) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            if !line.isCollapsed {
                HStack(spacing: 8) {
                    mark
                    words
                    Spacer(minLength: Space.s)
                    buttons
                }
                if let e = line.error {
                    Text(verbatim: e).font(.system(size: 12)).foregroundStyle(Theme.negative).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.leading, RoomRippleView.gutter).padding(.bottom, line.isCollapsed ? 0 : 6)
        .frame(maxWidth: .infinity, alignment: .leading)
        .clipped()
        .animation(reduceMotion ? nil : Motion.quick, value: line.isCollapsed)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(line.isCollapsed ? "" : line.spoken)
    }

    @ViewBuilder private var mark: some View {
        switch line.mark {
        case .working: WorkingGlyph(slot: TideGlyph.Grid.mark.size.width, alignment: .leading, grid: .mark)
        case .failed: Lucide(.circleX, size: 14, color: Theme.negative)
        case .none: EmptyView()
        }
    }

    @ViewBuilder private var words: some View {
        HStack(spacing: 6) {
            switch line.kind {
            case .running:
                Text(verbatim: "\(line.targetTitle ?? "A thread") \(line.lead)").foregroundStyle(Theme.ink)
            case .done:
                Text(verbatim: "Done").foregroundStyle(Theme.muted)
                if let d = line.detail { Text(verbatim: "\u{00B7}").foregroundStyle(Theme.subtle); outcomeLink(d) } else if line.turnRowId != nil { outcomeLink("see the turn") }
            default:
                Text(verbatim: line.lead).foregroundStyle(Theme.muted)
                if let t = line.target {
                    ThreadDuckView(id: t.sessionId, agent: nil, size: 16)
                    Text(verbatim: t.title).fontWeight(.medium).foregroundStyle(Theme.ink).lineLimit(1)
                    if !t.reason.isEmpty { Text(verbatim: "\u{00B7} \(t.reason)").foregroundStyle(Theme.subtle).lineLimit(1).layoutPriority(-1) }
                } else if let t = line.targetTitle {
                    Text(verbatim: t).foregroundStyle(line.kind == .newThread ? Theme.ink : Theme.ink).lineLimit(1)
                }
            }
        }
        .font(.system(size: 13)).lineLimit(1)
    }

    /// The outcome sentence links to the turn row it came from (scrolls there; the row is in the same feed).
    @ViewBuilder private func outcomeLink(_ text: String) -> some View {
        if let id = line.turnRowId {
            Button { RoomJump.shared.request(id) } label: { Text(verbatim: text).foregroundStyle(Theme.ink).lineLimit(1) }
                .buttonStyle(.plain).help("Show the turn")
        } else {
            Text(verbatim: text).foregroundStyle(Theme.ink).lineLimit(1)
        }
    }

    @ViewBuilder private var buttons: some View {
        if !line.buttons.isEmpty {
            HStack(spacing: 4) {
                ForEach(line.buttons) { b in
                    if b.id == "go" {
                        HStack(spacing: 0) {
                            Button(b.title) { act(line, b.action) }.buttonStyle(SmallButtonStyle(role: .primary))
                            if !line.candidates.isEmpty { candidatesMenu }
                        }
                    } else {
                        Button(b.title) { act(line, b.action) }.buttonStyle(SmallButtonStyle(role: b.role))
                    }
                }
            }
        }
    }

    /// Pick another thread for the job instead of the suggestion.
    private var candidatesMenu: some View {
        Menu {
            ForEach(line.candidates, id: \.sessionId) { c in
                Button(c.reason.isEmpty ? c.title : "\(c.title) \u{00B7} \(c.reason)") { act(line, .go(sessionId: c.sessionId)) }
            }
        } label: {
            Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.muted).frame(width: 18, height: 24)
        }
        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
        .accessibilityLabel("Pick another thread")
    }
}

/// A request to scroll the feed to a turn row (the done line's outcome link).
@MainActor @Observable
final class RoomJump {
    static let shared = RoomJump()
    private(set) var target: String?
    private(set) var token = 0
    func request(_ id: String) { target = id; token += 1 }
}

/// A thread asking to take a job: a decision card (§8.4) with a neutral edge, never the warning colour.
struct RoomClaimCard: View {
    let claim: RoomJobs.ClaimCard
    let decide: (RoomJobs.ClaimCard, Bool) -> Void
    @State private var decided = false

    var body: some View {
        HStack(alignment: .center, spacing: 10) {
            ThreadDuckView(id: claim.sessionId, agent: claim.agent, size: 22)
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: "\(claim.title) wants to take \u{201C}\(claim.jobText)\u{201D}")
                    .font(.system(size: 14)).foregroundStyle(Theme.ink).lineLimit(2).fixedSize(horizontal: false, vertical: true)
                Text(verbatim: claim.when).font(.system(size: 12)).foregroundStyle(Theme.muted)
            }
            Spacer(minLength: Space.m)
            Button("Allow") { go(true) }.buttonStyle(SmallButtonStyle(role: .primary)).disabled(decided)
            Button("No") { go(false) }.buttonStyle(SmallButtonStyle(role: .secondary)).disabled(decided)
        }
        .padding(.leading, 17).padding(.trailing, 14).padding(.vertical, 12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .overlay(alignment: .leading) { Rectangle().fill(Theme.lineStrong).frame(width: 3) }
        .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(Theme.line))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(claim.title) wants to take \(claim.jobText), \(claim.when)")
    }

    private func go(_ allow: Bool) { decided = true; decide(claim, allow) }
}
