#if os(iOS)
import SqueakCore
import SqueakIcons
import SqueakMarkup
import SwiftUI

/// The Needs you page: an inbox of decisions, built for one or two. Each is a whole decision card
/// (DESIGN.md §8.4) that can be answered without opening the chat; from three on the rest wait as
/// rows that open in place. A card leaves when the Mac stops saying the chat needs you.
struct NeedsYouPage: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Binding var path: [HomeRoute]
    @State private var opened: Set<String> = []

    private var all: [PhoneSnapshot.Session] { model.snapshot?.sessions ?? [] }

    var body: some View {
        let waiting = NeedsYou.ordered(all)
        let layout = NeedsYou.layout(count: waiting.count)
        ScrollView {
            if waiting.isEmpty {
                empty
            } else {
                VStack(alignment: .leading, spacing: 16) {
                    ForEach(Array(waiting.prefix(layout.full))) { session in
                        DecisionCard(session: session, prominent: waiting.count == 1) { path.append(.session(session.key)) }
                    }
                    if let more = layout.moreLine {
                        Text(more).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.muted)
                            .padding(.top, 8).accessibilityAddTraits(.isHeader)
                        ForEach(Array(waiting.dropFirst(layout.full))) { session in
                            if opened.contains(session.key) {
                                DecisionCard(session: session, prominent: false) { path.append(.session(session.key)) }
                            } else {
                                CompactDecisionRow(session: session) {
                                    withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { _ = opened.insert(session.key) }
                                }
                            }
                        }
                    }
                }
                .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 24)
            }
        }
        .scrollDismissesKeyboard(.interactively)
        .background(Theme.bg.ignoresSafeArea())
        .navigationTitle("Needs you")
        .navigationBarTitleDisplayMode(.inline)
        .refreshable { await model.refresh() }
        .safeAreaInset(edge: .bottom) { ConnectionBar() }
        .foregroundStyle(Theme.ink)
    }

    private var empty: some View {
        VStack(spacing: 14) {
            Image("duck-asleep", bundle: .module).resizable().scaledToFit().frame(width: 112, height: 112).accessibilityHidden(true)
            Text("Nothing needs you.").font(.title3.weight(.semibold))
            Text(NeedsYou.hint(all)).font(.subheadline).foregroundStyle(Theme.muted)
        }
        .frame(maxWidth: .infinity).padding(.top, 120).padding(.horizontal, 24)
        .accessibilityElement(children: .combine)
    }
}

/// A chat that needs you, whole. No red mark here: the page is the Needs you tab, so an edge or a dot
/// would only repeat it. Red stays for a failed send.
struct DecisionCard: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let session: PhoneSnapshot.Session
    var prominent = false
    let onOpen: () -> Void
    @State private var showingFull = false
    /// The question and plan controls report their send here; a reply or an option goes through the outbox.
    @State private var answered: NeedsYou.Receipt?

    var body: some View {
        let card = NeedsYou.card(for: session)
        let agent = Presentation.agentName(session.agent)
        let sends = model.outbox[session.key] ?? []
        let receipt = NeedsYou.receipt(of: sends, for: session) ?? answered
        let locked = receipt?.phase == .sending || receipt?.phase == .sent
        let sendingText = NeedsYou.sendingText(of: sends, for: session)
        VStack(alignment: .leading, spacing: prominent ? 16 : 14) {
            header(card)
            if let receipt { ReceiptLine(receipt: receipt, session: session) }
            if receipt?.collapsesBody != true {
                content(card, agent: agent, locked: locked, sendingText: sendingText, sending: receipt?.phase == .sending)
            }
        }
        .padding(prominent ? 20 : 16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 16))
        .overlay(RoundedRectangle(cornerRadius: 16).stroke(Theme.line))
        .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: receipt)
        .accessibilityElement(children: .contain)
    }

    /// Question first, then what the agent said, then the controls.
    @ViewBuilder
    private func content(_ card: NeedsYou.Card, agent: String, locked: Bool, sendingText: String?, sending: Bool) -> some View {
        Group {
            if let heading = card.heading {
                Text(heading).font(prominent ? .title2.weight(.semibold) : .title3.weight(.semibold))
                    .fixedSize(horizontal: false, vertical: true).accessibilityAddTraits(.isHeader)
            }
            if let context = card.context {
                VStack(alignment: .leading, spacing: 8) {
                    MessageText(markdown: showingFull ? (card.full ?? context) : context, style: .squeak)
                    if card.hasMore {
                        Button {
                            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { showingFull.toggle() }
                        } label: {
                            Text(showingFull ? "Show less" : "Show full message").font(.subheadline.weight(.semibold))
                                .frame(minHeight: 44, alignment: .leading)
                        }
                        .buttonStyle(.plain).foregroundStyle(Theme.ink)
                    }
                }
            }
            ForEach(Array(card.controls.enumerated()), id: \.offset) { _, control in
                controlView(control, agent: agent, locked: locked, sendingText: sendingText, sending: sending)
            }
        }
    }

    private func header(_ card: NeedsYou.Card) -> some View {
        HStack(alignment: .center, spacing: 12) {
            ProjectMark(name: Presentation.projectName(session), size: prominent ? 40 : 34, folder: true)
            VStack(alignment: .leading, spacing: 2) {
                Text(Presentation.displayTitle(session)).font(.headline).lineLimit(2)
                Text("\(Presentation.subtitle(session)) · \(Age.describe(session.lastActivityAt))")
                    .font(.subheadline).foregroundStyle(Theme.muted).lineLimit(2)
            }
            Spacer(minLength: 0)
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(Presentation.displayTitle(session)), \(card.stateWord), \(Presentation.subtitle(session)), \(Age.spoken(session.lastActivityAt))")
        .accessibilityAddTraits(.isHeader)
    }

    @ViewBuilder
    private func controlView(_ control: NeedsYou.Control, agent: String, locked: Bool, sendingText: String?, sending: Bool) -> some View {
        switch control {
        case .choices:
            if let choices = session.choices {
                let reading = Presentation.read(message: session.message ?? "", choices: choices)
                // The card's heading is the question: the options come without a second copy of it.
                OptionsView(choices: .init(question: nil, options: choices.options, recommended: choices.recommended),
                            details: reading.details, disabled: locked, sending: sendingText) { letter in
                    Task { await model.send(letter, to: session) }
                }
            }
        case .answerQuestion:
            if let question = session.question { QuestionCard(question: question, agentName: agent, session: session, report: $answered) }
        case .plan:
            if let plan = session.question?.plan { PlanCard(plan: plan, agentName: agent, session: session, report: $answered) }
        case .approvalNote:
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Lucide(.info, size: 14, color: Theme.muted).accessibilityHidden(true)
                Text("\(agent) is waiting inside Conductor. Approve it there on your Mac; this phone can't approve tool calls.")
                    .font(.subheadline).foregroundStyle(Theme.muted)
            }
        case .reply:
            InlineReply(session: session, agentName: agent, locked: locked, sending: sending)
        case .openChat:
            Button(action: onOpen) {
                HStack(spacing: 6) {
                    Text(session.workflow == nil ? "Open chat" : "Open the call").font(.subheadline.weight(.semibold))
                    Lucide(.chevronRight, size: 14, color: Theme.muted).accessibilityHidden(true)
                }
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint("Opens the whole conversation")
        }
    }
}

/// The one status line at the top of a card (sending, sent, failed), with Send again and Edit when a send
/// failed. Shared by every control on the card.
struct ReceiptLine: View {
    let receipt: NeedsYou.Receipt
    let session: PhoneSnapshot.Session

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                switch receipt.phase {
                case .sending: ProgressView().controlSize(.small)
                case .sent: Lucide(.check, size: 14, color: Theme.muted).accessibilityHidden(true)
                case .failed: EmptyView()
                }
                Text(receipt.display).font(.footnote).lineLimit(receipt.phase == .failed ? nil : 1)
                    .foregroundStyle(receipt.phase == .failed ? Theme.error : Theme.muted)
            }
            if receipt.phase == .failed, let id = receipt.sendId { FailedSendActions(sendId: id, session: session) }
        }
        .accessibilityElement(children: .combine)
    }
}

/// A short reply field on the card: the same send path as the chat's composer (Face ID rules, the
/// outbox's honest states), without the chat's photos or queue.
private struct InlineReply: View {
    @Environment(AppModel.self) private var model
    let session: PhoneSnapshot.Session
    let agentName: String
    let locked: Bool
    var sending = false
    @State private var draft = ""
    /// Bumped on each clear, so the field is rebuilt and cannot keep text of its own.
    @State private var generation = 0
    @FocusState private var focused: Bool

    private var empty: Bool { draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Reply to \(agentName)…", text: $draft, axis: .vertical)
                .lineLimit(1...4).id(generation).focused($focused)
                .padding(.horizontal, 14).padding(.vertical, 12).frame(minHeight: 48)
                .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(focused ? Theme.ink : Theme.line, lineWidth: focused ? 1.5 : 1))
                .disabled(locked)
                .accessibilityLabel("Reply to \(Presentation.displayTitle(session))")
            Button(action: send) {
                Group {
                    if sending { ProgressView() } else { Lucide(.arrowUp, size: 20, color: empty || locked ? Theme.muted : Theme.primaryText) }
                }
                .frame(width: 48, height: 48)
                    .background(empty || locked ? Theme.surfaceRaised : Theme.primaryFill, in: RoundedRectangle(cornerRadius: 12))
            }
            .buttonStyle(.plain).disabled(empty || locked)
            .accessibilityLabel(sending ? "Sending reply" : "Send reply")
        }
        .onChange(of: model.restoredDraft[session.key]) { _, text in
            guard let text else { return }
            draft = DraftPolicy.restoring(text, into: draft)
            model.draftRestored(for: session.key)
        }
    }

    private func send() {
        let text = draft
        // Empty at the tap; again on the next run loop, when the keyboard commits what it still holds.
        draft = ""; focused = false; generation += 1
        DispatchQueue.main.async { draft = "" }
        Task {
            guard let current = model.session(session.key) else { giveBack(text); return }
            if await !model.send(text, to: current) { giveBack(text) }
        }
    }

    private func giveBack(_ text: String) {
        draft = DraftPolicy.restoring(text, into: draft)
        generation += 1
    }
}

/// A third or later decision, kept to a row: who, what, how long. A tap opens it as a card.
private struct CompactDecisionRow: View {
    let session: PhoneSnapshot.Session
    let onOpen: () -> Void

    var body: some View {
        let card = NeedsYou.card(for: session)
        Button(action: onOpen) {
            HStack(spacing: 12) {
                ProjectMark(name: Presentation.projectName(session), size: 30, folder: true)
                VStack(alignment: .leading, spacing: 2) {
                    Text(Presentation.displayTitle(session)).font(.headline).lineLimit(1)
                    Text(card.heading ?? Presentation.ask(session)).font(.subheadline).foregroundStyle(Theme.muted).lineLimit(2)
                    Text("\(Presentation.subtitle(session)) · \(Age.describe(session.lastActivityAt))").font(.footnote).foregroundStyle(Theme.subtle).lineLimit(1)
                }
                Spacer(minLength: 8)
                Lucide(.chevronDown, size: 16, color: Theme.subtle).accessibilityHidden(true)
            }
            .padding(.horizontal, 16).padding(.vertical, 12).frame(minHeight: 56)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
            .contentShape(RoundedRectangle(cornerRadius: 12))
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(Presentation.displayTitle(session)), \(card.stateWord), \(card.heading ?? Presentation.ask(session)), \(Age.spoken(session.lastActivityAt))")
        .accessibilityHint("Opens the decision here")
    }
}
#endif
