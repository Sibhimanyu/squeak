import AppKit
import SqueakIcons
import SqueakMacCore
import SqueakMarkup
import SwiftUI

// The conversation of the pond room (draft A): groups of bubbles, a duck's reply with its chip and ducklings, the ask
// card, a duck's offer, Squeak's quiet system line and the working lines. Everything is decided in `RoomMessages`.

/// A duck's avatar: its thread duck on a soft tile of its own colour, the agent badge at the corner.
struct DuckAvatar: View {
    let sessionId: String
    var agent: String?
    var size: CGFloat = 36
    var off = false
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let c = ThreadDuck.rgb(for: sessionId, dark: scheme == .dark)
        let colour = Color(red: c.r, green: c.g, blue: c.b)
        RoundedRectangle(cornerRadius: size * 0.3, style: .continuous)
            .fill(Theme.surfaceRaised.opacity(1))
            .overlay(RoundedRectangle(cornerRadius: size * 0.3, style: .continuous).fill(colour.opacity(0.15)))
            .frame(width: size, height: size)
            .overlay { ThreadDuckView(id: sessionId, agent: agent, size: size * 0.72) }
            .opacity(off ? 0.4 : 1).saturation(off ? 0.3 : 1)
            .accessibilityHidden(true)
    }
}

/// A person's avatar: initials on a soft tile.
struct PersonAvatar: View {
    let name: String
    var size: CGFloat = 36
    var body: some View {
        Text(verbatim: RoomPresentation.initials(name)).font(.system(size: size * 0.34, weight: .semibold)).foregroundStyle(Theme.muted)
            .frame(width: size, height: size).background(Theme.selectedStrong, in: RoundedRectangle(cornerRadius: size * 0.3, style: .continuous))
            .accessibilityHidden(true)
    }
}

struct RoomItemView: View {
    let item: RoomItem
    let ducks: [RoomThread]
    let ledger: RoomFadeLedger
    let open: (String) -> Void
    let openTarget: (PondOpenTarget) -> Void
    let answer: (String, String) -> Void
    let retry: (String) -> Void
    let makeJob: (String) -> Void
    let act: (String, RoomTaskAction, String?) -> Void
    let comment: (String, String) -> Void
    @State private var visible = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        content
            .environment(\.roomThreads, ducks)
            .environment(\.roomOpenTarget, openTarget)
            .opacity(visible ? 1 : 0)
            .onAppear {
                guard ledger.shouldFade(item.id), !reduceMotion else { return }
                visible = false
                withAnimation(Motion.standard) { visible = true }
            }
    }

    @ViewBuilder private var content: some View {
        switch item {
        case .day(_, let label):
            Text(verbatim: label).font(.system(size: 11)).foregroundStyle(Theme.subtle).frame(maxWidth: .infinity)
                .padding(.vertical, 2).accessibilityAddTraits(.isHeader)
        case .group(let g): RoomGroupView(group: g, ducks: ducks, open: open, openTarget: openTarget, answer: answer, retry: retry, makeJob: makeJob, act: act)
        case .system(let s): RoomSystemView(line: s, act: act, comment: comment, open: PondClick.target(line: s).map { t in { openTarget(t) } })
        }
    }
}

// MARK: Groups

private struct RoomGroupView: View {
    let group: RoomMessageGroup
    let ducks: [RoomThread]
    let open: (String) -> Void
    let openTarget: (PondOpenTarget) -> Void
    let answer: (String, String) -> Void
    let retry: (String) -> Void
    let makeJob: (String) -> Void
    let act: (String, RoomTaskAction, String?) -> Void

    var body: some View {
        if group.author.kind == .me { mine } else { theirs }
    }

    private var mine: some View {
        HStack(spacing: 0) {
            Spacer(minLength: 60)
            VStack(alignment: .trailing, spacing: RoomBubblePlan.withinGroup) {
                ForEach(Array(group.messages.enumerated()), id: \.element.id) { i, m in
                    VStack(alignment: .trailing, spacing: 2) {
                        ForEach(Array(m.parts.enumerated()), id: \.offset) { _, part in
                            if case .text(let t, _) = part {
                                MessageBubble(message: m, text: t, tone: .normal, mine: true, tail: RoomBubblePlan.hasTail(index: i, count: group.messages.count), retry: retry, makeJob: makeJob, open: opener(PondClick.target(message: m)))
                            }
                        }
                        if !m.attachments.isEmpty { RoomAttachmentsView(attachments: m.attachments, pending: m.pending, alignment: .trailing) }
                        // Under the bubble, small: Sending, then nothing once sent, or Not sent with Retry.
                        if let words = RoomBubblePlan.words(RoomBubblePlan.ownState(pending: m.pending, failed: m.failed)) {
                            HStack(spacing: 6) {
                                Text(verbatim: words).font(.system(size: 11)).foregroundStyle(m.failed ? Theme.negative : Theme.subtle)
                                if m.failed { Button("Retry") { retry(m.id) }.buttonStyle(.plain).font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.negative).pointerHand() }
                            }
                        }
                    }
                }
                Text(verbatim: RoomRipples.clock(group.lastAt)).font(.system(size: 11)).monospacedDigit().foregroundStyle(Theme.subtle).padding(.top, 2)
            }
        }
    }

    private var theirs: some View {
        HStack(alignment: .top, spacing: 11) {
            avatar
            VStack(alignment: .leading, spacing: RoomBubblePlan.withinGroup) {
                header
                ForEach(Array(group.messages.enumerated()), id: \.element.id) { i, m in
                    VStack(alignment: .leading, spacing: RoomBubblePlan.withinGroup) {
                        ForEach(Array(m.parts.enumerated()), id: \.offset) { j, part in
                            partView(m, part, tail: RoomBubblePlan.hasTail(index: i, count: group.messages.count) && j == m.parts.count - 1)
                        }
                        if !m.attachments.isEmpty { RoomAttachmentsView(attachments: m.attachments, pending: m.pending) }
                    }
                }
            }
            Spacer(minLength: 60)
        }
    }

    @State private var hoverDuck = false
    @Environment(\.roomThreads) private var threads
    @Environment(\.colorScheme) private var scheme

    /// The Duck this group's avatar and name open (a person's group opens nothing: no profile page yet).
    private var duckTarget: PondOpenTarget? {
        group.author.kind == .duck ? PondClick.duck(session: group.author.sessionId, name: group.author.name, threads: threads) : nil
    }

    /// What clicking this group's avatar or name opens: a duck, or the duck a person's first message went to.
    private var groupTarget: PondOpenTarget? { PondClick.target(author: group.author, goesTo: group.messages.compactMap(\.goesTo).first) }

    private func opener(_ target: PondOpenTarget?) -> (() -> Void)? { target.map { t in { openTarget(t) } } }

    @ViewBuilder private var avatar: some View {
        let a = group.author
        if let t = duckTarget, let id = a.sessionId {
            DuckHitAvatar(target: t, name: a.name, hovering: hoverDuck, set: { hoverDuck = $0 }, avatar: AnyView(DuckAvatar(sessionId: id, agent: a.agent)))
        } else if let t = groupTarget, a.kind != .duck {
            // A person's avatar does nothing by itself (no hover state); a click there may still open the Duck it went to.
            Button { openTarget(t) } label: { PersonAvatar(name: a.name) }.buttonStyle(.plain).help("Open the duck it went to")
        } else {
            PersonAvatar(name: a.name)
        }
    }

    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            nameText
            if let l = group.author.agentLabel { Text(verbatim: l).font(.system(size: 12)).foregroundStyle(Theme.muted) }
            Text(verbatim: RoomRipples.clock(group.at)).font(.system(size: 11)).monospacedDigit().foregroundStyle(Theme.subtle)
        }
        .padding(.bottom, 2)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder private var nameText: some View {
        let a = group.author
        if a.kind == .duck, let t = duckTarget {
            let c = ThreadDuck.rgb(for: a.sessionId ?? a.key, dark: scheme == .dark)
            DuckHitName(target: t, name: a.name, hovering: hoverDuck, set: { hoverDuck = $0 }) {
                Text(verbatim: a.name).font(.system(size: 13, weight: .semibold)).foregroundStyle(Color(red: c.r, green: c.g, blue: c.b))
            }
        } else {
            Text(verbatim: a.name).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.ink)
        }
    }

    @ViewBuilder private func partView(_ m: RoomMessage, _ part: RoomPart, tail: Bool) -> some View {
        switch part {
        case .text(let t, let tone): MessageBubble(message: m, text: t, tone: tone, mine: false, tail: tail, retry: retry, makeJob: makeJob, open: opener(PondClick.target(part: part, in: m)))
        case .chip(let sid, let text): FilesChip(text: text) { open(sid) }.padding(.top, 5)
        case .ducklings(let d):
            DucklingsDisclosure(ducklings: d, openAll: opener(PondClick.target(part: part, in: m)),
                                openOne: { item in m.author.sessionId.map { id in { openTarget(PondClick.target(duckling: item, of: id)) } } })
        case .ask(let card): AskCardView(card: card, answer: answer, open: open)
        case .offer(let o): OfferView(offer: o, ducks: ducks, act: act)
        }
    }
}


// MARK: Opening a Duck from its avatar or name

extension EnvironmentValues {
    /// The Room's Ducks and the one "open Duck" action (the same the Duck row and the Dashboard use), for any avatar or name.
    @Entry var roomThreads: [RoomThread] = []
    @Entry var roomOpenTarget: (PondOpenTarget) -> Void = { _ in }
}

/// A Duck's avatar and name are one hit target: one pointer-hand click opens its chat; hovering either shows a ring on the
/// avatar and an underline on the name. An off-duty Duck opens too (no duty change). People's avatars use plain views.
struct DuckHitAvatar: View {
    let target: PondOpenTarget
    let name: String
    let hovering: Bool
    let set: (Bool) -> Void
    let avatar: AnyView
    @Environment(\.roomOpenTarget) private var openTarget

    var body: some View {
        Button { openTarget(target) } label: {
            avatar
                .overlay(RoundedRectangle(cornerRadius: 11, style: .continuous).strokeBorder(Theme.lineStrong, lineWidth: 1.5).opacity(hovering ? 1 : 0))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain).pointerHand().onHover(perform: set)
        .help("Open \(name)'s chat").accessibilityLabel("Open \(name)'s chat").accessibilityAddTraits(.isButton)
    }
}

struct DuckHitName<Label: View>: View {
    let target: PondOpenTarget
    let name: String
    let hovering: Bool
    let set: (Bool) -> Void
    @ViewBuilder let label: () -> Label
    @Environment(\.roomOpenTarget) private var openTarget

    var body: some View {
        Button { openTarget(target) } label: { label().underline(hovering, color: Theme.muted).contentShape(Rectangle()) }
            .buttonStyle(.plain).pointerHand().onHover(perform: set)
            .help("Open \(name)'s chat").accessibilityLabel("Open \(name)'s chat").accessibilityAddTraits(.isButton)
    }
}

// MARK: Measured clamping

private struct ClampSizes: Equatable { var natural: CGFloat?; var shown: CGFloat? }
private struct ClampSizesKey: PreferenceKey {
    static let defaultValue = ClampSizes()
    static func reduce(value: inout ClampSizes, nextValue: () -> ClampSizes) {
        let n = nextValue()
        if let v = n.natural { value.natural = v }
        if let v = n.shown { value.shown = v }
    }
}

/// Text clamped to `RoomRowText.lines` with `lineLimit` (a clean "..." cut, never a clipped half line) that says whether it is
/// really cut: a hidden unclamped copy sits in the background and the two heights are compared (`RoomRowText.truncates`).
/// The answer is kept once the text is expanded, so "Show less" stays.
struct RoomClampedText<Content: View>: View {
    let text: Content
    var lines = RoomRowText.lines
    let measure: Bool
    let expanded: Bool
    @Binding var truncated: Bool

    var body: some View {
        text
            .lineLimit(expanded ? nil : lines)
            .fixedSize(horizontal: false, vertical: true)
            .background {
                if measure && !expanded {
                    text.fixedSize(horizontal: false, vertical: true).hidden()
                        .background(GeometryReader { Color.clear.preference(key: ClampSizesKey.self, value: ClampSizes(natural: $0.size.height)) })
                        .accessibilityHidden(true)
                }
            }
            .background(GeometryReader { Color.clear.preference(key: ClampSizesKey.self, value: ClampSizes(shown: $0.size.height)) })
            .onPreferenceChange(ClampSizesKey.self) { sizes in
                guard measure, !expanded, let n = sizes.natural, let s = sizes.shown else { return }
                let t = RoomRowText.truncates(clamped: Double(s), natural: Double(n))
                if t != truncated { truncated = t }
            }
    }
}

/// A markdown body shown as inline-formatted text (no clipped block views) while collapsed.
private func inlineMarkdown(_ s: String) -> AttributedString {
    (try? AttributedString(markdown: s, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(s)
}

/// Hugs its text, at most 68% of the column wide, and sits on the sender's side of the row.
private struct RoomBubbleWidth: Layout {
    let trailing: Bool
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        guard let child = subviews.first else { return .zero }
        let column = proposal.width ?? 740
        let size = child.sizeThatFits(.init(width: CGFloat(RoomBubblePlan.maxWidth(column: Double(column))), height: nil))
        return CGSize(width: proposal.width ?? size.width, height: size.height)
    }
    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        guard let child = subviews.first else { return }
        let size = child.sizeThatFits(.init(width: CGFloat(RoomBubblePlan.maxWidth(column: Double(bounds.width))), height: nil))
        let x = trailing ? bounds.maxX - size.width : bounds.minX
        child.place(at: CGPoint(x: x, y: bounds.minY), anchor: .topLeading, proposal: .init(width: size.width, height: size.height))
    }
}

extension EnvironmentValues {
    /// The pond's directory id, for the colour of my bubbles.
    @Entry var roomPondId: String?
}

/// One bubble (DESIGN.md 8.12). Mine: right, filled with the pond's colour toned down to a dark tint, no avatar. Theirs: left,
/// `surface-raised`. Radius 14, with the small corner on the sender's side for the last bubble of a group; padding 10 by 14,
/// at most 68% of the column; text selectable; long text clamps at ten lines with "Show more" inside the bubble.
private struct MessageBubble: View {
    let message: RoomMessage
    let text: String
    let tone: RoomPart.Tone
    let mine: Bool
    /// The last bubble of its group.
    let tail: Bool
    let retry: (String) -> Void
    let makeJob: (String) -> Void
    /// Opens the tab this bubble belongs to (the duck, or the duck a person's message went to); nil opens nothing.
    var open: (() -> Void)?
    @State private var hover = false
    @Environment(\.roomLatestTaskable) private var latestTaskable
    @Environment(\.roomPondId) private var pondId
    @State private var expanded = false
    @State private var truncated = false
    @State private var copied = false

    var body: some View {
        let taskable = message.canMakeTask && message.postId != nil
        // The bar floats on the bubble's top corner on hover; "Make task" also shows at rest on the newest taskable message.
        let restTask = taskable && MakeTaskAffordance.isShown(postId: message.postId ?? "", latest: latestTaskable, hovering: false)
        VStack(alignment: mine ? .trailing : .leading, spacing: 3) {
            bubble
                .overlay(alignment: mine ? .topLeading : .topTrailing) {
                    if hover || restTask { actionBar(showAll: hover, taskable: taskable) .offset(x: mine ? -6 : 6, y: -12) }
                }
            if !mine, truncated {
                Button { expanded.toggle() } label: {
                    Text(expanded ? "Show less" : "Show more").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.muted)
                        .frame(minHeight: 22).contentShape(Rectangle())
                }
                .buttonStyle(.plain).pointerHand()
            }
            if hover { Text(verbatim: RoomRipples.clock(message.at)).font(.system(size: 11)).monospacedDigit().foregroundStyle(Theme.subtle) }
        }
        .onHover { hover = $0 }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(mine ? "You" : message.author.name): \(text)")
        .accessibilityActions {
            if taskable, let id = message.postId { Button("Make task") { makeJob(id) } }
        }
    }

    private var bubble: some View {
        RoomBubbleWidth(trailing: mine) { bubbleBody }
    }

    private var bubbleBody: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            switch tone {
            case .attention: Lucide(.triangleAlert, size: 14, color: Theme.warning).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 3 }
            case .failed: Lucide(.circleX, size: 14, color: Theme.negative).alignmentGuide(.firstTextBaseline) { $0[.bottom] - 3 }
            case .normal: EmptyView()
            }
            // Markdown rendered; while collapsed, inline-formatted text cut cleanly by `lineLimit` (never a clipped half line).
            Group {
                if expanded || !RoomRowText.needsMeasure(text) {
                    MessageText(markdown: text, style: .reading)
                } else {
                    RoomClampedText(
                        text: Text(inlineMarkdown(text)).font(.system(size: 14)).lineSpacing(3).foregroundStyle(Theme.ink),
                        lines: RoomBubblePlan.clampLines, measure: true, expanded: false, truncated: $truncated)
                }
            }
            .textSelection(.enabled)
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .background(fill, in: shape)
        .opacity(message.pending ? 0.6 : 1)
        .onTapGesture { open?() }
        .pointerHand(open != nil)
        .contextMenu {
            if message.canMakeTask, let id = message.postId { Button("Make task") { makeJob(id) } }
            Button("Copy") { copy() }
        }
    }

    private var fill: Color {
        if mine { return PondColour.tint(pondId).opacity(0.30) }
        return Theme.surfaceRaised
    }

    private func copy() {
        NSPasteboard.general.clearContents(); NSPasteboard.general.setString(text, forType: .string)
        copied = true
        Task { try? await Task.sleep(for: .seconds(1.2)); copied = false }
    }

    /// Make task, Copy and Reply in one small bar (the D4 hover footer's pattern). Reply is "Make task" for a Duck message
    /// the person can hand on; there is no threaded reply in the host, so Reply is not drawn.
    private func actionBar(showAll: Bool, taskable: Bool) -> some View {
        HStack(spacing: 2) {
            if taskable, let id = message.postId {
                barButton("Make task", symbol: "checkmark.circle") { makeJob(id) }.help("Hand this message to a duck as a task")
            }
            if showAll { barButton(copied ? "Copied" : "Copy", symbol: copied ? "checkmark" : "doc.on.doc") { copy() } }
        }
        .padding(2)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.line))
        .transition(.opacity)
    }

    private func barButton(_ title: String, symbol: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 4) {
                Image(systemName: symbol).font(.system(size: 11))
                Text(verbatim: title).font(.system(size: 11, weight: .medium))
            }
            .foregroundStyle(Theme.muted).padding(.horizontal, 7).frame(height: 22).contentShape(Rectangle())
        }
        .buttonStyle(.plain).pointerHand().accessibilityHidden(true)
    }

    private var shape: UnevenRoundedRectangle {
        let r = RoomBubblePlan.radius, small = RoomBubblePlan.smallRadius
        let corner = tail ? small : r
        return UnevenRoundedRectangle(
            topLeadingRadius: r, bottomLeadingRadius: mine ? r : corner,
            bottomTrailingRadius: mine ? corner : r, topTrailingRadius: r, style: .continuous)
    }
}

/// "7 files . 4m 20s >": opens the duck's tab.
private struct FilesChip: View {
    let text: String
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                ForEach(Array(text.components(separatedBy: " \u{00B7} ").enumerated()), id: \.offset) { i, part in
                    if i > 0 { Text(verbatim: "\u{00B7}").opacity(0.5) }
                    Image(systemName: part.contains("file") ? "doc" : "clock").font(.system(size: 11))
                    Text(verbatim: part).monospacedDigit()
                }
                Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.subtle).padding(.leading, 2)
            }
            .font(.system(size: 12)).foregroundStyle(Theme.muted).padding(.leading, 8).padding(.trailing, 9).frame(height: 22)
            .background(hover ? Theme.selectedStrong : Theme.selected, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(Theme.line))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).onHover { hover = $0 }
        .help("Open the duck").accessibilityLabel("\(text). Opens the duck")
    }
}

/// "> handed 2 pieces to ducklings": expands to the pieces with their state.
private struct DucklingsDisclosure: View {
    let ducklings: RoomDucklings
    /// Opens the duck and its duckling tabs; each piece opens its own.
    var openAll: (() -> Void)?
    var openOne: (RoomDuckling) -> (() -> Void)? = { _ in nil }
    @State private var open = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 5) {
                Button { open.toggle() } label: {
                    Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)).rotationEffect(.degrees(open ? 90 : 0))
                        .frame(width: 16, height: 16).contentShape(Rectangle())
                }
                .buttonStyle(.plain).accessibilityLabel(open ? "Hide the pieces" : "Show the pieces")
                .accessibilityValue(open ? "Expanded" : "Collapsed")
                Button { openAll?() ?? open.toggle() } label: {
                    Text(verbatim: RoomMessages.ducklingsLine(ducklings)).font(.system(size: 12)).contentShape(Rectangle())
                }
                .buttonStyle(.plain).pointerHand().help("Open the ducklings")
            }
            .foregroundStyle(Theme.subtle)
            if open {
                VStack(alignment: .leading, spacing: 3) {
                    if ducklings.items.isEmpty {
                        Text("\(ducklings.done) of \(ducklings.count) done").font(.system(size: 12)).foregroundStyle(Theme.muted)
                    }
                    ForEach(ducklings.items) { d in
                        Button { openOne(d)?() } label: { HStack(spacing: 6) {
                            switch d.state {
                            case .running: WorkingGlyph(slot: TideGlyph.Grid.micro.size.width, alignment: .leading, grid: .micro)
                            case .done: Image(systemName: "checkmark").font(.system(size: 10, weight: .semibold)).foregroundStyle(Theme.done)
                            case .failed: Lucide(.circleX, size: 12, color: Theme.negative)
                            }
                            Text(verbatim: d.label).font(.system(size: 12)).foregroundStyle(Theme.muted).lineLimit(1)
                        }.contentShape(Rectangle()) }
                        .buttonStyle(.plain).pointerHand(openOne(d) != nil).disabled(openOne(d) == nil)
                    }
                }
                .padding(.leading, 14)
            }
        }
        .padding(.top, 6)
    }
}

// MARK: Ask, offer, system

/// The duck's question: warning edge, lettered options, a field for the person's own words.
private struct AskCardView: View {
    let card: RoomAskCard
    let answer: (String, String) -> Void
    let open: (String) -> Void
    @State private var text = ""
    @State private var sent = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(verbatim: card.question).font(.system(size: 14, weight: .semibold)).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true)
            if !card.options.isEmpty {
                VStack(spacing: 6) { ForEach(card.options) { o in OptionRow(option: o, disabled: sent) { send(o.letter) } } }.padding(.top, 10)
            }
            HStack(spacing: 8) {
                TextField("Or tell \(card.name) something else\u{2026}", text: $text).textFieldStyle(.plain).font(.system(size: 14))
                    .onSubmit(sendText).disabled(sent).accessibilityLabel("Your own answer")
                if !text.trimmingCharacters(in: .whitespaces).isEmpty {
                    Button(action: sendText) { Image(systemName: "return").font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.muted).frame(width: 26, height: 22) }
                        .buttonStyle(.plain).accessibilityLabel("Send answer")
                }
            }
            .padding(.horizontal, 11).frame(height: 30)
            .background(Theme.bg, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(Theme.lineStrong))
            .padding(.top, 8)
        }
        .padding(.horizontal, 16).padding(.vertical, 12)
        .frame(maxWidth: 640, alignment: .leading)
        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(alignment: .leading) { Rectangle().fill(Theme.warning).frame(width: 3) }
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .opacity(sent ? 0.6 : 1)
        .accessibilityElement(children: .contain).accessibilityLabel("\(card.name) asks. \(card.question)")
    }

    private func send(_ s: String) { guard !sent else { return }; sent = true; answer(card.sessionId, s) }
    private func sendText() {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if !clean.isEmpty { send(clean) }
    }
}

private struct OptionRow: View {
    let option: RoomAskOption
    let disabled: Bool
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 11) {
                Text(verbatim: option.letter).font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.muted)
                    .frame(width: 20, height: 20).background(Theme.selectedStrong, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                Text(verbatim: option.text).font(.system(size: 14)).foregroundStyle(Theme.ink).lineLimit(2).multilineTextAlignment(.leading)
                Spacer(minLength: 8)
                if option.recommended { Text("recommended").font(.system(size: 11)).foregroundStyle(Theme.subtle) }
            }
            .padding(.horizontal, 11).padding(.vertical, 6).frame(maxWidth: .infinity)
            .background(hover && !disabled ? Theme.selected : Color.white.opacity(0.02), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 8, style: .continuous).strokeBorder(option.recommended ? Theme.lineStrong : Theme.line))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(disabled).onHover { hover = $0 }
        .accessibilityLabel("\(option.letter). \(option.text)" + (option.recommended ? ", recommended" : ""))
    }
}

/// A duck offering to take a job, or asking to take it after its turn: words, then [Go] [Not now] / [Allow] [No].
private struct OfferView: View {
    let offer: RoomOffer
    let ducks: [RoomThread]
    let act: (String, RoomTaskAction, String?) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 14) {
                Text(verbatim: offer.text).font(.system(size: 14)).lineSpacing(3).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true)
                Spacer(minLength: 0)
                if let n = offer.note { Text(verbatim: n).font(.system(size: 12)).foregroundStyle(Theme.muted) }
                HStack(spacing: 6) {
                    ForEach(offer.buttons) { b in
                        if b.id == "go" {
                            HStack(spacing: 0) {
                                Button(b.title) { act(offer.jobId, b.action, nil) }.buttonStyle(SmallButtonStyle(role: .primary))
                                if !offer.candidates.isEmpty { candidates }
                            }
                        } else {
                            Button(b.title) { act(offer.jobId, b.action, nil) }.buttonStyle(SmallButtonStyle(role: b.role))
                        }
                    }
                }
            }
            if let c = offer.place, offer.note == nil { RoomPlaceChipView(jobId: offer.jobId, chip: c) }
            if let e = offer.error { Text(verbatim: e).font(.system(size: 12)).foregroundStyle(Theme.negative).fixedSize(horizontal: false, vertical: true) }
        }
        .padding(.leading, 14).padding(.trailing, 12).padding(.vertical, 10)
        .frame(maxWidth: 560, alignment: .leading)
        .background(Color.white.opacity(0.03), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Theme.line))
        .accessibilityElement(children: .contain).accessibilityLabel(offer.text)
    }

    /// Pick another duck for the job instead of the suggested one.
    private var candidates: some View {
        Menu {
            ForEach(offer.candidates, id: \.sessionId) { c in
                let name = ducks.first { $0.sessionId == c.sessionId }?.duckName ?? c.title
                Button(name) { act(offer.jobId, .go(sessionId: c.sessionId), name) }
            }
        } label: {
            Image(systemName: "chevron.down").font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.muted).frame(width: 18, height: 24)
        }
        .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().accessibilityLabel("Pick another duck")
    }
}

/// Squeak never speaks as a person: a quiet centred line with its buttons.
private struct RoomSystemView: View {
    let line: RoomSystemLine
    let act: (String, RoomTaskAction, String?) -> Void
    let comment: (String, String) -> Void
    /// A handoff line opens the duck it went to.
    var open: (() -> Void)?

    @State private var showEarlier = false

    var body: some View {
        if line.earlier.isEmpty { single }
        else {
            // A folded run: one row above the latest line ("Show 4 earlier from Ruby 2"), lined up with the names, that opens
            // the run's older lines right under it. The row never moves and nothing already drawn is replaced (ids are the lines' own).
            VStack(alignment: .leading, spacing: 8) {
                // One compact centred line for the run ("Ruby 2 \u{00B7} 4 updates"); it opens in place, below, pushing nothing up.
                let foldLabel = RoomMoment.foldLabel(name: RoomFold.owner(of: line) ?? "Duck", updates: line.earlier.count + 1)
                Button { showEarlier.toggle() } label: {
                    HStack(spacing: 4) {
                        Text(verbatim: foldLabel).font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.muted)
                        Image(systemName: "chevron.right").font(.system(size: 8, weight: .semibold)).foregroundStyle(Theme.subtle)
                            .rotationEffect(.degrees(showEarlier ? 90 : 0))
                    }
                    .frame(maxWidth: .infinity, minHeight: 24).contentShape(Rectangle())
                }
                .buttonStyle(.plain).pointerHand()
                .accessibilityLabel(foldLabel + (showEarlier ? ", open" : ", closed"))
                if showEarlier {
                    ForEach(line.earlier) { e in RoomSystemView(line: e, act: act, comment: comment, open: open) }
                }
                single
            }
        }
    }

    @ViewBuilder private var single: some View {
        if let h = line.handoff { RoomHandoffCard(note: h, at: line.at, open: open) }
        else if let st = line.status { RoomStatusLineView(status: st, at: line.at, comment: comment, open: open) }
        else if let t = line.task { RoomTaskCardView(card: t, act: act, open: open) }
        else { quiet }
    }

    private var quiet: some View {
        VStack(spacing: 4) {
            HStack(spacing: 8) {
                Text(verbatim: line.text).font(.system(size: 12)).foregroundStyle(Theme.subtle)
                    .onTapGesture { open?() }.pointerHand(open != nil)
                if let n = line.note { Text(verbatim: n).font(.system(size: 12)).foregroundStyle(Theme.muted) }
                if let id = line.jobId, let c = line.place, line.note == nil { RoomPlaceChipView(jobId: id, chip: c) }
                if let id = line.jobId {
                    ForEach(line.buttons) { b in Button(b.title) { act(id, b.action, nil) }.buttonStyle(SmallButtonStyle(role: b.role)) }
                }
            }
            if let e = line.error { Text(verbatim: e).font(.system(size: 12)).foregroundStyle(Theme.negative) }
        }
        .frame(maxWidth: .infinity).padding(.vertical, 2)
        .accessibilityElement(children: .combine)
    }
}

/// The one row every Duck-side line of the Room uses (a Duck's note to another Duck, a state moment): avatar column, then a
/// name row (name, what it did, time) and the text. Text shows up to three lines, then "Show more" inline; there is no
/// bordered bubble and no chevron. Whether it is truncated is measured from the real layout (`RoomClampedText`), so a row never changes
/// height after it is drawn.
struct RoomEventRow<Extra: View>: View {
    let avatar: AnyView
    let name: String
    /// A handoff's receiver ("Quill 2 \u{2192} Dot 2").
    var to: String?
    /// What the Duck did, quietly after the name ("finished").
    var verb: String?
    var verbColour: Color = Theme.muted
    let at: Int64
    let text: String
    var markdown = false
    var open: (() -> Void)?
    /// The Ducks the avatar and name (and the "\u{2192} receiver") open.
    var senderTarget: PondOpenTarget?
    var receiverTarget: PondOpenTarget?
    /// A faint left accent in the sender's colour (a Duck-to-Duck note).
    var accent: String?
    @ViewBuilder var extra: () -> Extra
    @State private var hoverSender = false
    @State private var hoverReceiver = false
    @Environment(\.colorScheme) private var scheme
    @State private var expanded = false
    @State private var truncated = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var style: MessageStyle {
        var s = MessageStyle.reading
        s.collapseLines = .max
        return s
    }

    var body: some View {
        let measure = RoomRowText.needsMeasure(text)
        HStack(alignment: .top, spacing: RoomRowMetrics.gap) {
            if let senderTarget {
                DuckHitAvatar(target: senderTarget, name: name, hovering: hoverSender, set: { hoverSender = $0 }, avatar: avatar)
            } else { avatar }
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    headlineView
                    Text(verbatim: RoomRipples.clock(at)).font(.system(size: 11)).monospacedDigit().foregroundStyle(Theme.subtle)
                }
                .accessibilityElement(children: .combine)
                if !text.isEmpty {
                    Group {
                        if markdown && expanded {
                            MessageText(markdown: text, style: style)
                        } else if markdown && !measure {
                            MessageText(markdown: text, style: style)
                        } else {
                            // Collapsed text is `lineLimit` text (inline formatting for markdown): never a clipped half line.
                            RoomClampedText(
                                text: markdown ? Text(inlineMarkdown(text)).font(.system(size: 14)).lineSpacing(3).foregroundStyle(Theme.ink)
                                    : Text(verbatim: text).font(.system(size: 14)).lineSpacing(3).foregroundStyle(Theme.ink),
                                measure: measure, expanded: expanded, truncated: $truncated)
                                .textSelection(.enabled)
                        }
                    }
                    .frame(maxWidth: 640, alignment: .leading)
                    if truncated {
                        Button { withAnimation(reduceMotion ? nil : Motion.standard) { expanded.toggle() } } label: {
                            Text(expanded ? "Show less" : "Show more").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.muted)
                                .frame(minHeight: 22).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain).pointerHand().accessibilityLabel(expanded ? "Show less" : "Show more")
                    }
                }
                extra()
            }
            Spacer(minLength: 60)
        }
        .padding(.leading, accent == nil ? 0 : 10)
        .overlay(alignment: .leading) {
            if let accent {
                let c = ThreadDuck.rgb(for: accent, dark: scheme == .dark)
                Capsule().fill(Color(red: c.r, green: c.g, blue: c.b).opacity(0.45)).frame(width: 2)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
    }

    /// "Sage 2 \u{2192} Dot 2": the sender and the receiver each open their own Duck; a status line's name opens its Duck.
    @ViewBuilder private var headlineView: some View {
        if let senderTarget {
            HStack(spacing: 0) {
                DuckHitName(target: senderTarget, name: name, hovering: hoverSender, set: { hoverSender = $0 }) {
                    Text(verbatim: name).fontWeight(.semibold).foregroundStyle(Theme.ink)
                }
                if let to {
                    Text(verbatim: " \u{2192} ").foregroundStyle(Theme.muted)
                    if let receiverTarget {
                        DuckHitName(target: receiverTarget, name: to, hovering: hoverReceiver, set: { hoverReceiver = $0 }) {
                            Text(verbatim: to).fontWeight(.semibold).foregroundStyle(Theme.ink)
                        }
                    } else { Text(verbatim: to).fontWeight(.semibold).foregroundStyle(Theme.ink) }
                }
                if let verb { Text(verbatim: " \(verb)").foregroundStyle(verbColour) }
            }
            .font(.system(size: 13)).lineLimit(1)
        } else {
            headline.font(.system(size: 13)).lineLimit(1).onTapGesture { open?() }.pointerHand(open != nil)
        }
    }

    private var headline: Text {
        var t = Text(verbatim: name).fontWeight(.semibold).foregroundStyle(Theme.ink)
        if let to { t = t + Text(verbatim: " \u{2192} ").foregroundStyle(Theme.muted) + Text(verbatim: to).fontWeight(.semibold).foregroundStyle(Theme.ink) }
        if let verb { t = t + Text(verbatim: " \(verb)").foregroundStyle(verbColour) }
        return t
    }
}

enum RoomRowMetrics {
    static let avatar: CGFloat = 36
    static let gap: CGFloat = 11
    /// Where a row's text starts: under this a fold row lines up with the names above it.
    static var textInset: CGFloat { avatar + gap }
}

extension RoomEventRow where Extra == EmptyView {
    init(avatar: AnyView, name: String, to: String? = nil, verb: String? = nil, verbColour: Color = Theme.muted, at: Int64, text: String, markdown: Bool = false, open: (() -> Void)? = nil,
         senderTarget: PondOpenTarget? = nil, receiverTarget: PondOpenTarget? = nil, accent: String? = nil) {
        self.init(avatar: avatar, name: name, to: to, verb: verb, verbColour: verbColour, at: at, text: text, markdown: markdown, open: open,
                  senderTarget: senderTarget, receiverTarget: receiverTarget, accent: accent, extra: { EmptyView() })
    }
}

/// A duck's note to another duck.
private struct RoomHandoffCard: View {
    let note: RoomHandoff
    let at: Int64
    var open: (() -> Void)?
    @Environment(\.roomThreads) private var threads

    var body: some View {
        RoomEventRow(
            avatar: AnyView(Group { if let id = note.fromSessionId { DuckAvatar(sessionId: id, agent: note.agent) } else { PersonAvatar(name: note.from) } }),
            name: note.from, to: note.to ?? "another duck", at: at, text: note.body, markdown: true, open: open,
            senderTarget: PondClick.sender(of: note, threads: threads), receiverTarget: PondClick.receiver(of: note, threads: threads),
            accent: note.fromSessionId)
    }
}

extension EnvironmentValues {
    /// The Room is a Member's (a view-only copy of the Owner's).
    @Entry var roomMemberView = false
    /// Opens a canvas card from the Room: the canvas for the Owner, its view-only bundle for a Member.
    @Entry var roomOpenCanvas: (RoomCanvasCard) -> Void = { _ in }
}

/// A canvas the Task made, under the done line: title, kind and artboard count; a tap opens it.
private struct RoomCanvasCardView: View {
    let card: RoomCanvasCard
    let memberView: Bool
    @Environment(\.roomOpenCanvas) private var openCanvas
    @State private var hovering = false

    var body: some View {
        Button { openCanvas(card) } label: {
            HStack(spacing: 10) {
                Lucide(.layers, size: 16, color: Theme.muted).frame(width: 20)
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: card.title).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                    Text(verbatim: card.subtitle + (memberView ? " \u{00B7} View only" : "")).font(.system(size: 11)).foregroundStyle(Theme.subtle).lineLimit(1)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right").font(.system(size: 9, weight: .semibold)).foregroundStyle(Theme.muted)
            }
            .padding(.horizontal, 12).padding(.vertical, 8).frame(maxWidth: 360, alignment: .leading)
            .background(hovering ? Theme.selected : Theme.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Theme.line))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).pointerHand().onHover { hovering = $0 }
        .accessibilityLabel("Open canvas \(card.title)\(memberView ? ", view only" : "")")
    }
}

/// A duck's state change ("Pip finished"): the same row as a note; a plan card opens its spec inline.
private struct RoomStatusLineView: View {
    let status: RoomStatusLine
    let at: Int64
    let comment: (String, String) -> Void
    var open: (() -> Void)?
    @State private var disclosure = RoomDisclosure()
    @State private var draft = ""
    @State private var sent = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.roomMemberView) private var memberView

    @Environment(\.roomThreads) private var threads
    @Environment(\.roomOpenTarget) private var openTarget
    @State private var hover = false

    var body: some View {
        if status.kind == .plan { planCard } else { moment }
    }

    /// A moment is not chat: one compact centred line, a small duck glyph then "Ruby 2 finished \u{00B7} summary" in muted 12pt.
    /// A tap opens that Duck (an off-duty one too). A canvas or a longer detail sits quietly under it.
    private var moment: some View {
        let target = PondClick.target(status: status, threads: threads)
        let text = RoomMoment.line(name: status.name, verb: status.verb, summary: status.summary)
        return VStack(spacing: 4) {
            Button { if let target { openTarget(target) } } label: {
                HStack(spacing: 6) {
                    if let id = status.sessionId { ThreadDuckView(id: id, agent: status.agent, size: 14) }
                    Text(verbatim: text).font(.system(size: 12)).foregroundStyle(status.kind == .blocked ? Theme.negative : Theme.muted)
                        .lineLimit(1).truncationMode(.tail).underline(hover && target != nil, color: Theme.muted)
                }
                .frame(maxWidth: .infinity, minHeight: 24).contentShape(Rectangle())
            }
            .buttonStyle(.plain).pointerHand(target != nil).onHover { hover = $0 }
            .help(target != nil ? "Open \(status.name)'s chat" : "").accessibilityLabel(text + (target != nil ? ". Opens \(status.name)'s chat" : ""))
            ForEach(status.canvases) { RoomCanvasCardView(card: $0, memberView: memberView) }
            if status.isExpandable {
                Button { withAnimation(reduceMotion ? nil : Motion.standard) { disclosure.toggle() } } label: {
                    Text(disclosure.isOpen ? "Hide detail" : "Show detail").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.muted)
                        .frame(minHeight: 22).contentShape(Rectangle())
                }
                .buttonStyle(.plain).pointerHand()
            }
            if disclosure.isOpen, let d = status.detail {
                MessageText(markdown: d, style: .reading).frame(maxWidth: 640, alignment: .leading)
            }
        }
        .frame(maxWidth: .infinity)
    }

    private var planCard: some View {
        RoomEventRow(
            avatar: AnyView(Group { if let id = status.sessionId { DuckAvatar(sessionId: id, agent: status.agent) } else { Color.clear.frame(width: RoomRowMetrics.avatar, height: RoomRowMetrics.avatar) } }),
            name: status.name, verb: status.verb, verbColour: Theme.muted,
            at: at, text: status.summary, open: open, senderTarget: PondClick.target(status: status, threads: threads)
        ) {
            ForEach(status.canvases) { RoomCanvasCardView(card: $0, memberView: memberView) }
            if status.isExpandable {
                Button { withAnimation(reduceMotion ? nil : Motion.standard) { disclosure.toggle() } } label: {
                    Text(disclosure.isOpen ? "Hide detail" : "Show detail").font(.system(size: 12, weight: .medium)).foregroundStyle(Theme.muted)
                        .frame(minHeight: 22).contentShape(Rectangle())
                }
                .buttonStyle(.plain).pointerHand()
            }
            if disclosure.isOpen, let d = status.detail {
                MessageText(markdown: d, style: .reading).frame(maxWidth: 640, alignment: .leading)
                if let card = status.commentTarget { commentBox(card) }
            }
        }
        .padding(.vertical, 2)
    }
}

extension RoomStatusLineView {
    /// Steer the duck before it goes far: the host hands the comment to it at its next turn.
    fileprivate func commentBox(_ card: String) -> some View {
        HStack(spacing: 8) {
            TextField("Comment on this plan", text: $draft).textFieldStyle(.plain).font(.system(size: 13))
                .padding(.horizontal, 10).frame(height: 30)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: 10, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous).strokeBorder(Theme.line))
                .onSubmit { submit(card) }
            Button(sent ? "Sent" : "Comment") { submit(card) }
                .buttonStyle(SmallButtonStyle(role: .secondary))
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
        .frame(maxWidth: 640, alignment: .leading)
    }

    fileprivate func submit(_ card: String) {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return }
        comment(card, text); draft = ""; sent = true
    }
}

// MARK: Working

/// "Pip is working . updating the layout builder . 3 of 5": no bubble.
struct RoomWorkingRow: View {
    let line: RoomWorkingLine
    let open: (String) -> Void

    var body: some View {
        HStack(spacing: 11) {
            Button { open(line.sessionId) } label: { DuckAvatar(sessionId: line.sessionId, agent: line.agent) }.buttonStyle(.plain).pointerHand().help("Open \(line.name)'s chat").accessibilityLabel("Open \(line.name)'s chat")
            WorkingGlyph(slot: TideGlyph.Grid.mark.size.width, alignment: .leading, grid: .mark)
            (Text(verbatim: line.name).fontWeight(.semibold).foregroundStyle(Theme.ink)
                + Text(verbatim: " is working" + (line.detail.map { " \u{00B7} " + $0 } ?? "")).foregroundStyle(Theme.muted))
                .font(.system(size: 13)).lineLimit(1)
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .ignore).accessibilityLabel(line.spoken)
    }
}

private struct RoomLatestTaskableKey: EnvironmentKey { static let defaultValue: String? = nil }

extension EnvironmentValues {
    /// The post id of the newest message that can be made a Task: its "Make task" shows at rest (`MakeTaskAffordance`).
    var roomLatestTaskable: String? {
        get { self[RoomLatestTaskableKey.self] }
        set { self[RoomLatestTaskableKey.self] = newValue }
    }
}
