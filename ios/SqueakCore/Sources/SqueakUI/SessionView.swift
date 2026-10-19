#if os(iOS)
import SqueakCore
import SqueakIcons
import SqueakMarkup
import SwiftUI

/// One session: the agent's latest message, its options as cards, what this
/// phone sent, the steps of a working turn, and the reply composer
/// (DESIGN.md §8.4 and §8.5). The phone shows only what the Mac sends it.
struct SessionView: View {
    @EnvironmentObject var model: AppModel
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let key: String
    @State private var draft: String = {
        let args = ProcessInfo.processInfo.arguments
        if args.contains("-squeak-demo"), let i = args.firstIndex(of: "-squeak-draft"), i + 1 < args.count { return args[i + 1] }
        return ""
    }()
    @FocusState private var composing: Bool
    @State private var tab: Tab = {
        let args = ProcessInfo.processInfo.arguments
        if let i = args.firstIndex(of: "-squeak-tab"), i + 1 < args.count, args[i + 1] == "activity" { return .activity }
        return .chat
    }()

    enum Tab: String, CaseIterable, Identifiable {
        case chat = "Chat", activity = "Activity"
        var id: String { rawValue }
    }

    private var session: PhoneSnapshot.Session? { model.snapshot?.sessions.first { $0.key == key } }

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
                if let session { header(session) }
            }
        }
    }

    @ViewBuilder
    private func content(_ session: PhoneSnapshot.Session) -> some View {
        VStack(spacing: 0) {
            Picker("View", selection: $tab) {
                ForEach(Tab.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .controlSize(.small)
            .frame(maxWidth: 220)
            .padding(.top, 2).padding(.bottom, 6)

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if tab == .chat {
                        chat(session, sending: model.isSending(session.key))
                    } else {
                        ActivityView(session: session, live: model.verbose ? model.liveTurns[session.key] : nil)
                    }
                }
                .padding(.horizontal, 20).padding(.vertical, 16)
                .frame(maxWidth: .infinity, alignment: .leading)
                .transition(.opacity)
            }
            .animation(reduceMotion ? nil : .spring(response: 0.38, dampingFraction: 0.86), value: tab)
            .scrollDismissesKeyboard(.interactively)
        }
        .background(Theme.bg.ignoresSafeArea())
        .safeAreaInset(edge: .bottom, spacing: 0) {
            Composer(session: session, draft: $draft, composing: $composing)
        }
    }

    /// The header lives in the navigation bar, two lines: the chat's title, then
    /// its state with as much context (age, repo, agent, diff) as the width
    /// allows. The chat is what this screen is for, so it gets the room.
    private func header(_ session: PhoneSnapshot.Session) -> some View {
        let state = "\(session.stateWord) · \(Age.describe(session.lastActivityAt))"
        let subtitle = Presentation.subtitle(session)
        let lines = [
            [state, subtitle, session.git].compactMap { $0 },
            [state, subtitle],
            [state],
        ].map { $0.joined(separator: " · ") }
        return VStack(spacing: 1) {
            Text(Presentation.displayTitle(session))
                .font(.headline).lineLimit(1).truncationMode(.tail)
            HStack(spacing: 5) {
                StatusDot(color: Theme.stateColor(session.state), pulses: session.needsYou || session.state == "working",
                          period: session.state == "working" ? 1.6 : 1.0)
                ViewThatFits(in: .horizontal) {
                    ForEach(lines, id: \.self) { Text($0).lineLimit(1) }
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

    /* ---------- chat ---------- */

    @ViewBuilder
    private func chat(_ session: PhoneSnapshot.Session, sending: Bool) -> some View {
        let rows = ChatTimeline.rows(session: session, remembered: model.remembered[session.key], sends: model.outbox[session.key] ?? [])
        let choices = session.state == "working" ? nil : session.choices

        VStack(alignment: .leading, spacing: 16) {
            ForEach(rows) { row in
                switch row {
                case .sent(let message):
                    SentBubble(message: message)
                case .agent(let text, let atISO, let muted):
                    agentMessage(session, text: text, atISO: atISO, muted: muted, choices: choices, sending: sending)
                case .working(let label):
                    WorkingRow(agentName: Presentation.agentName(session.agent), label: label)
                        .transition(.opacity)
                case .empty(let text):
                    Text(text).foregroundStyle(Theme.muted)
                }
            }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.25), value: rows.map(\.id))
    }

    private func agentMessage(_ session: PhoneSnapshot.Session, text: String, atISO: String, muted: Bool, choices: PhoneSnapshot.Choices?, sending: Bool) -> some View {
        let reading = Presentation.read(message: text, choices: muted ? nil : choices)
        return VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Text(Presentation.agentName(session.agent)).font(.subheadline.weight(.semibold))
                Text(Age.clock(atISO)).font(.subheadline).foregroundStyle(Theme.muted).monospacedDigit()
            }
            .accessibilityElement(children: .combine)
            if !reading.before.isEmpty { MessageText(markdown: reading.before.joined(separator: "\n\n"), style: .squeak) }
            if let choices, !muted {
                OptionsView(choices: choices, details: reading.details, disabled: Presentation.replyBlock(session) != nil || sending) { letter in
                    Task { await model.send(letter, to: session) }
                }
            }
            if !reading.after.isEmpty { MessageText(markdown: reading.after.joined(separator: "\n\n"), style: .squeak) }
        }
        .opacity(muted ? 0.62 : 1)
        .accessibilityLabel(muted ? "Previous message" : "")
    }
}

/// The agent at work, under what you sent: its name, a pulsing dot (still under Reduce Motion) and the
/// live step ("Running tests…", "Starting…" before the first). The colour is the working state's (§3.3).
struct WorkingRow: View {
    let agentName: String
    let label: String

    var body: some View {
        HStack(spacing: 8) {
            StatusDot(color: Theme.working, pulses: true, period: 1.6)
            Text(agentName).font(.subheadline.weight(.semibold))
            Text("·").foregroundStyle(Theme.subtle)
            Text(label).font(.subheadline).foregroundStyle(Theme.muted).lineLimit(1)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("\(agentName) is working: \(label)")
    }
}

/// What this phone sent: right-aligned, local only.
struct SentBubble: View {
    let message: AppModel.SentMessage

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            HStack(spacing: 6) {
                Text("You").fontWeight(.semibold)
                Text(message.date.formatted(date: .omitted, time: .shortened)).foregroundStyle(Theme.muted).monospacedDigit()
            }
            .font(.subheadline)
            Text(message.text)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
            status
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("You, \(message.date.formatted(date: .omitted, time: .shortened)): \(message.text). \(statusWord)")
    }
}

extension SentBubble {
    fileprivate var statusWord: String { message.status.line }

    /// Exactly one muted line per message.
    fileprivate var status: some View {
        Text(message.status.line).font(.footnote).foregroundStyle(Theme.muted).multilineTextAlignment(.trailing)
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
struct Composer: View {
    @EnvironmentObject var model: AppModel
    let session: PhoneSnapshot.Session
    @Binding var draft: String
    var composing: FocusState<Bool>.Binding

    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    /// The hold-to-steer hint shows until the first message sent mid-turn; nothing after.
    @AppStorage("squeak.queueSteerExplained") private var explained = false
    private var working: Bool { session.state == "working" && block == nil }
    private var agentName: String { Presentation.agentName(session.agent) }
    private var block: String? { Presentation.replyBlock(session) }
    private var empty: Bool { draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    /// Always there: after a send the field clears and keeps focus, so the next message can be typed at once.
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .bottom, spacing: 10) {
                TextField("Reply to \(Presentation.agentName(session.agent))…", text: $draft, axis: .vertical)
                    .lineLimit(1...5)
                    .focused(composing)
                    .disabled(block != nil)
                    .padding(.horizontal, 14).padding(.vertical, 12)
                    .frame(minHeight: 44)
                    .glassSurface(in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.ink, lineWidth: 1.5).opacity(composing.wrappedValue ? 1 : 0))
                    .accessibilityLabel("Message for \(session.label)")
                sendButton
            }
            caption
        }
        .padding(.horizontal, 20).padding(.top, 8).padding(.bottom, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func send(_ mode: ReplyMode = .queue) {
        let text = draft
        // Clear at once and keep the keyboard up; hand the text back if nothing was sent (Face ID declined).
        draft = ""
        composing.wrappedValue = true
        let wasWorking = working
        Task {
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

/// The steps the phone receives for a working turn (§ phone gets the newest
/// six, clipped), with an honest empty state.
struct ActivityView: View {
    let session: PhoneSnapshot.Session
    /// The whole turn, in verbose mode ("Show thinking live"); else the snapshot's newest six steps.
    var live: LiveTurn? = nil

    private var steps: [(kind: String, text: String)] {
        if let live, !live.steps.isEmpty { return live.steps.map { ($0.kind, $0.text) } }
        return (session.activity?.steps ?? []).map { ($0.kind, $0.text) }
    }

    private var total: Int { live.map(\.total) ?? session.activity?.total ?? 0 }

    var body: some View {
        if session.state == "working" || live?.working == true, !steps.isEmpty {
            VStack(alignment: .leading, spacing: 14) {
                if live != nil {
                    Text(total > steps.count ? "Live · the latest \(steps.count) of \(total) steps." : "Live · every step of this turn.")
                        .font(.footnote).foregroundStyle(Theme.muted)
                } else if total > steps.count {
                    Text("The latest \(steps.count) of \(total) steps this turn.")
                        .font(.footnote).foregroundStyle(Theme.muted)
                }
                ForEach(Array(steps.enumerated()), id: \.offset) { _, step in
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        Lucide(icon(step.kind), size: 16, color: Theme.muted).frame(width: 22)
                            .accessibilityHidden(true)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(label(step.kind)).font(.caption).foregroundStyle(Theme.muted)
                            Text(step.text).font(.body).italic(step.kind == "thinking")
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        } else {
            ContentUnavailableView {
                Label {
                    Text(session.state == "working" ? "No steps from your Mac" : "Nothing in progress")
                } icon: {
                    Lucide(.list, size: 28, color: Theme.muted)
                }
            } description: {
                Text(session.state == "working"
                    ? "This session is working, but your Mac didn't send its steps."
                    : "Steps appear here while the session is working.")
            }
        }
    }

    private func icon(_ kind: String) -> LucideName {
        switch kind {
        case "thinking": return .brain
        case "note": return .messageSquareText
        case "tool": return .terminal
        default: return .users
        }
    }

    private func label(_ kind: String) -> String {
        switch kind {
        case "thinking": return "Thinking"
        case "note": return "Note"
        case "tool": return "Tool"
        default: return "Background worker"
        }
    }
}

#endif
