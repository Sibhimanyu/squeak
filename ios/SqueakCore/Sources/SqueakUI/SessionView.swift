#if os(iOS)
import SqueakCore
import SqueakIcons
import SqueakMarkup
import SwiftUI

/// One session: the agent's latest message, its options as cards, what this
/// phone sent, the working turn, and the reply composer with what is queued
/// above it (DESIGN.md §8.4 and §8.5). The phone shows only what the Mac sends it.
///
/// Built so a streamed step redraws only what it changes: the rows are values
/// (`ChatTimeline`), each drawn by a view that skips its body when its row is
/// the same, and the composer takes plain values, so typing never waits on a
/// step arriving.
struct SessionView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let key: String
    @State private var draft: String = {
        let args = ProcessInfo.processInfo.arguments
        if args.contains("-squeak-demo"), let i = args.firstIndex(of: "-squeak-draft"), i + 1 < args.count { return args[i + 1] }
        return ""
    }()
    @FocusState private var composing: Bool
    /// The working row's steps, open or closed. Closed by default, like a chat app's "Thinking…"
    /// line, verbose or not, and closed again on every send; `-squeak-tab activity` opens it for
    /// screenshots. Closed, it still shows the newest steps in a small live box.
    @State private var stepsOpen: Bool = {
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "-squeak-tab"), i + 1 < args.count, args[i + 1] == "activity" { return true }
        return false
    }()
    /// Folded parts of the turn (before a steer, or a finished turn's steps) that were opened.
    @State private var openParts: Set<String> = []

    private var session: PhoneSnapshot.Session? { model.snapshot?.session(key) }

    @Environment(\.squeakScreen) private var screen

    var body: some View {
        Group {
            if let session {
                content(session)
            } else {
                Text("This session is no longer active.").foregroundStyle(Theme.muted)
                    .frame(maxWidth: .infinity, maxHeight: .infinity).background(Theme.bg)
            }
        }
        .onAppear { screen.report?("Session"); model.watch(key) }
        .onDisappear { screen.report?("Sessions"); model.watch(nil) }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                if let session { SessionHeader(session: session) }
            }
        }
    }

    private var live: LiveTurn? { model.verbose ? model.liveTurns[key] : nil }

    @ViewBuilder
    private func content(_ session: PhoneSnapshot.Session) -> some View {
        let live = live
        let sends = model.outbox[session.key] ?? []
        let rows = ChatTimeline.rows(session: session, remembered: model.remembered[session.key], sends: sends, live: live)
        let cards = ChatQueue.cards(session: session, live: live, sends: sends, hidden: model.hiddenQueued)
        ScrollViewReader { proxy in
            ScrollView {
                ChatRows(
                    rows: rows, session: session, sending: model.isSending(session.key),
                    total: live?.working == true ? live?.total ?? 0 : session.activity?.total ?? 0, live: live?.working == true,
                    stepsOpen: $stepsOpen, openParts: $openParts
                )
                .padding(.horizontal, 20).padding(.top, 16)
                .frame(maxWidth: .infinity, alignment: .leading)
                // The end of the chat: whether it is on screen says whether to follow new content.
                Color.clear.frame(height: 16).id(Self.end)
                    .onAppear { atEnd = true }
                    .onDisappear { atEnd = false }
            }
            .modifier(StickToBottom())
            .scrollDismissesKeyboard(.interactively)
            // Open at the newest message, after the first layout (markdown sizes itself late).
            .onAppear {
                proxy.scrollTo(Self.end, anchor: .bottom)
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { proxy.scrollTo(Self.end, anchor: .bottom) }
            }
            // A new row (a message, a steer, the reply) eases into view; a new step inside the
            // live box just follows, so a busy turn does not run an animation a second.
            .onChange(of: rows.map(\.id)) { _, _ in
                guard atEnd else { return }
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { proxy.scrollTo(Self.end, anchor: .bottom) }
            }
            .onChange(of: stepCount(rows)) { _, _ in
                guard atEnd else { return }
                proxy.scrollTo(Self.end, anchor: .bottom)
            }
            // Sending is always a reason to look at the end, and starts a fresh, folded working row.
            .onChange(of: sends.count) { _, _ in
                stepsOpen = false
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.2)) { proxy.scrollTo(Self.end, anchor: .bottom) }
            }
        }
        .background(Theme.bg.ignoresSafeArea())
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                if !cards.isEmpty {
                    QueueStack(
                        cards: cards, agentName: Presentation.agentName(session.agent), problems: model.queueProblem,
                        onSteer: { card in Task { await model.steerQueued(card, in: session) } },
                        onEdit: { card in
                            Task {
                                guard let text = await model.removeQueued(card, in: session) else { return }
                                draft = draft.isEmpty ? text : draft + "\n" + text
                                composing = true
                            }
                        },
                        onDelete: { card in Task { await model.removeQueued(card, in: session) } }
                    )
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }
                Composer(
                    session: session, agentName: Presentation.agentName(session.agent),
                    working: session.state == "working" && Presentation.replyBlock(session) == nil,
                    block: Presentation.replyBlock(session), draft: $draft, composing: $composing
                )
            }
            .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: cards.map(\.id))
        }
    }

    private static let end = "chat-end"
    @State private var atEnd = true

    private func stepCount(_ rows: [ChatTimeline.Row]) -> Int {
        guard case .working(_, let steps)? = rows.last else { return 0 }
        return steps.count * 1_000 + (steps.last?.text.count ?? 0) % 1_000
    }
}

/// The header lives in the navigation bar, two lines: the chat's title, then
/// its state with as much context (age, repo, agent, diff) as the width
/// allows. The chat is what this screen is for, so it gets the room.
private struct SessionHeader: View {
    let session: PhoneSnapshot.Session

    var body: some View {
        let state = "\(session.stateWord) · \(Age.describe(session.lastActivityAt))"
        let subtitle = Presentation.subtitle(session)
        let lines = Presentation.headerLines(state: state, subtitle: subtitle, git: session.git)
        VStack(spacing: 1) {
            Text(Presentation.displayTitle(session))
                .font(.headline).lineLimit(1).truncationMode(.tail)
            HStack(spacing: 5) {
                StatusDot(color: Theme.stateColor(session.state), pulses: session.needsYou || session.state == "working",
                          period: session.state == "working" ? 1.6 : 1.0)
                ViewThatFits(in: .horizontal) {
                    // By position: ViewThatFits traps on two children with one id.
                    ForEach(Array(lines.enumerated()), id: \.offset) { Text($0.element).lineLimit(1) }
                }
                .font(.caption).foregroundStyle(Theme.muted).monospacedDigit()
            }
        }
        .frame(maxWidth: 260)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Presentation.displayTitle(session))
        .accessibilityValue(lines[0])
        .accessibilityAddTraits(.isHeader)
    }
}

/* ---------- chat ---------- */

/// The conversation's rows. Each row's view takes only its own values, so a new
/// step redraws the live box and nothing above it.
private struct ChatRows: View {
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let rows: [ChatTimeline.Row]
    let session: PhoneSnapshot.Session
    let sending: Bool
    let total: Int
    let live: Bool
    @Binding var stepsOpen: Bool
    @Binding var openParts: Set<String>

    var body: some View {
        // A pending question has its own card; letters read from the message would repeat it.
        let choices = session.state == "working" || session.question != nil ? nil : session.choices
        let agentName = Presentation.agentName(session.agent)
        let blocked = Presentation.replyBlock(session) != nil
        let parted = rows.contains { if case .steer = $0 { true } else { false } }
        VStack(alignment: .leading, spacing: 16) {
            ForEach(rows) { row in
                switch row {
                case .sent(let message):
                    SentBubble(text: message.text, date: message.date, line: message.status.line)
                case .steer(_, let text, let line):
                    SentBubble(text: text, date: nil, line: line)
                case .agent(let text, let atISO, let muted):
                    AgentMessage(
                        agentName: agentName, text: text, atISO: atISO, muted: muted,
                        choices: muted ? nil : choices, disabled: blocked || sending
                    ) { letter in
                        Task { await model.send(letter, to: session) }
                    }
                    .equatable()
                case .folded(let id, let steps):
                    FoldedSteps(steps: steps, open: Binding(
                        get: { openParts.contains(id) },
                        set: { if $0 { openParts.insert(id) } else { openParts.remove(id) } }))
                case .working(let label, let steps):
                    // After a steer the live part is its own count; "the latest 3 of 7" would count the folded parts too.
                    WorkingRow(agentName: agentName, label: label, steps: steps, total: parted ? steps.count : total, live: live, open: $stepsOpen)
                        .transition(.opacity)
                case .empty(let text):
                    Text(text).foregroundStyle(Theme.muted)
                }
            }
            if session.state == "awaiting_input", let question = session.question {
                QuestionCard(question: question, agentName: agentName)
            }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.25), value: rows.map(\.id))
    }
}

/// The agent's message: its name and time, then the message set as a document, its options in between.
/// Equatable on what it shows, so it is not laid out again while the turn under it streams.
private struct AgentMessage: View, Equatable {
    let agentName: String
    let text: String
    let atISO: String
    let muted: Bool
    let choices: PhoneSnapshot.Choices?
    let disabled: Bool
    let onPick: (String) -> Void

    static func == (a: Self, b: Self) -> Bool {
        a.agentName == b.agentName && a.text == b.text && a.atISO == b.atISO && a.muted == b.muted
            && a.choices == b.choices && a.disabled == b.disabled
    }

    var body: some View {
        let reading = Presentation.read(message: text, choices: choices)
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Text(agentName).font(.subheadline.weight(.semibold))
                Text(Age.clock(atISO)).font(.subheadline).foregroundStyle(Theme.muted).monospacedDigit()
            }
            .accessibilityElement(children: .combine)
            if !reading.before.isEmpty { MessageText(markdown: reading.before.joined(separator: "\n\n"), style: .squeak) }
            if let choices {
                OptionsView(choices: choices, details: reading.details, disabled: disabled, onPick: onPick)
            }
            if !reading.after.isEmpty { MessageText(markdown: reading.after.joined(separator: "\n\n"), style: .squeak) }
        }
        .opacity(muted ? 0.62 : 1)
        .accessibilityLabel(muted ? "Previous message" : "")
    }
}

/// The agent at work, under what you sent: its name, a pulsing dot (still under Reduce Motion) and the
/// live step ("Running tests…", "Starting…" before the first). The colour is the working state's (§3.3).
///
/// Closed, a small live box under it shows the newest three steps, one line each, and moves as they
/// arrive; a tap opens every step the phone has (the whole turn when it is streamed live).
struct WorkingRow: View {
    let agentName: String
    let label: String
    var steps: [TurnStep] = []
    var total = 0
    var live = false
    @Binding var open: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    init(agentName: String, label: String, steps: [TurnStep] = [], total: Int = 0, live: Bool = false, open: Binding<Bool> = .constant(false)) {
        self.agentName = agentName; self.label = label; self.steps = steps; self.total = total; self.live = live; _open = open
    }

    static let boxLines = 3

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation(reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.86)) { open.toggle() }
            } label: {
                HStack(spacing: 8) {
                    StatusDot(color: Theme.working, pulses: true, period: 1.6)
                    Text(agentName).font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
                    Text("·").foregroundStyle(Theme.subtle)
                    Text(label).font(.subheadline).foregroundStyle(Theme.muted).lineLimit(1)
                    if !steps.isEmpty {
                        Spacer(minLength: 4)
                        Lucide(open ? .chevronUp : .chevronDown, size: 14, color: Theme.muted)
                    }
                }
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(steps.isEmpty)
            .accessibilityLabel("\(agentName) is working: \(label)")
            .accessibilityHint(steps.isEmpty ? "" : open ? "Hides the steps" : "Shows the steps of this turn")
            if open, !steps.isEmpty {
                StepList(steps: steps, total: max(total, steps.count), live: live)
                    .padding(.leading, 4)
                    .transition(.opacity)
            } else if !steps.isEmpty {
                LiveBox(steps: Array(steps.suffix(Self.boxLines)), first: max(total, steps.count) - min(steps.count, Self.boxLines))
                    .transition(.opacity)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// The newest steps of a working turn, one line each, in a small fixed box: what the agent is doing
/// right now, without the chat around it moving as it grows.
private struct LiveBox: View {
    let steps: [TurnStep]
    /// The position of `steps[0]` in the whole turn, so a step keeps its identity as new ones arrive.
    let first: Int
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(Array(steps.enumerated()), id: \.offset) { offset, step in
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Lucide(StepList.icon(step.kind), size: 13, color: Theme.muted).frame(width: 16).accessibilityHidden(true)
                    Text(step.text.replacingOccurrences(of: "\n", with: " "))
                        .font(.footnote).foregroundStyle(offset == steps.count - 1 ? Theme.ink : Theme.muted)
                        .italic(step.kind == "thinking")
                        .lineLimit(1).truncationMode(.tail)
                }
                .id(first + offset)
                .transition(.asymmetric(insertion: .move(edge: .bottom).combined(with: .opacity), removal: .opacity))
            }
        }
        .frame(maxWidth: .infinity, minHeight: CGFloat(WorkingRow.boxLines) * 20, alignment: .bottomLeading)
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: first + steps.count)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Latest steps: \(steps.map(\.text).joined(separator: ". "))")
    }
}

/// Part of a turn that is over (what came before a steer, or a finished turn's steps), folded to one
/// quiet line; a tap opens its steps.
private struct FoldedSteps: View {
    let steps: [TurnStep]
    @Binding var open: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                withAnimation(reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.86)) { open.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Lucide(.clipboardList, size: 14, color: Theme.muted).accessibilityHidden(true)
                    Text(steps.count == 1 ? "Worked · 1 step" : "Worked · \(steps.count) steps")
                        .font(.subheadline).foregroundStyle(Theme.muted)
                    Lucide(open ? .chevronUp : .chevronDown, size: 12, color: Theme.subtle)
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityHint(open ? "Hides these steps" : "Shows these steps")
            if open {
                StepList(steps: steps, total: steps.count, live: false)
                    .padding(.leading, 4)
                    .transition(.opacity)
            }
        }
    }
}

/// What is queued behind the working turn (§8.5): one card each, above the composer, oldest first.
/// Steer now puts it into the turn; Edit takes it back into the field; Delete takes it out.
/// Only Conductor's own queue can be changed, so a card the Mac has not listed yet has no actions.
private struct QueueStack: View {
    let cards: [ChatQueue.Card]
    let agentName: String
    let problems: [String: String]
    let onSteer: (ChatQueue.Card) -> Void
    let onEdit: (ChatQueue.Card) -> Void
    let onDelete: (ChatQueue.Card) -> Void
    @State private var showAll = false

    var body: some View {
        let shown = showAll || cards.count <= 2 ? cards : Array(cards.prefix(2))
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Queued · \(agentName) reads \(cards.count == 1 ? "it" : "them") after this turn")
                    .font(.footnote).foregroundStyle(Theme.muted)
                Spacer(minLength: 4)
                if cards.count > 2 {
                    Button(showAll ? "Show less" : "Show all \(cards.count)") { showAll.toggle() }
                        .font(.footnote.weight(.medium)).foregroundStyle(Theme.muted)
                        .frame(minHeight: 32)
                }
            }
            ForEach(shown) { card in
                QueueCard(card: card, problem: problems[card.id], onSteer: onSteer, onEdit: onEdit, onDelete: onDelete)
                    .transition(.opacity)
            }
        }
        .padding(.horizontal, 20).padding(.top, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.bg)
    }
}

private struct QueueCard: View {
    let card: ChatQueue.Card
    let problem: String?
    let onSteer: (ChatQueue.Card) -> Void
    let onEdit: (ChatQueue.Card) -> Void
    let onDelete: (ChatQueue.Card) -> Void

    var body: some View {
        HStack(alignment: .center, spacing: 8) {
            VStack(alignment: .leading, spacing: 2) {
                Text(card.text).font(.subheadline).foregroundStyle(Theme.ink).lineLimit(2)
                if let problem {
                    Text(problem).font(.caption).foregroundStyle(Theme.muted).lineLimit(2)
                } else if card.pending {
                    Text("Queuing…").font(.caption).foregroundStyle(Theme.muted)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            if card.actionable {
                Button { onSteer(card) } label: {
                    Text("Steer now").font(.footnote.weight(.semibold)).foregroundStyle(Theme.ink)
                        .padding(.horizontal, 10).frame(minHeight: 32)
                        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 8))
                        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.line))
                }
                .buttonStyle(.plain)
                .frame(minHeight: 44)
                .accessibilityHint("Sends it into the turn in progress")
                Menu {
                    Button { onEdit(card) } label: { Label("Edit", systemImage: "pencil") }
                    Button(role: .destructive) { onDelete(card) } label: { Label("Delete", systemImage: "trash") }
                } label: {
                    Lucide(.ellipsis, size: 18, label: "More for this queued message", color: Theme.muted)
                        .frame(width: 44, height: 44)
                        .contentShape(Rectangle())
                }
            }
        }
        .padding(.leading, 12).padding(.trailing, card.actionable ? 0 : 12).padding(.vertical, card.actionable ? 0 : 10)
        .frame(minHeight: 48)
        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
        .accessibilityElement(children: .contain)
        .accessibilityLabel("Queued: \(card.text)")
    }
}

/// The question the agent is waiting on, every option written out (DESIGN.md §8.4's card, read-only).
/// Conductor answers questions only in its own window, so the card says where to answer rather than
/// offering taps that could not land. Agent text is plain text, never markdown.
struct QuestionCard: View {
    let question: PhoneSnapshot.Question
    let agentName: String

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            ForEach(Array(question.questions.enumerated()), id: \.offset) { _, prompt in
                VStack(alignment: .leading, spacing: 10) {
                    if let header = prompt.header, !header.isEmpty {
                        Text(header.uppercased()).font(.caption.weight(.semibold)).foregroundStyle(Theme.muted)
                    }
                    Text(prompt.question).font(.headline)
                    if prompt.multiSelect {
                        Text("Pick any").font(.footnote).foregroundStyle(Theme.muted)
                    }
                    ForEach(Array(prompt.options.enumerated()), id: \.offset) { _, option in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(option.label).font(.body.weight(.medium))
                            if let description = option.description, !description.isEmpty {
                                Text(description).font(.subheadline).foregroundStyle(Theme.muted)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 14).padding(.vertical, 11)
                        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 12))
                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
                        .accessibilityElement(children: .combine)
                    }
                }
            }
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Lucide(.info, size: 14, color: Theme.muted).accessibilityHidden(true)
                Text("\(agentName) asked this in Conductor. Answer it in Conductor on your Mac; this phone can't answer questions yet.")
                    .font(.footnote).foregroundStyle(Theme.muted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// What this phone sent (or a steer that landed in the turn): right-aligned, one muted delivery line.
struct SentBubble: View, Equatable {
    let text: String
    /// nil for a steer the Mac reported, which carries no time of its own.
    let date: Date?
    let line: String

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            HStack(spacing: 6) {
                Text("You").fontWeight(.semibold)
                if let date { Text(date.formatted(date: .omitted, time: .shortened)).foregroundStyle(Theme.muted).monospacedDigit() }
            }
            .font(.subheadline)
            Text(text)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
            // Exactly one muted line per message.
            Text(line).font(.footnote).foregroundStyle(Theme.muted).multilineTextAlignment(.trailing)
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("You\(date.map { ", \($0.formatted(date: .omitted, time: .shortened))" } ?? ""): \(text). \(line)")
    }
}

/// DESIGN.md §8.4: the question as a heading, each option a full-width row
/// with a letter chip. "recommended" is a word in muted — never a colour,
/// never pre-selected.
struct OptionsView: View {
    let choices: PhoneSnapshot.Choices
    let details: [String: String]
    let disabled: Bool
    let onPick: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if let question = choices.question {
                Text(question).font(.headline).padding(.top, 6).accessibilityAddTraits(.isHeader)
            }
            GlassGroup {
              VStack(alignment: .leading, spacing: 10) {
            ForEach(choices.options) { option in
                let split = Presentation.splitOption(option.title)
                let detail = split.detail ?? details[option.letter]
                let recommended = option.letter == choices.recommended
                Button { onPick(option.letter) } label: {
                    HStack(alignment: .top, spacing: 12) {
                        Text(option.letter).font(.body.weight(.bold)).frame(width: 32, height: 32)
                            .overlay(RoundedRectangle(cornerRadius: 6).stroke(Theme.lineStrong))
                        VStack(alignment: .leading, spacing: 2) {
                            Text(split.title).font(.body.weight(.semibold)).multilineTextAlignment(.leading)
                            if let detail {
                                Text(detail).font(.subheadline).foregroundStyle(Theme.muted).multilineTextAlignment(.leading).lineLimit(4)
                            }
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                        if recommended {
                            Text("recommended").font(.caption).foregroundStyle(Theme.muted)
                        }
                    }
                    .padding(12)
                    .frame(minHeight: 56)
                    .glassSurface(in: RoundedRectangle(cornerRadius: 12), interactive: !disabled)
                    .contentShape(RoundedRectangle(cornerRadius: 12))
                }
                .buttonStyle(.plain)
                .disabled(disabled)
                .opacity(disabled ? 0.55 : 1)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(option.letter): \(split.title)\(detail.map { ". \($0)" } ?? "")\(recommended ? ", recommended" : "")")
                .accessibilityHint("Sends \(option.letter) to your Mac")
                .accessibilityAddTraits(.isButton)
            }
              }
            }
        }
    }
}

/// The reply composer (§8.5): the target in the placeholder, Send the one
/// primary control, and the reason when this phone cannot reply.
///
/// While the agent works, a tap on Send queues the message behind the turn
/// and holding Send offers Steer now, which puts it into the turn instead.
/// Queue is the default because it never interrupts; steering is a
/// deliberate act, so it is never sticky and every message starts queued.
///
/// It takes plain values, not the session, so a streamed step never redraws the field being typed in.
struct Composer: View {
    @Environment(AppModel.self) private var model
    let key: String
    let label: String
    let agentName: String
    let working: Bool
    let block: String?
    @Binding var draft: String
    var composing: FocusState<Bool>.Binding

    init(session: PhoneSnapshot.Session, agentName: String, working: Bool, block: String?,
         draft: Binding<String>, composing: FocusState<Bool>.Binding) {
        key = session.key; label = session.label; self.agentName = agentName; self.working = working; self.block = block
        _draft = draft; self.composing = composing
    }

    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    /// The hold-to-steer hint shows until the first message sent mid-turn; nothing after.
    @AppStorage("squeak.queueSteerExplained") private var explained = false
    private var empty: Bool { draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    /// Always there: after a send the field clears and keeps focus, so the next message can be typed at once.
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .bottom, spacing: 10) {
                TextField("Reply to \(agentName)…", text: $draft, axis: .vertical)
                    .lineLimit(1...5)
                    .focused(composing)
                    .disabled(block != nil)
                    .padding(.horizontal, 14).padding(.vertical, 12)
                    .frame(minHeight: 44)
                    .glassSurface(in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.ink, lineWidth: 1.5).opacity(composing.wrappedValue ? 1 : 0))
                    .accessibilityLabel("Message for \(label)")
                sendButton
            }
            caption
        }
        .padding(.horizontal, 20).padding(.top, 8).padding(.bottom, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        // Opaque, so the conversation scrolling underneath never shows through the field or the caption.
        .background(Theme.bg.ignoresSafeArea(edges: .bottom))
    }

    private func send(_ mode: ReplyMode = .queue) {
        let text = draft
        // Clear at once and keep the keyboard up; hand the text back if nothing was sent (Face ID declined).
        draft = ""
        // Again on the next turn of the run loop: tapping Send commits whatever the keyboard
        // still holds (an autocorrection, an inline prediction, dictation), and that commit
        // writes the old text back into the field just after the clear above.
        DispatchQueue.main.async { draft = "" }
        composing.wrappedValue = true
        let wasWorking = working
        Task {
            // The session as it is now, not as this view last drew it.
            guard let session = model.snapshot?.session(key) else { draft = text; return }
            let started = await model.send(text, to: session, mode: wasWorking ? mode : .queue)
            if !started, draft.isEmpty { draft = text }
            if started, wasWorking { explained = true }
        }
    }

    private var sendDisabled: Bool { block != nil || empty }

    /// Send is the one primary control: the prominent glass button filled
    /// with duck on iOS 26 (§8.9, owner's decision), a flat duck fill before.
    /// Mid-turn it is a menu whose tap is Queue and whose hold is the choice.
    @ViewBuilder
    private var sendButton: some View {
        if working {
            Menu {
                Button { send(.steer) } label: {
                    Text("Steer now")
                    Text("Goes into the turn in progress")
                }
                Button { send(.queue) } label: {
                    Text("Queue")
                    Text("\(agentName) reads it after this turn")
                }
            } label: {
                sendFace
            } primaryAction: {
                send(.queue)
            }
            .menuStyle(.button)
            .modifier(SendFace(disabled: sendDisabled, reduceTransparency: reduceTransparency))
            .disabled(sendDisabled)
            .accessibilityLabel("Queue")
            .accessibilityHint("Holds your message until \(agentName) finishes this turn. Use the Steer now action to send it into the turn.")
            .accessibilityAction(named: "Steer now") { if !sendDisabled { send(.steer) } }
        } else {
            Button { send() } label: { sendFace }
                .modifier(SendFace(disabled: sendDisabled, reduceTransparency: reduceTransparency))
                .disabled(sendDisabled)
                .accessibilityLabel("Send")
        }
    }

    private var sendFace: some View {
        Lucide(.arrowUp, size: 20, color: sendDisabled ? Theme.muted : Theme.primaryText)
            .frame(width: glass ? 20 : 44, height: glass ? 24 : 44)
    }

    private var glass: Bool {
        if #available(iOS 26, *) { return !reduceTransparency }
        return false
    }

    /// One line at most, and none at all once you know how it works.
    @ViewBuilder
    private var caption: some View {
        if let block {
            Text(block).font(.footnote).foregroundStyle(Theme.muted)
        } else if working, !explained {
            Text("Send queues it after this turn. Hold to steer now.")
                .font(.footnote).foregroundStyle(Theme.muted)
        }
    }
}

/// The look of Send, shared by the plain button and the mid-turn menu.
private struct SendFace: ViewModifier {
    let disabled: Bool
    let reduceTransparency: Bool

    func body(content: Content) -> some View {
        if #available(iOS 26, *), !reduceTransparency {
            content
                .buttonStyle(.glassProminent)
                .buttonBorderShape(.roundedRectangle(radius: 12))
                .tint(Theme.primaryFill)
        } else {
            content
                .buttonStyle(.plain)
                .background(disabled ? Theme.surfaceRaised : Theme.primaryFill, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
        }
    }
}

/// Keeps the newest content in view as it grows (iOS 18); earlier, the view just grows downward.
private struct StickToBottom: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 18, *) {
            content.defaultScrollAnchor(.bottom, for: .initialOffset).defaultScrollAnchor(.bottom, for: .sizeChanges)
        } else {
            content
        }
    }
}

/// A working turn's steps: the newest six the snapshot carries, clipped, or the whole turn when it
/// is streamed live (verbose, "Show thinking live").
struct StepList: View {
    typealias Step = TurnStep
    let steps: [Step]
    let total: Int
    let live: Bool

    static func steps(session: PhoneSnapshot.Session, live: LiveTurn?) -> [Step] {
        if let live, !live.steps.isEmpty { return live.steps.map { Step(kind: $0.kind, text: $0.text) } }
        return (session.activity?.steps ?? []).map { Step(kind: $0.kind, text: $0.text) }
    }

    /// Steps opened to their full text, by position in the whole turn (stable as new steps arrive).
    @State private var expanded: Set<Int> = []
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if live {
                Text(total > steps.count ? "Live · the latest \(steps.count) of \(total) steps" : "Live · every step of this turn")
                    .font(.footnote).foregroundStyle(Theme.muted).padding(.bottom, 4)
            } else if total > steps.count {
                Text("The latest \(steps.count) of \(total) steps this turn")
                    .font(.footnote).foregroundStyle(Theme.muted).padding(.bottom, 4)
            }
            ForEach(Array(steps.enumerated()), id: \.offset) { offset, step in
                row(step, index: total - steps.count + offset)
            }
        }
    }

    /// One line per step, like a chat app's collapsed reasoning: icon, kind, first line. A step with
    /// more to say opens on a tap to its whole text.
    private func row(_ step: Step, index: Int) -> some View {
        let open = expanded.contains(index)
        let more = step.text.count > 60 || step.text.contains("\n")
        return Button {
            guard more else { return }
            withAnimation(reduceMotion ? nil : .spring(response: 0.32, dampingFraction: 0.88)) {
                if open { expanded.remove(index) } else { expanded.insert(index) }
            }
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                Lucide(icon(step.kind), size: 14, color: Theme.muted).frame(width: 18)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 4) {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(label(step.kind)).font(.subheadline.weight(.medium)).foregroundStyle(Theme.muted)
                        if !open {
                            Text(step.text.replacingOccurrences(of: "\n", with: " "))
                                .font(.subheadline).foregroundStyle(Theme.muted).italic(step.kind == "thinking")
                                .lineLimit(1).truncationMode(.tail)
                        }
                        Spacer(minLength: 0)
                        if more { Lucide(open ? .chevronUp : .chevronDown, size: 12, color: Theme.subtle) }
                    }
                    if open {
                        Text(step.text).font(.subheadline).foregroundStyle(Theme.ink).italic(step.kind == "thinking")
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .textSelection(.enabled)
                    }
                }
            }
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(label(step.kind)): \(step.text)")
        .accessibilityHint(more ? (open ? "Folds this step" : "Shows the whole step") : "")
    }

    private func icon(_ kind: String) -> LucideName { Self.icon(kind) }

    static func icon(_ kind: String) -> LucideName {
        switch kind {
        case "thinking": return .brain
        case "note": return .messageSquareText
        case "tool": return .terminal
        case "you": return .send
        default: return .users
        }
    }

    private func label(_ kind: String) -> String {
        switch kind {
        case "thinking": return "Thinking"
        case "note": return "Note"
        case "tool": return "Tool"
        case "you": return "You"
        default: return "Background worker"
        }
    }
}

#endif
