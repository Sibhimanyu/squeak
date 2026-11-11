import AppKit
import SqueakIcons
import SqueakMarkup
import SqueakMacCore
import SwiftUI

// MARK: - Messages

/// One finished transcript row as a stable, Equatable view: SwiftUI skips its body, and so the measuring of the whole
/// 40-row stack under it, unless something the row draws changed. The closure is left out of the comparison (a closure is
/// never equal, which re-ran every row on every pass of the detail view); `canAnswer`, which gates it, is compared.
struct MessageRowView: View, Equatable {
    let message: ChatMessage
    var agentName: String
    var canOpenHost: Bool
    var agentWorking: Bool
    var layout: ChoiceLayout?
    var canAnswer: Bool
    var onChoose: (ChoiceCard) -> Void
    var muted: Bool
    var receipt: ChatTimeline.Receipt?
    var history: HistoryHandle?
    var footer: TurnFooter?

    nonisolated static func == (a: MessageRowView, b: MessageRowView) -> Bool {
        a.message == b.message && a.agentName == b.agentName && a.canOpenHost == b.canOpenHost && a.agentWorking == b.agentWorking
            && a.layout == b.layout && a.canAnswer == b.canAnswer && a.muted == b.muted && a.receipt == b.receipt
            && a.history == b.history && a.footer == b.footer
    }

    var body: some View {
        MessageView(
            message: message, agentName: agentName, canOpenHost: canOpenHost, agentWorking: agentWorking, layout: layout,
            canAnswer: canAnswer, onChoose: onChoose, muted: muted, receipt: receipt, history: history, footer: footer)
    }
}

struct MessageView: View {
    let message: ChatMessage
    var agentName: String
    var canOpenHost: Bool
    /// Whether the agent is still mid-turn, which decides if a queued message still reads "Queued".
    var agentWorking = true
    var layout: ChoiceLayout?
    var canAnswer = true
    var onChoose: (ChoiceCard) -> Void = { _ in }
    /// The previous turn's agent message while a new one is being worked on.
    var muted = false
    /// What the transcript says about your latest message ("Read by Claude", "Turn ended").
    var receipt: ChatTimeline.Receipt?
    /// A Squeak chat's user message: Edit, Fork from here and Restore files on hover (HistoryViews.swift).
    var history: HistoryHandle?
    /// The line under the last agent message of a finished turn (elapsed, time of day, copy, more).
    var footer: TurnFooter?
    @State private var hovering = false
    @Environment(AppModel.self) private var model

    var body: some View {
        if message.role == .user { userBody } else { agentBody.opacity(muted ? 0.62 : 1) }
    }

    /// Right-aligned under a user bubble: time, then the delivery line ("14:02 · Read by Claude").
    private var userMeta: String? {
        let time = message.at?.formatted(date: .omitted, time: .shortened)
        let status = DeliveryText(message: message, agent: agentName, agentWorking: agentWorking, receipt: receipt)?.text
        let parts = [time, status].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }

    private var userBody: some View {
        let status = DeliveryText(message: message, agent: agentName, agentWorking: agentWorking, receipt: receipt)
        return VStack(alignment: .trailing, spacing: 4) {
            if let history, model.history.editingTurn == history.turn.turn, model.history.hostId == model.hostId(history.session) {
                HistoryEditor(handle: history)
            } else { UserBubbleLayout {
                Text(verbatim: message.text)
                    .font(Typo.reading).lineSpacing(CGFloat(Tokens.Workbench.readingLine - Tokens.Workbench.readingSize) - 3.6)
                    .foregroundStyle(Theme.ink)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(Theme.surface, in: UserBubbleShape())
                    .overlay(UserBubbleShape().strokeBorder(Theme.line))

            } }
            HStack(spacing: 8) {
                // Reserved, so hovering never moves the line.
                if let history, model.history.editingTurn != history.turn.turn {
                    HistoryActions(handle: history).opacity(hovering ? 1 : 0)
                }
                if let line = userMeta {
                    if let status, status.offersOpen || status.offersReuse { delivery(status, prefix: message.at?.formatted(date: .omitted, time: .shortened)) }
                    else { Text(verbatim: line).font(Typo.meta).monospacedDigit().foregroundStyle(Theme.muted) }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .onHover { hovering = $0 }
    }

    private var agentBody: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let layout {
                if !layout.before.isEmpty { MessageText(markdown: layout.before, style: .reading) }
                QuestionCardView(model: QuestionCardModel(layout: layout), agent: agentName,
                                 choose: canAnswer ? { i in if i < layout.cards.count { onChoose(layout.cards[i]) } } : nil)
                    .cardKeys(.question, optionCount: layout.cards.count, composerHasText: !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, busy: !canAnswer) { action in
                        if case .answer(let i) = action, i < layout.cards.count { onChoose(layout.cards[i]) }
                    }
                if !layout.after.isEmpty { MessageText(markdown: layout.after, style: .reading) }
            } else {
                MessageText(markdown: message.text, style: .reading)
            }
            if let footer { TurnFooterView(footer: footer, messageText: message.text) }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(layout != nil ? "\(agentName) is waiting for your answer" : "")
    }

    private func delivery(_ status: DeliveryText, prefix: String? = nil) -> some View {
        HStack(spacing: 6) {
            Text(verbatim: [prefix, status.text].compactMap { $0 }.joined(separator: " · ")).font(Typo.meta).foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
            if status.offersOpen, canOpenHost {
                Button("Open in Conductor") { model.openInHost() }.buttonStyle(.plain)
                    .font(Typo.meta.weight(.medium))
            }
            if status.offersReuse {
                Button("Edit as new message") { model.reuse(message) }.buttonStyle(.plain)
                    .font(Typo.meta.weight(.medium))
                ReportProblemButton(problem: status.text, place: "Conversation › Send", title: "Report")
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// 8.4 option row: letter in a `radius-chip` square, title in `label`, the detail beneath, and the
/// word "recommended" in `muted` when the agent marked one (never coloured, never pre-selected).
/// Tapping sends just the letter. The row sits on Liquid Glass (Glass.swift); no state colour on it.
struct AnswerCard: View {
    let card: ChoiceCard
    var isEnabled = true
    var action: () -> Void
    @State private var hovering = false

    var body: some View {
        Button(action: action) {
            HStack(alignment: .top, spacing: 12) {
                Text(card.letter)
                    .font(Typo.label)
                    .foregroundStyle(Theme.muted)
                    .frame(width: 26, height: 26)
                    .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.chip))
                    .overlay(RoundedRectangle(cornerRadius: Radius.chip).strokeBorder(Theme.line))
                VStack(alignment: .leading, spacing: 3) {
                    Text(verbatim: card.title).font(Typo.label).foregroundStyle(Theme.ink)
                    if let d = card.detail {
                        Text(verbatim: d).font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 12)
                if card.isRecommended {
                    Text("recommended").font(Typo.meta).foregroundStyle(Theme.muted)
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 12)
            .frame(maxWidth: .infinity, minHeight: 48, alignment: .leading)
            .contentShape(RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
        }
        .buttonStyle(CardPressStyle(hovering: hovering))
        .disabled(!isEnabled)
        .opacity(isEnabled ? 1 : 0.5)
        .onHover { hovering = $0 }
        .accessibilityLabel("Answer \(card.letter): \(card.title)\(card.isRecommended ? ", recommended" : "")")
        .accessibilityHint(card.detail ?? "")
    }
}

struct CardPressStyle: ButtonStyle {
    var hovering: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .squeakGlass(radius: Radius.card, interactive: true)
            .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(hovering ? Theme.lineStrong : Theme.line))
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.985 : 1)
            .animation(reduceMotion ? nil : .spring(response: 0.25, dampingFraction: 0.8), value: configuration.isPressed)
    }
}

/// The one muted line under a sent message ("Sending…", "Sent", "Queued · …", "Steered into the current turn", "Not confirmed", "Not sent: reason"),
/// with the one action that fits a failure.
struct DeliveryText {
    var text: String
    var offersOpen = false
    var offersReuse = false

    init?(message: ChatMessage, agent: String, agentWorking: Bool, receipt: ChatTimeline.Receipt? = nil) {
        guard let state = message.state else { return nil }
        // In the transcript: the receipt says it (only the newest one of yours has it); nothing otherwise.
        if state == .confirmed {
            guard let receipt else { return nil }
            text = receipt.line(agent: agent)
            return
        }
        guard let line = message.deliveryLine(agent: agent, agentWorking: agentWorking) else { return nil }
        text = line
        switch state {
        case .uncertain: offersOpen = true
        case .refused, .notSent: offersReuse = true
        default: break
        }
    }
}

struct ConversationHeightKey: PreferenceKey {
    static let defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
}

/// The top of the conversation: "Load earlier messages" while there are some (it loads by itself when
/// scrolled to), a spinner while a page is read, a retry when it failed, "Start of chat" at the end.
struct EarlierRow: View {
    let paging: EarlierPaging
    var kind: TranscriptWindow.EarlierKind = .load
    var onLoad: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            switch kind {
            case .none:
                Color.clear.frame(height: 1)
            case .loading:
                DotGridLoader(size: 14)
                Text("Loading earlier messages…").font(Typo.meta).foregroundStyle(Theme.muted)
            case .failed:
                let error = paging.error ?? ""
                Text(verbatim: error).font(Typo.meta).foregroundStyle(Theme.negative)
                Button("Try again", action: onLoad).buttonStyle(.plain).font(Typo.meta.weight(.medium))
                ReportProblemButton(problem: error, place: "Conversation › Earlier messages", title: "Report")
            case .start:
                Text("Start of chat").font(Typo.meta).foregroundStyle(Theme.subtle)
            case .load:
                Button("Load earlier messages", action: onLoad).buttonStyle(.plain)
                    .font(Typo.meta.weight(.medium)).foregroundStyle(Theme.muted)
            }
        }
        .frame(maxWidth: .infinity)
        .frame(minHeight: kind == .none ? 1 : 20)
        .accessibilityElement(children: .combine)
    }
}

/// The person's bubble: radius 16, the corner on their side (bottom trailing) drops to 6 so it points at the speaker.
struct UserBubbleShape: InsettableShape {
    var inset: CGFloat = 0

    func path(in rect: CGRect) -> Path {
        let big = CGFloat(Tokens.Workbench.userBubbleRadius), tight = CGFloat(Tokens.Workbench.userBubbleTightRadius)
        return UnevenRoundedRectangle(
            topLeadingRadius: big, bottomLeadingRadius: big, bottomTrailingRadius: tight, topTrailingRadius: big, style: .continuous
        ).path(in: rect.insetBy(dx: inset, dy: inset))
    }

    func inset(by amount: CGFloat) -> UserBubbleShape { var s = self; s.inset += amount; return s }
}

/// "1m 19s · 4:03 PM", then Copy and a ⋯ menu, under a finished turn's last message (§8.10). Quiet by default
/// (`subtle`, `footnote`); the two buttons come to `muted` on hover. Reserved height, so nothing jumps.
struct TurnFooterView: View {
    let footer: TurnFooter
    /// This message's own text, for the Copy button.
    let messageText: String
    @State private var copied = false

    var body: some View {
        HStack(spacing: 8) {
            let line = footer.line { $0.formatted(date: .omitted, time: .shortened) }
            if !line.isEmpty { Text(verbatim: line).font(Typo.footnote).monospacedDigit().foregroundStyle(Theme.subtle) }
            Button { copy(messageText) } label: {
                Lucide(copied ? .check : .copy, size: 14, color: Theme.muted).frame(width: 24, height: 24).contentShape(Rectangle())
            }
            .buttonStyle(.plain).help("Copy this message").accessibilityLabel("Copy this message")
            SqueakMenu {
                Button("Copy whole turn") { copy(footer.turnText) }
            } label: {
                Lucide(.ellipsis, size: 14, color: Theme.muted).frame(width: 24, height: 24).contentShape(Rectangle())
            }
            .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize().help("More").accessibilityLabel("More")
            Spacer(minLength: 0)
        }
        .frame(height: 24)
    }

    private func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        copied = true
        Task { try? await Task.sleep(for: .seconds(1.5)); copied = false }
    }
}

/// Proposes a bubble width from the centered row, never the surrounding ScrollView's viewport.
struct UserBubbleLayout: Layout {
    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? Metrics.workbenchColumn
        let bubble = subviews.first?.sizeThatFits(ProposedViewSize(width: width * CGFloat(Tokens.Workbench.userBubbleMaxFraction), height: nil)) ?? .zero
        return CGSize(width: width, height: bubble.height)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        subviews.first?.place(at: CGPoint(x: bounds.maxX, y: bounds.minY), anchor: .topTrailing,
                             proposal: ProposedViewSize(width: bounds.width * CGFloat(Tokens.Workbench.userBubbleMaxFraction), height: nil))
    }
}
