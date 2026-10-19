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

/// Corner radii (§5): panel 16, card 12, control 8, chip 6.
enum Radius {
    static let panel: CGFloat = 16
    static let card: CGFloat = 12
    static let control: CGFloat = 8
    static let chip: CGFloat = 6
    static let row: CGFloat = 8
}

// MARK: Section label

/// Section header (§4.2 `heading`, sentence case: the product has no all-caps labels).
struct SectionLabel: View {
    let title: String
    var count: Int?

    init(_ title: String, count: Int? = nil) {
        self.title = title
        self.count = count
    }

    var body: some View {
        HStack(spacing: 6) {
            Text(title).font(Typo.heading).foregroundStyle(Theme.ink)
            if let count {
                Text("\(count)").font(Typo.meta).monospacedDigit().foregroundStyle(Theme.muted)
            }
        }
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

/// What a session is called and said about, in DESIGN.md §8.2's words: `repo · branch` (the daemon's
/// disambiguated title when two rows would read the same), then `agent · state · age`.
enum SessionText {
    static func name(_ s: HostSession) -> String {
        if let d = s.distinctTitle, !d.isEmpty { return d }
        let parts = [s.repoName, s.branch].compactMap { $0 }.filter { !$0.isEmpty }
        return parts.isEmpty ? s.label : parts.joined(separator: " · ")
    }

    /// §3.3: the word for the state. Both blocked states share one colour; the word says which.
    static func stateWord(_ s: HostSession) -> String {
        switch s.state {
        case .blocked: s.awaitingApproval == true ? "needs approval" : "needs an answer"
        case .working: "working"
        case .finished: "done"
        case .idle: "idle"
        case .error: "error"
        case .unknown: "unknown"
        }
    }

    static func agent(_ raw: String?) -> String? {
        guard let raw, !raw.isEmpty else { return nil }
        return raw.lowercased()
    }
}

/// `agent · state · age`, muted, with the state word in its colour only when the session needs you.
struct MetaLine: View {
    let session: HostSession

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { ctx in
            text(now: ctx.date).font(Typo.meta).monospacedDigit().lineLimit(1)
        }
    }

    private func text(now: Date) -> Text {
        let sep = Text(verbatim: " · ").foregroundStyle(Theme.subtle)
        var t = Text(verbatim: "")
        if let a = SessionText.agent(session.agent) { t = t + Text(verbatim: a).foregroundStyle(Theme.muted) + sep }
        let word = Text(verbatim: SessionText.stateWord(session))
        t = t + (session.state == .blocked ? word.foregroundStyle(Theme.needsYou) : word.foregroundStyle(Theme.muted))
        if let at = session.lastActivityAt { t = t + sep + Text(verbatim: ShortRelativeTime.format(at, now: now)).foregroundStyle(Theme.muted) }
        return t
    }
}

/// dot · name / meta. Hover fills `surfaceRaised` (§8.2), selected a little more. No icon.
/// The pin shows only on hover or selection. Taps are the caller's (wrap in Button or onTapGesture).
struct SessionRowView: View {
    let session: HostSession
    var isSelected = false
    var isPinned = false
    /// Replaces the meta line (search snippets).
    var subtitleOverride: String?

    @State private var hovering = false

    var body: some View {
        HStack(alignment: .top, spacing: Space.m) {
            StateDot(state: session.state)
                .frame(height: 19)  // aligned to the first text line
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 5) {
                    Text(verbatim: SessionText.name(session))
                        .font(Typo.label)
                        .foregroundStyle(Theme.ink)
                        .lineLimit(1)
                    if isPinned && (hovering || isSelected) {
                        Image(systemName: "pin.fill").font(.system(size: 8)).foregroundStyle(Theme.subtle)
                            .accessibilityLabel("Pinned")
                    }
                }
                if let o = subtitleOverride {
                    Text(verbatim: o).font(Typo.meta).foregroundStyle(Theme.muted).lineLimit(1)
                } else {
                    MetaLine(session: session)
                }
            }
            Spacer(minLength: Space.s)
        }
        .padding(.horizontal, Space.m)
        .padding(.vertical, 7)
        .background(
            RoundedRectangle(cornerRadius: Radius.row).fill(Theme.surfaceRaised.opacity(isSelected ? 1 : hovering ? 0.7 : 0))
        )
        .contentShape(Rectangle())
        .onHover { hovering = $0 }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(SessionText.name(session)), \(SessionText.agent(session.agent) ?? "agent"), \(SessionText.stateWord(session))")
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
                    .font(Typo.meta.weight(.semibold))
                    .foregroundStyle(Theme.muted)
                    .frame(width: 18, height: 18)
                    .background(Theme.bg, in: RoundedRectangle(cornerRadius: Radius.chip))
                Text(verbatim: choice.label)
                    .font(Typo.label)
                    .foregroundStyle(Theme.ink)
                    .lineLimit(1)
            }
            .padding(.leading, 6)
            .padding(.trailing, 12)
            .frame(height: 30)
            .background(Theme.surfaceRaised.opacity(hovering && isEnabled ? 1 : 0.8), in: RoundedRectangle(cornerRadius: Radius.control))
            .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
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
                        StateDot(state: .blocked).frame(height: 19)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(verbatim: SessionText.name(session))
                                .font(Typo.label).foregroundStyle(Theme.ink).lineLimit(1)
                            MetaLine(session: session)
                        }
                        Spacer(minLength: Space.s)
                    }
                    if let question, !question.isEmpty {
                        Text(verbatim: question)
                            .font(Typo.body)
                            .foregroundStyle(Theme.ink)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(.leading, 21)  // under the title, past the dot
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
                Text(verbatim: notice).font(Typo.meta).foregroundStyle(Theme.muted)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(12)
        .background(hovering ? Theme.surfaceRaised : Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
        .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Theme.line))
        .onHover { hovering = $0 }
        .accessibilityElement(children: .contain)
    }

    private var replyButton: some View {
        Button {
            replying = true
            fieldFocused = true
        } label: {
            Text("Reply")
                .font(Typo.label)
                .foregroundStyle(Theme.muted)
                .padding(.horizontal, Space.s)
                .frame(height: 30)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private var replyField: some View {
        HStack(spacing: Space.s) {
            TextField("Message for \(SessionText.name(session))", text: $text)
                .textFieldStyle(.plain)
                .font(Typo.body)
                .focused($fieldFocused)
                .onSubmit(submit)
                .onExitCommand { replying = false; text = "" }
            Button(action: submit) {
                Image(systemName: "arrow.up")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(trimmed.isEmpty ? Theme.muted : Theme.primaryText)
                    .frame(width: 24, height: 24)
                    .background(trimmed.isEmpty ? Theme.surfaceRaised : Theme.primaryFill, in: RoundedRectangle(cornerRadius: Radius.control))
            }
            .buttonStyle(.plain)
            .disabled(trimmed.isEmpty)
            .accessibilityLabel("Send reply")
        }
        .padding(.leading, 12)
        .padding(.trailing, 4)
        .frame(height: 32)
        .background(Theme.bg, in: RoundedRectangle(cornerRadius: Radius.control))
        .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
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

/// Rounded 8, raised, magnifier, placeholder, optional hint chip ("⌘F").
struct SearchField: View {
    @Binding var text: String
    var placeholder = "Search sessions"
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
        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.control))
        .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
    }

    @ViewBuilder private var field: some View {
        if let focus {
            TextField(placeholder, text: $text).textFieldStyle(.plain).font(.system(size: 13)).focused(focus)
        } else {
            TextField(placeholder, text: $text).textFieldStyle(.plain).font(.system(size: 13))
        }
    }
}
