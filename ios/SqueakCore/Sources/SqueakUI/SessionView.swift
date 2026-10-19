#if os(iOS)
import SqueakCore
import SqueakIcons
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
        .onAppear { screen.report?("Session") }
        .onDisappear { screen.report?("Sessions") }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                Text(session?.conductorSessionId != nil ? "Conductor" : "On your Mac")
                    .font(.subheadline).foregroundStyle(Theme.muted)
            }
        }
    }

    @ViewBuilder
    private func content(_ session: PhoneSnapshot.Session) -> some View {
        let receipt = model.receipts[session.key].flatMap { $0.turnId == session.turnId ? $0 : nil }
        let delivered: Bool = { if case .sent = receipt?.kind { return true } else { return false } }()

        VStack(spacing: 0) {
            header(session)
            Picker("View", selection: $tab) {
                ForEach(Tab.allCases) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .padding(.horizontal, 20).padding(.bottom, 10)

            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if tab == .chat {
                        chat(session, receipt: receipt, sending: receipt?.kind == .sending)
                    } else {
                        ActivityView(session: session)
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
            Composer(session: session, receipt: receipt, delivered: delivered, draft: $draft, composing: $composing)
        }
    }

    private func header(_ session: PhoneSnapshot.Session) -> some View {
        let status = Presentation.status(session)
        return VStack(alignment: .leading, spacing: 4) {
            Text(Presentation.displayTitle(session)).font(.system(size: 28, weight: .bold)).fixedSize(horizontal: false, vertical: true)
            Text(Presentation.subtitle(session)).font(.body).foregroundStyle(Theme.muted)
            HStack(spacing: 7) {
                StatusDot(color: Theme.stateColor(session.state), pulses: session.needsYou || session.state == "working",
                          period: session.state == "working" ? 1.6 : 1.0)
                Text("\(session.stateWord) · \(Age.describe(session.lastActivityAt))").font(.subheadline).foregroundStyle(Theme.muted)
                if let git = session.git { Text("· \(git)").font(.footnote).foregroundStyle(Theme.muted).monospacedDigit() }
            }
            .padding(.top, 2)
            .accessibilityElement(children: .combine)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 20).padding(.top, 8).padding(.bottom, 14)
    }

    /* ---------- chat ---------- */

    @ViewBuilder
    private func chat(_ session: PhoneSnapshot.Session, receipt: AppModel.Receipt?, sending: Bool) -> some View {
        let sent = model.outbox[session.key] ?? []
        let earlier = sent.filter { $0.answersTurn != session.turnId || session.turnId == nil }
        let later = sent.filter { $0.answersTurn == session.turnId && session.turnId != nil }
        let text = session.message ?? session.detail
        let choices = session.state == "working" ? nil : session.choices
        let reading = Presentation.read(message: text ?? "", choices: choices)

        ForEach(earlier) { SentBubble(message: $0) }

        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 6) {
                Text(Presentation.agentName(session.agent)).font(.subheadline.weight(.semibold))
                Text(Age.clock(session.lastActivityAt)).font(.subheadline).foregroundStyle(Theme.muted).monospacedDigit()
            }
            .accessibilityElement(children: .combine)
            if text == nil && choices == nil {
                Text("Nothing to show yet.").foregroundStyle(Theme.muted)
            }
            if !reading.before.isEmpty { MessageText(paragraphs: reading.before) }
            if let choices {
                OptionsView(choices: choices, details: reading.details, disabled: Presentation.replyBlock(session) != nil || sending) { letter in
                    Task { await model.send(letter, to: session) }
                }
            }
            if !reading.after.isEmpty { MessageText(paragraphs: reading.after) }
        }

        ForEach(later) { SentBubble(message: $0) }
        if let receipt { ReceiptView(receipt: receipt) }
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
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("You, \(message.date.formatted(date: .omitted, time: .shortened)): \(message.text)")
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
struct Composer: View {
    @EnvironmentObject var model: AppModel
    let session: PhoneSnapshot.Session
    let receipt: AppModel.Receipt?
    let delivered: Bool
    @Binding var draft: String
    var composing: FocusState<Bool>.Binding

    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    private var block: String? { Presentation.replyBlock(session) }
    private var sending: Bool { receipt?.kind == .sending }
    private var empty: Bool { draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if delivered {
                if let receipt { ReceiptView(receipt: receipt) }
            } else {
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
        }
        .padding(.horizontal, 20).padding(.top, 10).padding(.bottom, 8)
        .frame(maxWidth: .infinity, alignment: .leading)

    }

    private func send() {
        let text = draft
        Task {
            await model.send(text, to: session)
            if case .sent = model.receipts[session.key]?.kind { draft = "" }
        }
    }

    private var sendDisabled: Bool { block != nil || empty || sending }

    /// Send is the one primary control: the prominent glass button filled
    /// with duck on iOS 26 (§8.9, owner's decision), a flat duck fill before.
    @ViewBuilder
    private var sendButton: some View {
        let arrow = Lucide(.arrowUp, size: 20, color: sendDisabled ? Theme.muted : Theme.primaryText).frame(width: 44, height: 44)
        if #available(iOS 26, *), !reduceTransparency {
            Button(action: send) { Lucide(.arrowUp, size: 20, color: sendDisabled ? Theme.muted : Theme.primaryText).frame(width: 20, height: 24) }
                .buttonStyle(.glassProminent)
                .buttonBorderShape(.roundedRectangle(radius: 12))
                .tint(Theme.primaryFill)
                .disabled(sendDisabled)
                .accessibilityLabel("Send")
        } else {
            Button(action: send) {
                arrow
                    .background(sendDisabled ? Theme.surfaceRaised : Theme.primaryFill, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
            }
            .disabled(sendDisabled)
            .accessibilityLabel("Send")
        }
    }

    @ViewBuilder
    private var caption: some View {
        if let block {
            Text(block).font(.footnote).foregroundStyle(Theme.muted)
        } else if let receipt, case let .refused(reason) = receipt.kind {
            Text(reason).font(.footnote).foregroundStyle(Theme.ink)
        } else if sending {
            Text("Sending…").font(.footnote).foregroundStyle(Theme.muted)
        } else {
            Text("Sent to your Mac securely.").font(.footnote).foregroundStyle(Theme.muted)
        }
    }
}

/// The steps the phone receives for a working turn (§ phone gets the newest
/// six, clipped), with an honest empty state.
struct ActivityView: View {
    let session: PhoneSnapshot.Session

    var body: some View {
        if session.state == "working", let activity = session.activity, !activity.steps.isEmpty {
            VStack(alignment: .leading, spacing: 14) {
                if activity.total > activity.steps.count {
                    Text("The latest \(activity.steps.count) of \(activity.total) steps this turn.")
                        .font(.footnote).foregroundStyle(Theme.muted)
                }
                ForEach(Array(activity.steps.enumerated()), id: \.offset) { _, step in
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

struct ReceiptView: View {
    let receipt: AppModel.Receipt

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            switch receipt.kind {
            case .sending:
                ProgressView(); Text("Sending…")
            case let .sent(text):
                Lucide(.check, size: 16, color: Theme.done); Text(text)
            case let .refused(reason):
                Lucide(.triangleAlert, size: 16, color: Theme.error); Text(reason)
            }
        }
        .font(.subheadline)
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.line))
        .accessibilityElement(children: .combine)
    }
}

/// The agent's markdown, inline formatting only, paragraphs kept. Links and
/// images become their words — a phone should not open agent-written URLs.
struct MessageText: View {
    let paragraphs: [String]
    init(text: String) { paragraphs = text.components(separatedBy: "\n\n").map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty } }
    init(paragraphs: [String]) { self.paragraphs = paragraphs }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(paragraphs.enumerated()), id: \.offset) { _, paragraph in
                if paragraph.hasPrefix("```") {
                    Text(paragraph.trimmingCharacters(in: CharacterSet(charactersIn: "`\n")))
                        .font(.system(.footnote, design: .monospaced))
                        .padding(10).frame(maxWidth: .infinity, alignment: .leading)
                        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 8))
                } else {
                    Text(attributed(paragraph)).fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .textSelection(.enabled)
    }

    private func attributed(_ paragraph: String) -> AttributedString {
        let plain = paragraph
            .replacingOccurrences(of: #"!\[([^\]]*)\]\([^)]*\)"#, with: "[image: $1]", options: .regularExpression)
            .replacingOccurrences(of: #"\[([^\]]+)\]\([^)]*\)"#, with: "$1", options: .regularExpression)
        var result = (try? AttributedString(markdown: plain, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)))
            ?? AttributedString(plain)
        for run in result.runs where run.link != nil { result[run.range].link = nil }
        return result
    }
}
#endif
