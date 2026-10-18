import AppKit
import SqueakMacCore
import SwiftUI

// Shared components for the v3 redesign (.context/v3/DESIGN-BRIEF.md). Every screen builds from
// these. Rules in one line: whitespace and type do the work; no borders on rows or cards, no
// per-row icons, state colour only on the dot and the chip. Nothing here ever sends by itself:
// actions arrive as closures and the caller decides.

/// Spacing scale 4/8/12/16/24/32.
enum Space {
    static let xs: CGFloat = 4
    static let s: CGFloat = 8
    static let m: CGFloat = 12
    static let l: CGFloat = 16
    static let xl: CGFloat = 24
    static let xxl: CGFloat = 32
}

/// Corner radii: rows 8, cards 12, capsule composer 22.
enum Radius {
    static let row: CGFloat = 8
    static let card: CGFloat = 12
    static let capsule: CGFloat = 22
    static let bubble: CGFloat = 10
}

// MARK: Section label

/// 11pt semibold uppercase, tracking 0.6, `subtle`.
struct SectionLabel: View {
    let title: String
    var count: Int?

    init(_ title: String, count: Int? = nil) {
        self.title = title
        self.count = count
    }

    var body: some View {
        HStack(spacing: 6) {
            Text(title.uppercased())
                .font(.system(size: 11, weight: .semibold))
                .tracking(0.6)
            if let count {
                Text("\(count)").font(.system(size: 11, weight: .medium)).monospacedDigit()
            }
        }
        .foregroundStyle(Theme.subtle)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityAddTraits(.isHeader)
    }
}

/// Hairline between sections and under headers; the only line in the UI.
struct Hairline: View {
    var body: some View { Rectangle().fill(Theme.line).frame(height: 1) }
}

// MARK: Time

/// Short relative time ("now", "2m", "1h", "3d", "2w"), 11.5pt subtle, monospaced digits.
struct RelativeTimeText: View {
    let date: Date?
    var size: CGFloat = 11.5

    init(_ date: Date?, size: CGFloat = 11.5) {
        self.date = date
        self.size = size
    }

    var body: some View {
        if let date {
            TimelineView(.periodic(from: .now, by: 30)) { ctx in
                Text(ShortRelativeTime.format(date, now: ctx.date))
                    .font(.system(size: size))
                    .monospacedDigit()
                    .foregroundStyle(Theme.subtle)
            }
        }
    }
}

// MARK: Duck

/// The brand duck. The app icon when running bundled; otherwise a placeholder tinted `Theme.duck`.
struct DuckGlyph: View {
    var size: CGFloat = 18

    /// The brand duck: the traced menu-bar silhouette, filled duck-yellow, eye cut out.
    var body: some View {
        DuckShape(showsWing: size >= 24)
            .fill(Theme.duck, style: FillStyle(eoFill: true))
            .aspectRatio(DuckGlyphPath.aspect, contentMode: .fit)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

// MARK: State

/// Dot plus word on the state colour at 14% alpha, 11.5pt medium, capsule.
struct StateChip: View {
    let state: SessionState
    var title: String?

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(Theme.color(for: state)).frame(width: 6, height: 6)
            Text(title ?? Theme.label(for: state))
                .font(.system(size: 11.5, weight: .medium))
                .foregroundStyle(Theme.color(for: state))
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 3)
        .background(Theme.color(for: state).opacity(0.14), in: Capsule())
        .accessibilityElement(children: .combine)
        .accessibilityLabel("State: \(title ?? Theme.label(for: state))")
    }
}

// MARK: Row

/// dot · title/subtitle · time. Hover fills `surfaceRaised` 35%, selected 70%. No border, no icon.
/// The pin shows only on hover or selection. Taps are the caller's (wrap in Button or onTapGesture).
struct SessionRowView: View {
    let session: HostSession
    var isSelected = false
    var isPinned = false
    /// Replaces "repo · branch" (search snippets).
    var subtitleOverride: String?
    /// Appends the agent name ("repo · branch · Claude"); the popover wants it, the sidebar does not.
    var showsAgent = false

    @State private var hovering = false

    var body: some View {
        HStack(alignment: .top, spacing: Space.m) {
            StateDot(state: session.state)
                .frame(height: 17)  // centres on the 13pt title line
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 5) {
                    Text(verbatim: session.label)
                        .font(.system(size: 13, weight: .medium))
                        .foregroundStyle(Theme.ink)
                        .lineLimit(1)
                    if isPinned && (hovering || isSelected) {
                        Image(systemName: "pin.fill").font(.system(size: 8)).foregroundStyle(Theme.subtle)
                            .accessibilityLabel("Pinned")
                    }
                }
                Text(verbatim: subtitleOverride ?? SessionRowView.subtitle(session, showsAgent: showsAgent))
                    .font(.system(size: 12))
                    .foregroundStyle(Theme.muted)
                    .lineLimit(1)
            }
            Spacer(minLength: Space.s)
            RelativeTimeText(session.lastActivityAt).frame(height: 17)
        }
        .padding(.horizontal, Space.m)
        .padding(.vertical, 7)
        .background(
            RoundedRectangle(cornerRadius: Radius.row).fill(Theme.surfaceRaised.opacity(isSelected ? 0.7 : hovering ? 0.35 : 0))
        )
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(session.label), \(Theme.label(for: session.state))")
    }

    static func subtitle(_ s: HostSession, showsAgent: Bool = false) -> String {
        var parts = [s.repoName, s.branch].compactMap { $0 }.filter { !$0.isEmpty }
        if showsAgent, let a = agentName(s.agent) { parts.append(a) }
        return parts.joined(separator: " · ")
    }

    static func agentName(_ raw: String?) -> String? {
        switch raw?.lowercased() {
        case "claude": "Claude"
        case "codex": "Codex"
        case .some(let a) where !a.isEmpty: a.capitalized
        default: nil
        }
    }
}

/// The quiet "Show 12 earlier" row that sits under Recent.
struct ShowEarlierRow: View {
    let count: Int
    var expanded = false
    var action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Image(systemName: expanded ? "chevron.up" : "chevron.down").font(.system(size: 9, weight: .semibold))
                Text(expanded ? "Hide earlier" : "Show \(count) earlier").font(.system(size: 12))
                Spacer()
            }
            .foregroundStyle(Theme.muted)
            .padding(.horizontal, Space.m)
            .padding(.vertical, 7)
            .background(RoundedRectangle(cornerRadius: Radius.row).fill(Theme.surfaceRaised.opacity(hovering ? 0.35 : 0)))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }
}

// MARK: Choices

/// Wraps its children onto lines.
struct FlowLayout: Layout {
    var spacing: CGFloat = Space.s

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        arrange(proposal.width ?? .infinity, subviews).size
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let r = arrange(bounds.width, subviews)
        for (i, p) in r.origins.enumerated() {
            subviews[i].place(at: CGPoint(x: bounds.minX + p.x, y: bounds.minY + p.y), proposal: .unspecified)
        }
    }

    private func arrange(_ width: CGFloat, _ subviews: Subviews) -> (size: CGSize, origins: [CGPoint]) {
        var x: CGFloat = 0, y: CGFloat = 0, rowH: CGFloat = 0, maxX: CGFloat = 0
        var origins: [CGPoint] = []
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > 0, x + s.width > width { x = 0; y += rowH + spacing; rowH = 0 }
            origins.append(CGPoint(x: x, y: y))
            x += s.width + spacing
            rowH = max(rowH, s.height)
            maxX = max(maxX, x - spacing)
        }
        return (CGSize(width: maxX, height: y + rowH), origins)
    }
}

/// A/B/C chips. Tapping calls `onChoose` with the choice; the caller sends just the letter through
/// the normal send path. Never automatic.
struct ChoiceChips: View {
    let choices: [Choice]
    var isEnabled = true
    var onChoose: (Choice) -> Void

    var body: some View {
        FlowLayout(spacing: Space.s) {
            ForEach(choices, id: \.letter) { c in
                ChoiceChip(choice: c, isEnabled: isEnabled) { onChoose(c) }
            }
        }
    }
}

private struct ChoiceChip: View {
    let choice: Choice
    let isEnabled: Bool
    let action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 8) {
                Text(choice.letter)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Theme.muted)
                    .frame(width: 18, height: 18)
                    .background(Theme.bg.opacity(0.55), in: RoundedRectangle(cornerRadius: 5))
                Text(verbatim: choice.label)
                    .font(.system(size: 12.5))
                    .foregroundStyle(Theme.ink)
                    .lineLimit(1)
            }
            .padding(.leading, 6)
            .padding(.trailing, 12)
            .frame(height: 30)
            .background(Theme.surfaceRaised.opacity(hovering && isEnabled ? 1 : 0.8), in: RoundedRectangle(cornerRadius: Radius.row))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!isEnabled)
        .opacity(isEnabled ? 1 : 0.5)
        .onHover { hovering = $0 }
        .accessibilityLabel("Reply \(choice.letter): \(choice.label)")
    }
}

// MARK: Needs-you card

/// Dot + title + time, subtitle, the agent's question (2 lines), ChoiceChips if any, and a quiet
/// Reply button that opens an inline capsule field (Return sends). `onChoose` and `onReply` are the
/// caller's send path; the card never sends on its own.
struct NeedsYouCard: View {
    let session: HostSession
    var question: String?
    var choices: [Choice] = []
    /// False when the session cannot be answered from here (read-only, no reply target).
    var canReply = true
    var onOpen: () -> Void = {}
    var onChoose: (Choice) -> Void = { _ in }
    var onReply: (String) -> Void = { _ in }
    /// A quiet line under the card: a send is in flight, or why it did not go.
    var notice: String?

    @State private var replying = false
    @State private var text = ""
    @State private var hovering = false
    @FocusState private var fieldFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: Space.m) {
            Button(action: onOpen) {
                VStack(alignment: .leading, spacing: Space.s) {
                    HStack(alignment: .top, spacing: Space.m) {
                        StateDot(state: .blocked).frame(height: 17)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(verbatim: session.label)
                                .font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.ink).lineLimit(1)
                            Text(verbatim: SessionRowView.subtitle(session, showsAgent: true))
                                .font(.system(size: 12)).foregroundStyle(Theme.muted).lineLimit(1)
                        }
                        Spacer(minLength: Space.s)
                        RelativeTimeText(session.lastActivityAt).frame(height: 17)
                    }
                    if let question, !question.isEmpty {
                        Text(verbatim: question)
                            .font(.system(size: 13))
                            .foregroundStyle(Theme.ink.opacity(0.85))
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.leading, 20)  // under the title, past the dot
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)

            if canReply {
                if replying {
                    if !choices.isEmpty { ChoiceChips(choices: choices, onChoose: onChoose) }
                    replyField
                } else {
                    // Chips and the quiet Reply share one line when they fit.
                    FlowLayout(spacing: Space.s) {
                        ForEach(choices, id: \.letter) { c in ChoiceChip(choice: c, isEnabled: true) { onChoose(c) } }
                        replyButton
                    }
                }
            }
            if let notice {
                Text(verbatim: notice).font(.system(size: 11.5)).foregroundStyle(Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(12)
        .background(Theme.surfaceRaised.opacity(hovering ? 0.65 : 0.55), in: RoundedRectangle(cornerRadius: Radius.card))
        .onHover { hovering = $0 }
        .accessibilityElement(children: .contain)
    }

    private var replyButton: some View {
        Button {
            replying = true
            fieldFocused = true
        } label: {
            Text("Reply")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Theme.muted)
                .padding(.horizontal, Space.s)
                .frame(height: 30)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var replyField: some View {
        HStack(spacing: Space.s) {
            TextField("Reply to \(SessionRowView.agentName(session.agent) ?? "agent")…", text: $text)
                .textFieldStyle(.plain)
                .font(.system(size: 13))
                .focused($fieldFocused)
                .onSubmit(submit)
                .onExitCommand { replying = false; text = "" }
            Button(action: submit) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(trimmed.isEmpty ? Theme.muted : Theme.primaryText)
                    .frame(width: 24, height: 24)
                    .background(trimmed.isEmpty ? Theme.surfaceRaised : Theme.duck, in: Circle())
            }
            .buttonStyle(.plain)
            .disabled(trimmed.isEmpty)
            .accessibilityLabel("Send reply")
        }
        .padding(.leading, 14)
        .padding(.trailing, 4)
        .frame(height: 32)
        .background(Theme.bg.opacity(0.5), in: Capsule())
    }

    private var trimmed: String { text.trimmingCharacters(in: .whitespacesAndNewlines) }

    private func submit() {
        guard !trimmed.isEmpty else { return }
        onReply(trimmed)
        text = ""
        replying = false
    }
}

// MARK: Search

/// Rounded 8, raised 50%, magnifier, placeholder, optional hint chip ("⌘F").
struct SearchField: View {
    @Binding var text: String
    var placeholder = "Search chats"
    var hint: String?
    var focus: FocusState<Bool>.Binding?

    var body: some View {
        HStack(spacing: 7) {
            Image(systemName: "magnifyingglass").font(.system(size: 12)).foregroundStyle(Theme.subtle)
                .accessibilityHidden(true)
            field
            if !text.isEmpty {
                Button { text = "" } label: {
                    Image(systemName: "xmark.circle.fill").font(.system(size: 12)).foregroundStyle(Theme.subtle)
                }
                .buttonStyle(.plain).accessibilityLabel("Clear search")
            } else if let hint {
                Text(hint).font(.system(size: 11)).foregroundStyle(Theme.subtle)
            }
        }
        .padding(.horizontal, 10)
        .frame(height: 30)
        .background(Theme.surfaceRaised.opacity(0.5), in: RoundedRectangle(cornerRadius: Radius.row))
    }

    @ViewBuilder private var field: some View {
        if let focus {
            TextField(placeholder, text: $text).textFieldStyle(.plain).font(.system(size: 13)).focused(focus)
        } else {
            TextField(placeholder, text: $text).textFieldStyle(.plain).font(.system(size: 13))
        }
    }
}
