import AppKit
import SqueakIcons
import SqueakMacCore
import SqueakMarkup
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

/// Sizes at standard macOS density (DESIGN.md §4.2). One place, so no surface drifts back to
/// mockup-pixel numbers: the generated mockups were measured in pixels, these are points.
enum Metrics {
    // Type
    static let pageTitle: CGFloat = 22
    static let cardTitle: CGFloat = 15
    static let rowTitle: CGFloat = 13
    static let rowMeta: CGFloat = 11
    static let sectionLabel: CGFloat = 11
    // Icons
    static let icon: CGFloat = 14
    static let iconSmall: CGFloat = 13
    // Control heights
    static let navRow: CGFloat = 36
    static let sidebarField: CGFloat = 32
    static let sidebarInset: CGFloat = 14
    static let sidebarRowGap: CGFloat = 8
    static let sidebarRadius: CGFloat = 10
    static let sidebarText: CGFloat = 14
    static let sidebarIcon: CGFloat = 20
    static let field: CGFloat = 28
    static let button: CGFloat = 26
    static let segmented: CGFloat = 26
    static let pill: CGFloat = 22
    // Main window
    static let sidebarWidth: CGFloat = 220
    // Workbench (§8.10, Tokens.Workbench)
    static let workbenchSidebar = CGFloat(Tokens.Workbench.sidebarWidth)
    static let workbenchInspector = CGFloat(Tokens.Workbench.inspectorWidth)
    static let workbenchColumn = CGFloat(Tokens.Workbench.columnMax)
    static let chatRow = CGFloat(Tokens.Workbench.chatRowHeight)
    static let header: CGFloat = 44
    static let tabStrip: CGFloat = 36
    static let listMinWidth: CGFloat = 320
    static let listIdealWidth: CGFloat = 350
    static let listMaxWidth: CGFloat = 480
}

/// Corner radii (§5): panel 16, card 12, control 8, chip 6.
enum Radius {
    static let panel: CGFloat = 16
    static let card: CGFloat = 12
    static let control: CGFloat = 8
    static let chip: CGFloat = 6
    static let row: CGFloat = 8
}

// MARK: Cards (the iPhone's card language)

/// Surface plus a 1px `line` stroke, radius 12, no shadow. State is told by a `StateDot` and a word, never a fill.
struct Card<Content: View>: View {
    var padding: CGFloat = Space.m
    @ViewBuilder var content: () -> Content

    var body: some View {
        content()
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
            .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Theme.line, lineWidth: 1))
    }
}

/// The card for something that waits on the person (an approval, a question): radius 16, the same surface and stroke.
struct DecisionCard<Content: View>: View {
    var padding: CGFloat = Space.l
    @ViewBuilder var content: () -> Content

    var body: some View {
        content()
            .padding(padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.panel))
            .overlay(RoundedRectangle(cornerRadius: Radius.panel).strokeBorder(Theme.line, lineWidth: 1))
    }
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

// MARK: Row

/// What a session is called, in DESIGN.md §8.2's words: the chat's own title (or `repo · branch` when it has
/// none). State is never written here, only marked (§3.3).
enum SessionText {
    /// `repo · branch` (the daemon's disambiguated title when two rows would read the same).
    static func repoBranch(_ s: HostSession) -> String {
        if let d = s.distinctTitle, !d.isEmpty { return d }
        let parts = [s.repoName, s.branch].compactMap { $0 }.filter { !$0.isEmpty }
        return parts.isEmpty ? s.label : parts.joined(separator: " · ")
    }

    /// §8.2: the headline is the chat's own title. Conductor's "Untitled" placeholder and terminal
    /// sessions (their title is only a folder or a command) fall back to `repo · branch`.
    static func headline(_ s: HostSession) -> String {
        let t = s.title.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.source == .terminal || t.isEmpty || t.lowercased() == "untitled" { return repoBranch(s) }
        return t
    }

    /// `repo · agent`.
    static func secondLine(_ s: HostSession) -> String {
        [s.repoName.flatMap { $0.isEmpty ? nil : $0 }, agent(s.agent)].compactMap { $0 }.joined(separator: " · ")
    }

    /// A row's VoiceOver label (§3.3): the title and the mark's words, or when there is no mark how long ago it was
    /// last active ("last active 12 minutes ago").
    static func accessibility(title: String, mark: ChatMark?, last: Date?, now: Date = Date()) -> String {
        if let mark { return "\(title), \(mark.words)" }
        guard let last else { return title }
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .full
        return "\(title), last active \(f.localizedString(for: last, relativeTo: now))"
    }

    static func agent(_ raw: String?) -> String? {
        guard let raw, !raw.isEmpty else { return nil }
        return raw.lowercased()
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

// MARK: Search

/// Rounded 8, raised, magnifier, placeholder, optional hint chip ("⌘F").
struct SearchField: View {
    @Binding var text: String
    var placeholder = "Search sessions"
    var hint: String?
    var focus: FocusState<Bool>.Binding?

    var body: some View {
        HStack(spacing: 7) {
            Lucide(.search, size: 16, color: Theme.subtle)
            field
            if !text.isEmpty {
                Button { text = "" } label: {
                    Lucide(.circleX, size: 16, color: Theme.subtle)
                }
                .buttonStyle(.plain).accessibilityLabel("Clear search")
            } else if let hint {
                Text(hint).font(.system(size: 11)).foregroundStyle(Theme.subtle)
            }
        }
        .padding(.horizontal, 10)
        .frame(height: 30)
        .background(Theme.surfaceRaised.opacity(0.6), in: RoundedRectangle(cornerRadius: Radius.control))
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

// MARK: Loading

/// The one loading state: quiet placeholder rows in the surface colours with a small spinner and a word, shown
/// the moment a screen opens while its first read is out. Static under Reduce Motion. Used by the chat, the
/// Activity tab and anything else that fills in from a read.
struct LoadingSkeleton: View {
    enum Shape { case messages, steps }
    var shape: Shape = .messages
    var word = "Loading…"
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var dim = false

    var body: some View {
        VStack(alignment: .leading, spacing: shape == .messages ? 22 : 16) {
            HStack(spacing: 6) {
                ProgressView().controlSize(.small).scaleEffect(0.7).frame(width: 14, height: 14)
                Text(word).font(Typo.meta).foregroundStyle(Theme.muted)
            }
            ForEach(0..<3, id: \.self) { i in
                switch shape {
                case .messages: messageRow(i)
                case .steps: stepRow(i)
                }
            }
            Spacer(minLength: 0)
        }
        .frame(maxWidth: 820, alignment: .leading)
        .padding(.horizontal, 16).padding(.top, 14)
        .frame(maxWidth: .infinity, alignment: .center)
        .opacity(reduceMotion ? 1 : (dim ? 0.55 : 1))
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { dim = true }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(word)
    }

    private func bar(_ width: CGFloat?, _ height: CGFloat = 10) -> some View {
        RoundedRectangle(cornerRadius: 4).fill(Theme.surfaceRaised)
            .frame(width: width, height: height).frame(maxWidth: width == nil ? .infinity : nil, alignment: .leading)
    }

    private func messageRow(_ i: Int) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            bar(i == 1 ? 120 : 70, 9)
            bar(nil)
            bar(i == 0 ? 260 : 340)
        }
    }

    private func stepRow(_ i: Int) -> some View {
        HStack(alignment: .top, spacing: 12) {
            RoundedRectangle(cornerRadius: 4).fill(Theme.surfaceRaised).frame(width: 16, height: 16)
            VStack(alignment: .leading, spacing: 6) {
                bar(nil)
                bar(i == 1 ? 180 : 120, 9)
            }
        }
    }
}
