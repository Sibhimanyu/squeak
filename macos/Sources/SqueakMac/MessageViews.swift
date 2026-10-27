import AppKit
import SqueakIcons
import SqueakMarkup
import SqueakMacCore
import SwiftUI

// MARK: - Messages

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
    @Environment(AppModel.self) private var model

    var body: some View {
        if message.role == .user { userBody } else { agentBody.opacity(muted ? 0.62 : 1) }
    }

    private func meta(_ name: String) -> some View {
        HStack(spacing: 6) {
            Text(name).font(Typo.label).foregroundStyle(Theme.ink)
            if let at = message.at {
                Text("·").foregroundStyle(Theme.subtle)
                Text(at.formatted(date: .omitted, time: .shortened)).font(Typo.body).foregroundStyle(Theme.muted)
            }
        }
    }

    private var userBody: some View {
        VStack(alignment: .trailing, spacing: 6) {
            meta("You")
            Text(verbatim: message.text)
                .font(.system(size: 14)).lineSpacing(3)
                .textSelection(.enabled)
                .fixedSize(horizontal: false, vertical: true)
                .padding(.horizontal, 14).padding(.vertical, 11)
                .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.card, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: Radius.card, style: .continuous).strokeBorder(Theme.line))
            if let status = DeliveryText(message: message, agent: agentName, agentWorking: agentWorking, receipt: receipt) { delivery(status) }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    private var agentBody: some View {
        HStack(alignment: .top, spacing: 10) {
            AgentAvatar().padding(.top, 1)
            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 9) {
                    Text(agentName).font(.system(size: 13.5, weight: .semibold)).foregroundStyle(Theme.ink)
                    if let at = message.at {
                        Text(at.formatted(date: .omitted, time: .shortened)).font(.system(size: 12)).foregroundStyle(Theme.muted)
                    }
                }
                VStack(alignment: .leading, spacing: 10) {
                    if let layout {
                        if !layout.before.isEmpty { MessageText(markdown: layout.before, style: .squeak) }
                        if let q = layout.question {
                            MessageInlineText(markdown: q, style: .squeak, size: 15, weight: .semibold).padding(.top, 8).accessibilityAddTraits(.isHeader)
                        }
                        SqueakGlassGroup(spacing: 10) {
                            VStack(spacing: 10) {
                                ForEach(layout.cards, id: \.letter) { card in
                                    AnswerCard(card: card, isEnabled: canAnswer) { onChoose(card) }
                                }
                            }
                        }
                        if !layout.after.isEmpty { MessageText(markdown: layout.after, style: .squeak).padding(.top, 6) }
                    } else {
                        MessageText(markdown: message.text, style: .squeak)
                    }
                }
                .padding(.horizontal, 18).padding(.vertical, 15)
                .background(Theme.surface.opacity(0.85), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).strokeBorder(Theme.line))
            }
            .frame(maxWidth: 600, alignment: .leading)
            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(layout != nil ? "\(agentName) is waiting for your answer" : "")
    }

    private func delivery(_ status: DeliveryText) -> some View {
        HStack(spacing: 6) {
            Text(status.text).font(Typo.meta).foregroundStyle(Theme.muted)
                .fixedSize(horizontal: false, vertical: true)
            if status.offersOpen, canOpenHost {
                Button("Open in Conductor") { model.openInHost() }.buttonStyle(.plain)
                    .font(Typo.meta.weight(.medium))
            }
            if status.offersReuse {
                Button("Edit as new message") { model.reuse(message) }.buttonStyle(.plain)
                    .font(Typo.meta.weight(.medium))
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

/// "Send" in the primary text colour while it can be pressed, muted while it cannot.
struct SendLabel: View {
    var title = "Send"
    @Environment(\.isEnabled) private var isEnabled
    var body: some View {
        Text(title).font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.primaryText)
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
    var onLoad: () -> Void

    var body: some View {
        HStack(spacing: 8) {
            if paging.loading {
                ProgressView().controlSize(.small)
                Text("Loading earlier messages…").font(Typo.meta).foregroundStyle(Theme.muted)
            } else if let error = paging.error {
                Text(verbatim: error).font(Typo.meta).foregroundStyle(Theme.error)
                Button("Try again", action: onLoad).buttonStyle(.plain).font(Typo.meta.weight(.medium))
            } else if paging.reachedStart {
                Text("Start of chat").font(Typo.meta).foregroundStyle(Theme.subtle)
            } else {
                Button("Load earlier messages", action: onLoad).buttonStyle(.plain)
                    .font(Typo.meta.weight(.medium)).foregroundStyle(Theme.muted)
            }
        }
        .frame(maxWidth: .infinity)
        .frame(minHeight: 20)
        .accessibilityElement(children: .combine)
    }
}

/// The agent at work, directly under what you sent: its name, a pulsing dot (still under Reduce
/// Motion) and the live step ("Running tests…", "Starting…" before the first).
struct WorkingRow: View {
    let agentName: String
    let label: String

    var body: some View {
        HStack(spacing: 8) {
            StateDot(state: .working)
            Text(agentName).font(Typo.label).foregroundStyle(Theme.ink)
            Text("·").foregroundStyle(Theme.subtle)
            Text(verbatim: label).font(Typo.body).foregroundStyle(Theme.muted).lineLimit(1)
                .contentTransition(.opacity)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(agentName) is working: \(label)")
    }
}

/// The agent's mark beside its messages: a light disc with a spark, as in the mockup.
struct AgentAvatar: View {
    var body: some View {
        Circle().fill(Color(nsColor: NSColor(hex: 0xE9DDD3))).frame(width: 26, height: 26)
            .overlay(Lucide(.sparkles, size: 14, color: Color(nsColor: NSColor(hex: 0x6B4A3A))))
            .accessibilityHidden(true)
    }
}
