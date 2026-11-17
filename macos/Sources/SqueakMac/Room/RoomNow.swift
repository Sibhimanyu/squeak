import SqueakIcons
import SqueakMacCore
import SwiftUI

// "Now": one card per working, needs-you or finished-unread thread. A question leads at full width; the rest sit in a
// responsive grid, newest turn first (RoomNow.cards), never re-ordered by state.

struct RoomNowSection: View {
    let cards: [RoomNowCard]
    var claims: [RoomJobs.ClaimCard] = []
    var key: String?
    let open: (String) -> Void
    let answer: (String, String) -> Void
    var decide: (RoomJobs.ClaimCard, Bool) -> Void = { _, _ in }
    @State private var contentHeight: CGFloat = 0
    @Environment(AppModel.self) private var model

    var body: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            HStack {
                Text("Now").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.muted).accessibilityAddTraits(.isHeader)
                if cards.isEmpty && claims.isEmpty {
                    // Quiet: one compact line in the header row, not a card.
                    Text("\u{00B7} Nothing running").font(.system(size: 13)).foregroundStyle(Theme.subtle)
                }
                Spacer()
                if cards.isEmpty && claims.isEmpty {
                    Button("New thread") { if let key { PondHomeView.startThread(key: key, model: model) } else { NewChatController.shared.show() } }
                        .buttonStyle(SecondaryButtonStyle())
                }
                if !cards.isEmpty { Text(cards.count == 1 ? "1 thread" : "\(cards.count) threads").font(.system(size: 12)).foregroundStyle(Theme.subtle) }
            }
            if cards.isEmpty && claims.isEmpty {
                EmptyView()
            } else {
                // Taller than a third of the window scrolls inside itself, so the feed and composer always keep their room.
                ScrollView(.vertical, showsIndicators: false) {
                    VStack(spacing: Space.m) {
                        ForEach(claims) { c in RoomClaimCard(claim: c, decide: decide) }
                        ForEach(cards.filter(\.fullWidth)) { c in NeedsYouCard(card: c, open: open, answer: answer) }
                        let rest = cards.filter { !$0.fullWidth }
                        if !rest.isEmpty {
                            RoomCardGrid(minWidth: 220, spacing: Space.m) {
                                ForEach(rest) { c in ThreadCard(card: c, open: open) }
                            }
                        }
                    }
                    .background(GeometryReader { g in Color.clear.onAppear { contentHeight = g.size.height }.onChange(of: g.size.height) { _, h in contentHeight = h } })
                }
                .frame(height: min(max(contentHeight, 40), 380))
                .scrollBounceBehavior(.basedOnSize)
            }
        }
        .padding(.top, Space.s)
    }
}

/// Columns of equal width and rows of equal height: as many as fit `minWidth`, never more than there are cards, so two
/// cards fill the row instead of leaving a gap.
struct RoomCardGrid: Layout {
    var minWidth: CGFloat
    var spacing: CGFloat

    private func columns(_ width: CGFloat, count: Int) -> Int {
        guard width.isFinite, count > 0 else { return max(1, count) }
        return max(1, min(count, Int((width + spacing) / (minWidth + spacing))))
    }

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? minWidth
        let cols = columns(width, count: subviews.count)
        let cell = (width - spacing * CGFloat(cols - 1)) / CGFloat(cols)
        var total: CGFloat = 0
        var i = 0
        while i < subviews.count {
            let row = subviews[i..<min(i + cols, subviews.count)]
            total += row.map { $0.sizeThatFits(ProposedViewSize(width: cell, height: nil)).height }.max() ?? 0
            i += cols
            if i < subviews.count { total += spacing }
        }
        return CGSize(width: width, height: total)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let cols = columns(bounds.width, count: subviews.count)
        let cell = (bounds.width - spacing * CGFloat(cols - 1)) / CGFloat(cols)
        var y = bounds.minY
        var i = 0
        while i < subviews.count {
            let row = Array(subviews[i..<min(i + cols, subviews.count)])
            let h = row.map { $0.sizeThatFits(ProposedViewSize(width: cell, height: nil)).height }.max() ?? 0
            for (n, v) in row.enumerated() {
                v.place(at: CGPoint(x: bounds.minX + CGFloat(n) * (cell + spacing), y: y), anchor: .topLeading, proposal: ProposedViewSize(width: cell, height: h))
            }
            y += h + spacing
            i += cols
        }
    }
}

/// A working or finished-unread thread: duck, title (semibold when unread), mark, the agent's words, progress, time.
private struct ThreadCard: View {
    let card: RoomNowCard
    let open: (String) -> Void
    @State private var hover = false

    var body: some View {
        let t = card.thread
        Button { open(t.sessionId) } label: {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 8) {
                    ThreadDuckView(id: t.sessionId, agent: t.agent, size: 22)
                    Text(verbatim: t.title).font(.system(size: 13, weight: card.kind == .unread ? .semibold : .medium)).foregroundStyle(Theme.ink).lineLimit(1)
                    Spacer(minLength: 4)
                    mark
                }
                Text(verbatim: RoomNow.intent(card)).font(.system(size: 13)).foregroundStyle(Theme.ink.opacity(0.78)).lineLimit(2)
                    .multilineTextAlignment(.leading).frame(maxWidth: .infinity, alignment: .leading)
                Spacer(minLength: 0)
                if let p = t.progress, card.kind == .working { ProgressLine(progress: p) }
                if !card.meta.isEmpty { Text(verbatim: card.meta).font(.system(size: 11)).foregroundStyle(Theme.subtle) }
            }
            .padding(14).frame(maxWidth: .infinity, minHeight: 124, alignment: .topLeading)
            .background(hover ? Theme.surfaceRaised : Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(Theme.line))
            .contentShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        }
        .buttonStyle(.plain)
        .onHover { hover = $0 }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(t.title), \(card.kind == .working ? "working" : card.kind == .unread ? "finished, unread" : "needs you"). \(RoomNow.intent(card))")
        .accessibilityHint("Opens the thread")
    }

    @ViewBuilder private var mark: some View {
        switch card.kind {
        case .working: WorkingGlyph(slot: 28, alignment: .trailing, grid: .compact)
        case .needsYou: StatusMark(kind: .waiting(count: nil), color: Theme.warning, size: 16)
        case .unread: Circle().fill(Theme.done).frame(width: 7, height: 7).padding(.trailing, 4)
        }
    }
}

private struct ProgressLine: View {
    let progress: RoomProgress
    var body: some View {
        HStack(spacing: 10) {
            GeometryReader { g in
                ZStack(alignment: .leading) {
                    Capsule().fill(Theme.selected)
                    Capsule().fill(Theme.working).frame(width: g.size.width * progress.fraction)
                }
            }
            .frame(height: 3)
            Text("\(progress.current) of \(progress.total)").font(.system(size: 12)).monospacedDigit().foregroundStyle(Theme.muted)
        }
        .accessibilityElement(children: .ignore).accessibilityLabel("Step \(progress.current) of \(progress.total)")
    }
}

/// The question a thread waits on: 3 pt warning edge, lettered options as buttons, a field for the person's own words.
private struct NeedsYouCard: View {
    let card: RoomNowCard
    let open: (String) -> Void
    let answer: (String, String) -> Void
    @State private var text = ""
    @State private var sent = false

    var body: some View {
        let t = card.thread
        let ask = t.ask
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 8) {
                ThreadDuckView(id: t.sessionId, agent: t.agent, size: 22)
                Button { open(t.sessionId) } label: {
                    Text(verbatim: t.title).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.ink).lineLimit(1)
                }
                .buttonStyle(.plain).help("Open \(t.title)")
                Spacer(minLength: 4)
                if !card.meta.isEmpty { Text(verbatim: card.meta).font(.system(size: 12)).foregroundStyle(Theme.muted) }
                StatusMark(kind: .waiting(count: nil), color: Theme.warning, size: 18)
            }
            if let q = ask?.question, !q.isEmpty {
                Text(verbatim: q).font(.system(size: 14)).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true)
            }
            if let options = ask?.options, !options.isEmpty {
                VStack(spacing: 8) { ForEach(options) { o in OptionButton(option: o, disabled: sent) { send(o.letter) } } }
            }
            HStack(spacing: 8) {
                TextField("Or type your own answer", text: $text).textFieldStyle(.plain).font(.system(size: 14))
                    .onSubmit(sendText).disabled(sent).accessibilityLabel("Your own answer")
                Button(action: sendText) {
                    Image(systemName: "return").font(.system(size: 11, weight: .medium)).foregroundStyle(Theme.muted)
                        .frame(width: 28, height: 24).background(Theme.selected, in: RoundedRectangle(cornerRadius: 6, style: .continuous))
                }
                .buttonStyle(.plain).disabled(text.trimmingCharacters(in: .whitespaces).isEmpty || sent).accessibilityLabel("Send answer")
            }
            .padding(.leading, 14).padding(.trailing, 8).frame(height: 40)
            .background(Theme.bg.opacity(0.4), in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(Theme.line))
        }
        .padding(.leading, 17).padding(.trailing, 14).padding(.vertical, 14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .overlay(alignment: .leading) { Rectangle().fill(Theme.warning).frame(width: 3) }
        .clipShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(Theme.line))
        .opacity(sent ? 0.6 : 1)
        .accessibilityElement(children: .contain)
        .accessibilityLabel("\(t.title) needs you. \(ask?.question ?? "")")
    }

    private func send(_ s: String) {
        guard !sent else { return }
        sent = true
        answer(card.thread.sessionId, s)
    }

    private func sendText() {
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return }
        send(clean)
    }
}

private struct OptionButton: View {
    let option: RoomAskOption
    let disabled: Bool
    let action: () -> Void
    @State private var hover = false

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                Text(verbatim: option.letter).font(.system(size: 11, weight: .medium, design: .monospaced)).foregroundStyle(Theme.muted)
                    .frame(width: 22, height: 22).background(Theme.selected, in: RoundedRectangle(cornerRadius: 5, style: .continuous))
                Text(verbatim: option.text).font(.system(size: 14)).foregroundStyle(Theme.ink).lineLimit(2).multilineTextAlignment(.leading)
                Spacer(minLength: 8)
                if option.recommended { Text("(recommended)").font(.system(size: 12)).foregroundStyle(Theme.muted) }
            }
            .padding(.horizontal, 12).frame(minHeight: 40).frame(maxWidth: .infinity)
            .background(hover && !disabled ? Theme.selected : .clear, in: RoundedRectangle(cornerRadius: Radius.control, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(Theme.lineStrong))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain).disabled(disabled).onHover { hover = $0 }
        .accessibilityLabel("\(option.letter). \(option.text)" + (option.recommended ? ", recommended" : ""))
    }
}
