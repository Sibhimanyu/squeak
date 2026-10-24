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
    @State private var draft: String
    /// Photos picked for the next message; they go with it.
    @State private var photos: [ChatPhoto] = []
    init(key: String) {
        self.key = key
        let args = ProcessInfo.processInfo.arguments
        // `-squeak-demo-photos`: two photos waiting in the composer, for screenshots of the demo.
        if args.contains("-squeak-demo-photos") {
            _photos = State(initialValue: (0..<2).compactMap { i in
                let image = UIGraphicsImageRenderer(size: CGSize(width: 800, height: 600)).image { context in
                    UIColor(hue: 0.58 + 0.12 * CGFloat(i), saturation: 0.45, brightness: 0.55, alpha: 1).setFill()
                    context.fill(CGRect(x: 0, y: 0, width: 800, height: 600))
                    UIColor.white.withAlphaComponent(0.8).setFill()
                    context.fill(CGRect(x: 120, y: 160, width: 560, height: 60))
                    context.fill(CGRect(x: 120, y: 280, width: 360, height: 200))
                }
                return image.jpegData(compressionQuality: 0.7).flatMap(PhotoPrep.prepare)
            })
        }
        if args.contains("-squeak-demo"), let i = args.firstIndex(of: "-squeak-draft"), i + 1 < args.count {
            _draft = State(initialValue: args[i + 1])
        } else {
            _draft = State(initialValue: ReadingPlace.draft(for: key))
        }
    }
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

    private var session: PhoneSnapshot.Session? { model.session(key) }

    @Environment(\.squeakScreen) private var screen
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        Group {
            if let session {
                content(session)
            } else {
                // Only after the chat has been in neither list for longer than the Mac's two documents
                // ever disagree (`SeenSessions`): it really is gone, so leave a way out of the blank.
                VStack(spacing: 12) {
                    Text("This session is no longer on your Mac's list.").foregroundStyle(Theme.muted).multilineTextAlignment(.center)
                    Button("Back to sessions") { dismiss() }.buttonStyle(.bordered).tint(Theme.ink)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity).background(Theme.bg)
            }
        }
        // A chat has its composer at the bottom: the app's tab bar floats over it, so it steps aside.
        .toolbar(.hidden, for: .tabBar)
        .onAppear { screen.report?("Session"); model.watch(key); model.markSeen(key) }
        // Whatever it says while you are looking at it, you have read; and what it said when you leave.
        .onChange(of: session?.lastActivityAt) { _, _ in model.markSeen(key) }
        .onDisappear { model.markSeen(key) }
        // The agent you are watching finishes: one light tap, so you can look up from the keyboard.
        .onChange(of: session?.state) { old, new in
            guard old == "working", let new, new != "working" else { return }
            UINotificationFeedbackGenerator().notificationOccurred(new == "error" ? .error : .success)
        }
        .onDisappear { screen.report?("Sessions"); model.watch(nil) }
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .principal) {
                if let session { SessionHeader(session: session) }
            }
            // Rename: the Mac can rename a chat Conductor holds open.
            if let session {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        if session.conductorSessionId != nil, session.open != false {
                            Button("Rename", systemImage: "pencil") { model.renameTarget = session }
                        }
                        if session.conductorSessionId != nil, session.open != false, session.state != "working", !session.needsYou {
                            Button("Close in Conductor", systemImage: "xmark.circle", role: .destructive) { model.closeTarget = session }
                        }
                        Button("Hide on this iPhone", systemImage: "eye.slash") {
                            model.hideHere(session)
                            dismiss()
                        }
                    } label: { Lucide(.ellipsis, size: 20, label: "Chat options", color: Theme.muted) }
                }
            }
        }
    }

    private var live: LiveTurn? { model.verbose ? model.liveTurns[key] : nil }

    @ViewBuilder
    private func content(_ session: PhoneSnapshot.Session) -> some View {
        let live = live
        let sends = model.outbox[session.key] ?? []
        let rows = ChatTimeline.rows(session: session, remembered: model.remembered[session.key], sends: sends, live: live,
                                     cachedHistory: model.lastHistory[session.key])
        let cards = ChatQueue.cards(session: session, live: live, sends: sends, hidden: model.hiddenQueued)
        chatScroll(
            ChatRows(
                rows: rows, session: session, sending: model.isSending(session.key), stopping: model.isStopping(session.key),
                total: live?.working == true ? live?.total ?? 0 : session.activity?.total ?? 0, live: live?.working == true,
                stepsOpen: $stepsOpen, openParts: $openParts
            )
            .padding(.horizontal, 20).padding(.top, 16).padding(.bottom, 16)
            .frame(maxWidth: .infinity, alignment: .leading),
            sends: sends.count,
            arrivals: "\(rows.last?.id ?? "")|\(stepCount(rows))"
        )
        .onDisappear { ReadingPlace.save(row: nil, draft: draft, for: key) }
        // A new turn starts folded: what was opened for the last one is not opened for this.
        .onChange(of: session.turnId) { _, _ in openParts = [] }
        // A draft survives the app being closed from the background, not just going back.
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { ReadingPlace.save(row: nil, draft: draft, for: key) }
        }
        // A message that did not go through, taken back: its text returns to the field.
        .onChange(of: model.restoredDraft[key]) { _, text in
            guard let text else { return }
            draft = DraftPolicy.restoring(text, into: draft)
            composing = true
            model.draftRestored(for: key)
        }
        // Sending starts a fresh, folded working row.
        .onChange(of: sends.count) { _, _ in
            stepsOpen = false
            openParts = []
            ReadingPlace.save(row: nil, draft: draft, for: key)
        }
        .background(Theme.bg.ignoresSafeArea())
        .safeAreaInset(edge: .bottom, spacing: 0) {
            VStack(spacing: 0) {
                if session.state == "error" {
                    FailureNotice(reason: Presentation.failureReason(session), canReply: Presentation.replyBlock(session) == nil)
                }
                if let stalled = session.stalled, session.state == "working" {
                    StuckNotice(stalled: stalled, canStop: session.conductorSessionId != nil, stopping: model.isStopping(session.key)) {
                        Task { await model.stop(session) }
                    }
                }
                if !cards.isEmpty {
                    QueueStack(
                        cards: cards, agentName: Presentation.agentName(session.agent), problems: model.queueProblem,
                        onSteer: { card in Task { await model.steerQueued(card, in: session) } },
                        onEdit: { card in
                            Task {
                                guard let text = await model.removeQueued(card, in: session) else { return }
                                draft = DraftPolicy.restoring(text, into: draft)
                                composing = true
                            }
                        },
                        onDelete: { card in Task { await model.removeQueued(card, in: session) } }
                    )
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                }
                // A film's call is answered on its card; a chat box under it would only say it can't send.
                if session.workflow == nil {
                    if let line = model.pendingSetupLine(session) ?? session.setupLine {
                        SetupLine(session: session, line: line)
                    }
                    Composer(
                        session: session, agentName: Presentation.agentName(session.agent),
                        working: session.state == "working" && Presentation.replyBlock(session) == nil,
                        block: Presentation.replyBlock(session), stopping: model.isStopping(session.key),
                        draft: $draft, photos: $photos, composing: $composing
                    )
                }
            }
            .animation(reduceMotion ? nil : .easeOut(duration: 0.2), value: cards.map(\.id))
        }
    }

    /// The chat's scroll view: it opens at the newest message and follows what arrives while you are at the
    /// bottom (iOS 18's scroll APIs); on iOS 17 it opens at the bottom and the system keeps it there.
    @ViewBuilder
    private func chatScroll<Rows: View>(_ rows: Rows, sends: Int, arrivals: String) -> some View {
        if #available(iOS 18, *) {
            FollowingScroll(sends: sends, arrivals: arrivals) { rows }
        } else {
            ScrollView { rows }.defaultScrollAnchor(.bottom).scrollDismissesKeyboard(.interactively)
        }
    }

    private func stepCount(_ rows: [ChatTimeline.Row]) -> Int {
        guard case .working(_, let steps)? = rows.last else { return 0 }
        return steps.count * 1_000 + (steps.last?.text.count ?? 0) % 1_000
    }
}

private struct HoldChatScrollKey: EnvironmentKey {
    static let defaultValue: () -> Void = {}
}

extension EnvironmentValues {
    /// Stops the chat following its bottom: called before something above the end grows by a tap (an opened list
    /// of steps), so the header you tapped stays under your finger and the list opens downward.
    var holdChatScroll: () -> Void {
        get { self[HoldChatScrollKey.self] }
        set { self[HoldChatScrollKey.self] = newValue }
    }
}

/// A chat's scroll view, as chat apps do it (and as iOS 18 lets SwiftUI do it): it starts at the bottom and,
/// while it is at the bottom, stays pinned there as content grows. Scroll up to read and it lets go: a round
/// button takes you back down in one tap once you are more than a screenful's worth away (a "New" pill when
/// something arrived meanwhile), and it picks up again when you scroll back down or send.
///
/// What it avoids, each a source of the jitter this replaced: deciding "am I at the bottom" from a view
/// appearing and disappearing (it flipped as the chat grew), scrolling to the end on every streamed step,
/// and scrolling in animations that fight the content's own growth. `following` changes only while you
/// scroll; the chat growing never touches it.
@available(iOS 18, *)
private struct FollowingScroll<Content: View>: View {
    /// How many messages this phone has sent: a change is a send.
    let sends: Int
    /// What the end of the chat holds: a change is something arriving there.
    let arrivals: String
    @ViewBuilder var content: Content

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var position = ScrollPosition(edge: .bottom)
    @State private var following = true
    @State private var nearBottom = true
    /// A finger is on the scroll view or it is coasting from one. Not a scroll this view ran itself (`.animating`).
    @State private var dragging = false
    @State private var newBelow = false
    /// Far enough up that getting back down is a chore: the jump button shows.
    @State private var farFromBottom = false

    var body: some View {
        ScrollView { content.environment(\.holdChatScroll, { following = false }) }
            .scrollPosition($position)
            .defaultScrollAnchor(.bottom)
            // Growth keeps the bottom while following; reading further up it leaves your text where it is.
            .defaultScrollAnchor(following ? .bottom : .top, for: .sizeChanges)
            .scrollDismissesKeyboard(.interactively)
            .onScrollGeometryChange(for: Bool.self) { geometry in
                // Most of a screen below what you see: a little scroll to reread a line shows no button.
                geometry.contentSize.height - geometry.visibleRect.maxY > geometry.containerSize.height * 0.6
            } action: { _, far in
                farFromBottom = far
            }
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentSize.height - geometry.visibleRect.maxY < 32
            } action: { _, near in
                nearBottom = near
                if dragging { following = near }
                if near { newBelow = false }
            }
            // The chat opens before it is whole (the history and the work arrive a second later, above what is on
            // screen), and the keyboard and the queue change the room: while following, the bottom is re-taken
            // whenever the content or the room changes, so no late arrival can leave the chat on an old message.
            .onScrollGeometryChange(for: CGSize.self) { geometry in
                CGSize(width: geometry.containerSize.height, height: geometry.contentSize.height)
            } action: { _, _ in
                if following, !dragging { position.scrollTo(edge: .bottom) }
            }
            .onScrollPhaseChange { _, phase in
                dragging = phase == .tracking || phase == .interacting || phase == .decelerating
                if !dragging { following = nearBottom }
            }
            .onChange(of: arrivals) { _, _ in if !following { newBelow = true } }
            .onChange(of: sends) { _, _ in
                following = true
                newBelow = false
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.25)) { position.scrollTo(edge: .bottom) }
            }
            .overlay(alignment: .bottom) { jumpButton }
    }

    /// Back to the newest message in one tap: a round button, or a "New" pill when something arrived meanwhile.
    private var jumpButton: some View {
        ZStack {
                if !following, newBelow || farFromBottom {
                    Button {
                        newBelow = false
                        following = true
                        withAnimation(reduceMotion ? nil : .easeOut(duration: 0.25)) { position.scrollTo(edge: .bottom) }
                    } label: {
                        HStack(spacing: 6) {
                            Lucide(.chevronDown, size: 16, color: Theme.ink)
                            if newBelow { Text("New").font(.footnote.weight(.semibold)).foregroundStyle(Theme.ink) }
                        }
                        .padding(.horizontal, newBelow ? 14 : 0)
                        .frame(minWidth: 40, minHeight: 40)
                        .background(Theme.surfaceRaised, in: Capsule())
                        .overlay(Capsule().stroke(Theme.line))
                        .frame(minWidth: 44, minHeight: 44)
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .padding(.bottom, 8)
                    .accessibilityLabel(newBelow ? "New messages. Jump to the newest" : "Jump to the newest message")
                    .transition(.opacity.combined(with: .scale(scale: 0.9)))
                }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: !following && (newBelow || farFromBottom))
    }
}

/// An errored chat says so above the composer, with the agent's own reason when the Mac sent it,
/// and what to do next: the composer under it is the recovery.
private struct FailureNotice: View {
    let reason: String?
    let canReply: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            StatusDot(color: Theme.error).padding(.top, 6)
            VStack(alignment: .leading, spacing: 2) {
                Text("The last turn failed").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
                if let reason { Text(reason).font(.footnote).foregroundStyle(Theme.muted).lineLimit(3) }
                Text(canReply ? "Reply below to try again." : "Open it on your Mac to try again.")
                    .font(.footnote).foregroundStyle(Theme.muted)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
        .overlay(alignment: .leading) {
            Capsule().fill(Theme.error).frame(width: 3).padding(.vertical, 10).padding(.leading, 4).accessibilityHidden(true)
        }
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
        .padding(.horizontal, 16).padding(.bottom, 8)
        .accessibilityElement(children: .combine)
    }
}

/// A working chat with no word from the model for minutes: says what it waits on and for how long, and offers
/// Conductor's own Stop, after which a reply runs the turn again. The Mac decides it is stuck; this only draws it.
private struct StuckNotice: View {
    let stalled: PhoneSnapshot.Session.Stalled
    let canStop: Bool
    let stopping: Bool
    let stop: () -> Void

    var body: some View {
        TimelineView(.periodic(from: .now, by: 60)) { context in
            HStack(alignment: .center, spacing: 10) {
                StatusDot(color: Theme.needsYou)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Seems stuck").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
                    Text(stalled.line(now: context.date)).font(.footnote).foregroundStyle(Theme.muted).lineLimit(2)
                    Text(canStop ? "Stop it, then reply to run the turn again." : "Stop it on your Mac, then try again.")
                        .font(.footnote).foregroundStyle(Theme.muted)
                }
                Spacer(minLength: 0)
                if canStop {
                    Button(action: stop) {
                        if stopping { ProgressView().controlSize(.small) } else { Text("Stop").font(.subheadline.weight(.semibold)) }
                    }
                    .buttonStyle(.bordered).tint(Theme.ink)
                    .frame(minHeight: 44)
                    .disabled(stopping)
                    .accessibilityLabel(stopping ? "Stopping" : "Stop the agent")
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
            .overlay(alignment: .leading) {
                Capsule().fill(Theme.needsYou).frame(width: 3).padding(.vertical, 10).padding(.leading, 4).accessibilityHidden(true)
            }
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
            .padding(.horizontal, 16).padding(.bottom, 8)
        }
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
                StatusDot(color: session.needsYou ? Theme.needsYou : Theme.stateColor(session.state), pulses: session.needsYou || session.state == "working",
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
    let stopping: Bool
    let total: Int
    let live: Bool
    @Binding var stepsOpen: Bool
    @Binding var openParts: Set<String>
    @State private var showingDiff = ProcessInfo.processInfo.arguments.contains("-squeak-diff")

    var body: some View {
        // A pending question has its own card; letters read from the message would repeat it.
        let choices = session.state == "working" || session.question != nil || session.workflow != nil ? nil : session.choices
        let agentName = Presentation.agentName(session.agent)
        let blocked = Presentation.replyBlock(session) != nil
        let parted = rows.contains { if case .steer = $0 { true } else { false } }
        VStack(alignment: .leading, spacing: 16) {
            ForEach(rows) { row in
                switch row {
                case .sent(let message):
                    SentBubble(text: message.text, date: message.date, line: message.status.line, failed: message.status.failed)
                    if message.status.failed { FailedSendActions(sendId: message.id, session: session) }
                case .steer(_, let text, let line):
                    SentBubble(text: text, date: nil, line: line)
                case .agent(_, _, _) where session.workflow != nil && session.message == nil:
                    // A film's director has no chat message, only the one-line summary its card already says.
                    EmptyView()
                case .agent(let text, let atISO, let muted):
                    AgentMessage(
                        agentName: agentName, text: text, atISO: atISO, muted: muted,
                        choices: muted ? nil : choices, disabled: blocked || sending
                    ) { letter in
                        Task { await model.send(letter, to: session) }
                    }
                    .equatable()
                    // Images in the answer load from the Mac on a tap.
                    .environment(\.messageImage, { alt, source in AnyView(ChatImage(alt: alt, source: source, session: session)) })
                    // What the turn left on disk, a tap from its diff.
                    if !muted, session.state != "working", let git = session.git, session.conductorSessionId != nil {
                        Button { showingDiff = true } label: {
                            HStack(spacing: 6) {
                                Lucide(.gitBranch, size: 14, color: Theme.muted).accessibilityHidden(true)
                                Text(git).font(.subheadline).foregroundStyle(Theme.muted).monospacedDigit()
                                Lucide(.chevronRight, size: 12, color: Theme.subtle)
                            }
                            .frame(minHeight: 36).contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("What changed: \(git)")
                        .accessibilityHint("Shows the files and their changes")
                    }
                case .folded(let id, let steps):
                    FoldedSteps(steps: steps, open: Binding(
                        get: { openParts.contains(id) },
                        set: { if $0 { openParts.insert(id) } else { openParts.remove(id) } }))
                case .history(_, let fromUser, let text, let atISO):
                    if fromUser {
                        SentBubble(text: text, date: atISO.flatMap(Age.date), line: nil)
                    } else {
                        AgentMessage(agentName: agentName, text: text, atISO: atISO ?? "", muted: true, choices: nil, disabled: true) { _ in }
                            .equatable()
                    }
                case .worked(_, let steps):
                    HStack(spacing: 6) {
                        Lucide(.clipboardList, size: 14, color: Theme.muted).accessibilityHidden(true)
                        Text(steps == 1 ? "Worked · 1 step" : "Worked · \(steps) steps").font(.subheadline).foregroundStyle(Theme.muted)
                        Spacer(minLength: 0)
                    }
                    .frame(minHeight: 28)
                    .accessibilityElement(children: .combine)
                case .working(let label, let steps):
                    // After a steer the live part is its own count; "the latest 3 of 7" would count the folded parts too.
                    WorkingRow(agentName: agentName, label: stopping ? "Stopping…" : label, steps: steps, total: parted ? steps.count : total, live: live, open: $stepsOpen)
                        .transition(.opacity)
                case .empty(let text):
                    Text(text).foregroundStyle(Theme.muted)
                }
            }
            if let workflow = session.workflow {
                // A film's call has its own card; a question read from the director's transcript would repeat it.
                WorkflowCard(workflow: workflow, session: session)
            } else if session.state == "awaiting_input", let question = session.question {
                if let plan = question.plan {
                    PlanCard(plan: plan, agentName: agentName, session: session)
                } else {
                    QuestionCard(question: question, agentName: agentName, session: session)
                }
            }
        }
        .sheet(isPresented: $showingDiff) { DiffView(session: session) }
        // No implicit animation on rows arriving: in a chat pinned to its bottom, content that slides while the
        // scroll view is also adjusting itself put two lines of text on top of each other for a moment.
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
                    .accessibilityElement(children: .combine)
                Spacer(minLength: 4)
                // The whole message out of the phone in one tap; the text itself stays selectable.
                Menu {
                    Button { UIPasteboard.general.string = text } label: { Label("Copy", systemImage: "doc.on.doc") }
                    ShareLink(item: text) { Label("Share", systemImage: "square.and.arrow.up") }
                } label: {
                    Lucide(.ellipsis, size: 16, label: "More for this message", color: Theme.muted)
                        .frame(width: 44, height: 32).contentShape(Rectangle())
                }
            }
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
    @Environment(\.holdChatScroll) private var hold

    init(agentName: String, label: String, steps: [TurnStep] = [], total: Int = 0, live: Bool = false, open: Binding<Bool> = .constant(false)) {
        self.agentName = agentName; self.label = label; self.steps = steps; self.total = total; self.live = live; _open = open
    }

    static let boxLines = 3

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                hold()
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
            .disabled(steps.isEmpty && !open)
            .accessibilityLabel("\(agentName) is working: \(label)")
            .accessibilityHint(steps.isEmpty ? "" : open ? "Hides the steps" : "Shows the steps of this turn")
            if open, !steps.isEmpty {
                // Opened to read: thinking and notes whole, tool calls one line each.
                StepList(steps: steps, total: max(total, steps.count), live: live, readable: true)
                    .padding(.leading, 4)
                    .transition(.opacity)
                HideStepsButton { withAnimation(reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.86)) { open = false } }
            } else if !steps.isEmpty {
                // The box opens the turn too: it is what you see, so it is what you tap.
                Button {
                    hold()
                    withAnimation(reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.86)) { open = true }
                } label: {
                    LiveBox(steps: Array(steps.suffix(Self.boxLines)), first: max(total, steps.count) - min(steps.count, Self.boxLines))
                        .contentShape(RoundedRectangle(cornerRadius: 12))
                }
                .buttonStyle(.plain)
                .accessibilityHint("Shows every step of this turn, thinking included")
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
                // No transition: a step arriving crossfaded over the one it replaced, and for that moment two
                // lines of text sat on top of each other. The box is a ticker; it just updates.
                .id(first + offset)
            }
        }
        .frame(maxWidth: .infinity, minHeight: CGFloat(WorkingRow.boxLines) * 20, alignment: .bottomLeading)
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
        .clipShape(RoundedRectangle(cornerRadius: 12))
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
    @Environment(\.holdChatScroll) private var hold

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button {
                hold()
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
                StepList(steps: steps, total: steps.count, live: false, readable: true)
                    .padding(.leading, 4)
                    .transition(.opacity)
                HideStepsButton { withAnimation(reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.86)) { open = false } }
            }
        }
    }
}

/// The way back at the foot of an opened list of steps: the header that opened it can be far above by then.
private struct HideStepsButton: View {
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Lucide(.chevronUp, size: 12, color: Theme.muted)
                Text("Hide steps").font(.subheadline).foregroundStyle(Theme.muted)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Hide steps")
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
                } else if !card.actionable {
                    // Say why there is no Steer now / Edit / Delete, where they would be.
                    Text("Queued in Conductor · it can be changed from your Mac, not from here right now")
                        .font(.caption).foregroundStyle(Theme.muted).lineLimit(2)
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
/// A plan waiting on your approval (ExitPlanMode): the plan as a document, then Approve, or Ask for
/// changes with what to change. Either goes back through the same signed answer as a question.
struct PlanCard: View {
    let plan: String
    let agentName: String
    let session: PhoneSnapshot.Session
    @Environment(AppModel.self) private var model
    @State private var revising = false
    @State private var note = ""
    @State private var sending = false
    @State private var result: (delivered: Bool, line: String)?
    @FocusState private var noteFocused: Bool

    private var canAnswer: Bool { session.question?.toolUseId != nil && session.conductorSessionId != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("\(agentName)'s plan").font(.headline).accessibilityAddTraits(.isHeader)
            MessageText(markdown: plan, style: .squeak)
                .padding(14)
                .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
            if let result, result.delivered {
                Label { Text(result.line) } icon: { Lucide(.check, size: 14, color: Theme.muted) }
                    .font(.footnote).foregroundStyle(Theme.muted)
            } else if canAnswer {
                if revising {
                    TextField("What should change?", text: $note, axis: .vertical)
                        .lineLimit(2...6).focused($noteFocused)
                        .padding(.horizontal, 14).padding(.vertical, 12)
                        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 12))
                        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
                }
                HStack(spacing: 10) {
                    if revising {
                        Button("Cancel") { revising = false; note = "" }
                            .buttonStyle(.bordered).tint(Theme.muted).frame(minHeight: 44)
                        Button { send(approve: false) } label: {
                            Text(sending ? "Sending…" : "Send changes").frame(maxWidth: .infinity, minHeight: 44)
                        }
                        .buttonStyle(.borderedProminent).tint(Theme.primaryFill).foregroundStyle(Theme.primaryText)
                        .disabled(sending || note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                    } else {
                        Button { revising = true; noteFocused = true } label: {
                            Text("Ask for changes").frame(maxWidth: .infinity, minHeight: 44)
                        }
                        .buttonStyle(.bordered).tint(Theme.ink)
                        Button { send(approve: true) } label: {
                            Text(sending ? "Sending…" : "Approve").frame(maxWidth: .infinity, minHeight: 44)
                        }
                        .buttonStyle(.borderedProminent).tint(Theme.primaryFill).foregroundStyle(Theme.primaryText)
                        .disabled(sending)
                    }
                }
                if let result, !result.delivered, !result.line.isEmpty {
                    Text(result.line).font(.footnote).foregroundStyle(Theme.muted)
                }
            } else {
                Text("Approve this plan in Conductor on your Mac; update Squeak on your Mac to answer from here.")
                    .font(.footnote).foregroundStyle(Theme.muted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func send(approve: Bool) {
        sending = true
        let answer = AnswerCommand.PlanAnswer(approve: approve, note: approve ? nil : note.trimmingCharacters(in: .whitespacesAndNewlines))
        Task {
            let outcome = await model.answer(nil, plan: answer, to: session)
            sending = false
            result = outcome.delivered ? (true, approve ? "Approved" : "Sent back with your changes") : outcome
        }
    }
}

struct QuestionCard: View {
    let question: PhoneSnapshot.Question
    let agentName: String
    var session: PhoneSnapshot.Session? = nil
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// Picks per question, "Something else" text per question, and where the answer stands.
    @State private var picked: [Int: Set<String>] = [:]
    @State private var other: [Int: String] = [:]
    @State private var otherOpen: Set<Int> = []
    @State private var sending = false
    @State private var result: (delivered: Bool, line: String)?

    /// The Mac names the pending call only once it can take answers; until then the card is to read.
    private var canAnswer: Bool { question.toolUseId != nil && session?.conductorSessionId != nil }
    private var answered: Bool { result?.delivered == true }

    /// Every question has a pick or its own words (ANSWER-CARD).
    private var complete: Bool {
        question.questions.indices.allSatisfy { i in
            !(picked[i] ?? []).isEmpty || !(other[i] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            ForEach(Array(question.questions.enumerated()), id: \.offset) { index, prompt in
                VStack(alignment: .leading, spacing: 10) {
                    if let header = prompt.header, !header.isEmpty {
                        Text(header.uppercased()).font(.caption.weight(.semibold)).foregroundStyle(Theme.muted)
                    }
                    Text(prompt.question).font(.headline)
                    if prompt.multiSelect {
                        Text("Pick any").font(.footnote).foregroundStyle(Theme.muted)
                    }
                    ForEach(Array(prompt.options.enumerated()), id: \.offset) { _, option in
                        optionRow(option, prompt: prompt, index: index)
                    }
                    if canAnswer { otherRow(index) }
                }
            }
            footer
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .disabled(sending || answered)
    }

    private func optionRow(_ option: PhoneSnapshot.Question.Prompt.Option, prompt: PhoneSnapshot.Question.Prompt, index: Int) -> some View {
        let on = picked[index]?.contains(option.label) == true
        return Button {
            withAnimation(reduceMotion ? nil : .easeOut(duration: 0.15)) {
                var set = picked[index] ?? []
                if prompt.multiSelect {
                    if on { set.remove(option.label) } else { set.insert(option.label) }
                } else {
                    set = on ? [] : [option.label]
                    otherOpen.remove(index); other[index] = nil
                }
                picked[index] = set
            }
            UISelectionFeedbackGenerator().selectionChanged()
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                if canAnswer {
                    Lucide(on ? .circleCheck : .circle, size: 18,
                           color: on ? Theme.ink : Theme.subtle)
                        .accessibilityHidden(true)
                }
                VStack(alignment: .leading, spacing: 3) {
                    Text(option.label).font(.body.weight(.medium)).foregroundStyle(Theme.ink)
                    if let description = option.description, !description.isEmpty {
                        Text(description).font(.subheadline).foregroundStyle(Theme.muted)
                    }
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 14).padding(.vertical, 11)
            .background(on ? Theme.surfaceRaised : Theme.surface, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(on ? Theme.ink : Theme.line, lineWidth: on ? 1.5 : 1))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .allowsHitTesting(canAnswer)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(on ? [.isButton, .isSelected] : .isButton)
    }

    @ViewBuilder
    private func otherRow(_ index: Int) -> some View {
        if otherOpen.contains(index) {
            TextField("Your answer", text: Binding(get: { other[index] ?? "" }, set: { text in
                other[index] = text
                if !text.isEmpty, question.questions[index].multiSelect == false { picked[index] = [] }
            }), axis: .vertical)
            .lineLimit(1...4)
            .padding(.horizontal, 14).padding(.vertical, 11)
            .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
        } else {
            Button {
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.15)) { _ = otherOpen.insert(index) }
            } label: {
                Text("Something else…").font(.subheadline.weight(.medium)).foregroundStyle(Theme.muted)
                    .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
            }
            .buttonStyle(.plain)
        }
    }

    @ViewBuilder
    private var footer: some View {
        if canAnswer {
            VStack(alignment: .leading, spacing: 8) {
                if !answered {
                    Button {
                        guard let session else { return }
                        let answers = question.questions.indices.map { i in
                            AnswerCommand.Answer(
                                question: i, picked: Array(picked[i] ?? []).sorted(),
                                other: (other[i] ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? nil : other[i])
                        }
                        sending = true
                        Task {
                            let outcome = await model.answer(answers, to: session)
                            sending = false
                            if !outcome.line.isEmpty { result = outcome }
                        }
                    } label: {
                        HStack(spacing: 8) {
                            if sending { ProgressView().tint(Theme.primaryText) }
                            Text(sending ? "Sending…" : "Send answer").font(.body.weight(.semibold))
                        }
                        .foregroundStyle(complete ? Theme.primaryText : Theme.muted)
                        .frame(maxWidth: .infinity, minHeight: 48)
                        .background(complete ? Theme.primaryFill : Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 12))
                    }
                    .buttonStyle(.plain)
                    .disabled(!complete || sending)
                }
                if let result {
                    Text(result.line).font(.footnote).foregroundStyle(result.delivered ? Theme.muted : Theme.needsYou)
                } else {
                    Text("Goes to \(agentName) in Conductor. If Conductor can't take it directly, Squeak stops the question and sends your answer as a message.")
                        .font(.footnote).foregroundStyle(Theme.muted)
                }
            }
        } else {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Lucide(.info, size: 14, color: Theme.muted).accessibilityHidden(true)
                Text("\(agentName) asked this in Conductor. Answer it in Conductor on your Mac; this phone can answer once Squeak on your Mac is updated.")
                    .font(.footnote).foregroundStyle(Theme.muted)
            }
        }
    }
}

/// What this phone sent (or a steer that landed in the turn): right-aligned, one muted delivery line.
struct SentBubble: View, Equatable {
    let text: String
    /// nil for a steer the Mac reported, which carries no time of its own.
    let date: Date?
    /// nil for an earlier message from the chat's history: no delivery to report.
    let line: String?
    /// It did not go through (or cannot be vouched for): its line reads as a problem, not as a receipt.
    var failed = false

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            HStack(spacing: 6) {
                Text("You").fontWeight(.semibold)
                if let date { Text(date.formatted(date: .omitted, time: .shortened)).foregroundStyle(Theme.muted).monospacedDigit() }
            }
            .font(.subheadline)
            // Photos travel as `[Image: path]` lines in the text; here they are pills, and the words are the rest.
            let parts = PhotoAttachment.split(text)
            if !parts.body.isEmpty || parts.refs.isEmpty {
                Text(parts.body)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
                    .contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: 12))
                    .contextMenu {
                        Button { UIPasteboard.general.string = parts.body } label: { Label("Copy", systemImage: "doc.on.doc") }
                        ShareLink(item: parts.body) { Label("Share", systemImage: "square.and.arrow.up") }
                    }
            }
            if !parts.refs.isEmpty { PhotoPills(count: parts.refs.count) }
            // Exactly one muted line per message this phone sent.
            if let line { Text(line).font(.footnote).foregroundStyle(failed ? Theme.error : Theme.muted).multilineTextAlignment(.trailing) }
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("You\(date.map { ", \($0.formatted(date: .omitted, time: .shortened))" } ?? ""): \(text)\(line.map { ". \($0)" } ?? "")")
    }
}

/// What to do with a message that did not go through: send it again, or take its text back to edit.
/// Neither happens by itself: an unconfirmed message may be in the chat already.
struct FailedSendActions: View {
    @Environment(AppModel.self) private var model
    let sendId: UUID
    let session: PhoneSnapshot.Session

    var body: some View {
        HStack(spacing: 8) {
            Spacer(minLength: 0)
            Button("Edit") { model.edit(sendId, in: session) }
                .buttonStyle(.bordered)
            Button("Send again") { Task { await model.retry(sendId, in: session) } }
                .buttonStyle(.bordered)
                .fontWeight(.semibold)
        }
        .tint(Theme.ink)
        .font(.subheadline)
        .controlSize(.regular)
        .frame(minHeight: 44)
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
                Button { onPick(option.sent) } label: {
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
    /// A Stop was sent and the agent has not stopped yet.
    let stopping: Bool
    @Binding var draft: String
    /// Photos waiting to go with the next message.
    @Binding var photos: [ChatPhoto]
    var composing: FocusState<Bool>.Binding
    /// "Sending photo 1 of 2…" while they upload, and why one failed.
    @State private var uploading: String?
    @State private var uploadProblem: String?
    /// Bumped on each clear, so the field is rebuilt and cannot keep text of its own.
    @State private var generation = 0

    init(session: PhoneSnapshot.Session, agentName: String, working: Bool, block: String?, stopping: Bool = false,
         draft: Binding<String>, photos: Binding<[ChatPhoto]>, composing: FocusState<Bool>.Binding) {
        key = session.key; label = session.label; self.agentName = agentName; self.working = working; self.block = block
        self.stopping = stopping; _draft = draft; _photos = photos; self.composing = composing
    }

    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    /// The hold-to-steer hint shows until the first message sent mid-turn; nothing after.
    @AppStorage("squeak.queueSteerExplained") private var explained = false
    private var empty: Bool { draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && photos.isEmpty }

    /// One height for the field's single line and the button beside it, so they line up (the field grows
    /// upward with more lines; the button stays at its foot).
    static let control: CGFloat = 48

    /// Always there: after a send the field clears and keeps focus, so the next message can be typed at once.
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !photos.isEmpty { PhotoTray(photos: $photos, locked: uploading != nil) }
            HStack(alignment: .bottom, spacing: 6) {
                if block == nil, uploading == nil { AttachButton(photos: $photos, height: Self.control) }
                TextField("Reply to \(agentName)…", text: $draft, axis: .vertical)
                    .lineLimit(1...5)
                    .id(generation)
                    .focused(composing)
                    .disabled(block != nil)
                    .padding(.horizontal, 14).padding(.vertical, 12)
                    .frame(minHeight: Self.control)
                    .glassSurface(in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.ink, lineWidth: 1.5).opacity(composing.wrappedValue ? 1 : 0))
                    .accessibilityLabel("Message for \(label)")
                    .pasteImages(into: $photos, focused: composing.wrappedValue)
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
        let wasWorking = working
        // The box empties now, and the empty box is saved now: a send is accepted the moment it is tapped, and
        // neither a snapshot, leaving the chat nor the app being backgrounded (Face ID does that) may bring it back.
        clearBox()
        if !photos.isEmpty { sendWithPhotos(text, mode, wasWorking: wasWorking); return }
        Task {
            // The session as it is now, not as this view last drew it.
            guard let session = model.session(key) else { giveBack(text); return }
            let started = await model.send(text, to: session, mode: wasWorking ? mode : .queue)
            if !started { giveBack(text) }
            if started, wasWorking { explained = true }
        }
    }

    /// Empties the field for good. A vertical TextField that still holds the keyboard keeps its own copy of the
    /// text through a binding reset (tapping Send commits an autocorrection or dictation back into it), so the
    /// binding is cleared again on the next turn of the run loop and the field is rebuilt (`.id`), keeping focus.
    private func clearBox() {
        draft = ""
        ReadingPlace.save(row: nil, draft: "", for: key)
        generation += 1
        DispatchQueue.main.async {
            draft = ""
            composing.wrappedValue = true
        }
    }

    /// The send did not happen: the text goes back, so nothing is lost.
    private func giveBack(_ text: String) {
        draft = DraftPolicy.restoring(text, into: draft)
        generation += 1
    }

    /// The photos go to the Mac first, one by one; the message then names where each was saved. The text has
    /// already left the field; a failed upload gives it back and keeps the tray, so nothing is lost.
    private func sendWithPhotos(_ text: String, _ mode: ReplyMode, wasWorking: Bool) {
        let sending = photos
        uploadProblem = nil
        uploading = "Sending photo 1 of \(sending.count)…"
        Task {
            guard let session = model.session(key) else { uploading = nil; giveBack(text); return }
            let result = await model.upload(sending, to: .session(session)) { done, total in
                uploading = "Sending photo \(min(done + 1, total)) of \(total)…"
            }
            uploading = nil
            switch result {
            case .failed(let why):
                giveBack(text)
                uploadProblem = why
            case .saved(let refs):
                photos = []
                let message = PhotoAttachment.compose(text, refs: refs)
                let started = await model.send(message, to: session, mode: wasWorking ? mode : .queue)
                if !started {
                    giveBack(text)
                    uploadProblem = "The photos are on your Mac, but the message wasn't sent. Send it again."
                }
            }
        }
    }

    private var sendDisabled: Bool { block != nil || empty || uploading != nil }

    /// Send is the one primary control: the prominent glass button filled
    /// with duck on iOS 26 (§8.9, owner's decision), a flat duck fill before.
    /// Mid-turn it is a menu whose tap is Queue and whose hold is the choice.
    @ViewBuilder
    private var sendButton: some View {
        if working, empty {
            // Like any chat app: while the agent works and nothing is typed, the button stops it.
            Button {
                Task {
                    guard let session = model.session(key) else { return }
                    await model.stop(session)
                }
            } label: {
                RoundedRectangle(cornerRadius: 3).fill(stopping ? Theme.muted : Theme.needsYou)
                    .frame(width: 12, height: 12)
                    .frame(width: Self.control, height: Self.control)
                    .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
            }
            .buttonStyle(.plain)
            .disabled(stopping)
            .accessibilityLabel(stopping ? "Stopping" : "Stop \(agentName)")
            .accessibilityHint("Stops the turn in progress, as Stop does in Conductor")
        } else if working {
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
            // The glass button pads its label (about 11.5 by 6.5 points), so its label is smaller than the
            // button: together they make the same 48-point square as the field's height.
            .frame(width: glass ? Self.control - 23 : Self.control, height: glass ? Self.control - 13 : Self.control)
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
        } else if let uploading {
            HStack(spacing: 8) { ProgressView().controlSize(.small); Text(uploading).font(.footnote).foregroundStyle(Theme.muted) }
        } else if let uploadProblem {
            Text(uploadProblem).font(.footnote).foregroundStyle(Theme.error)
        } else if let problem = model.problemFor[key] {
            Text(problem).font(.footnote).foregroundStyle(Theme.muted)
        } else if working, !explained {
            Text("Send queues it · hold to steer · empty, it stops \(agentName)")
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

/// A working turn's steps: the newest six the snapshot carries, clipped, or the whole turn when it
/// is streamed live (verbose, "Show thinking live").
struct StepList: View {
    typealias Step = TurnStep
    let steps: [Step]
    let total: Int
    let live: Bool
    /// Opened from the working row to read the turn: thinking, notes and steers start whole, tool
    /// calls one line. Elsewhere every step starts as one line.
    var readable = false

    static func steps(session: PhoneSnapshot.Session, live: LiveTurn?) -> [Step] {
        if let live, !live.steps.isEmpty { return live.steps.map { Step(kind: $0.kind, text: $0.text) } }
        return (session.activity?.steps ?? []).map { Step(kind: $0.kind, text: $0.text) }
    }

    /// Steps tapped open (or, when `readable`, tapped shut), by position in the whole turn (stable as
    /// new steps arrive).
    @State private var toggled: Set<Int> = []

    private func startsOpen(_ step: Step) -> Bool { readable && (step.kind == "thinking" || step.kind == "note" || step.kind == "you") }
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
        let more = step.text.count > 60 || step.text.contains("\n")
        let open = more && startsOpen(step) != toggled.contains(index)
        return Button {
            guard more else { return }
            withAnimation(reduceMotion ? nil : .spring(response: 0.32, dampingFraction: 0.88)) {
                if toggled.contains(index) { toggled.remove(index) } else { toggled.insert(index) }
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
                        // Not selectable in place: selectable text takes the taps, so an opened step could not be
                        // folded by touching its text. Copy and Share are on a long press of the row.
                        Text(step.text).font(.subheadline).foregroundStyle(Theme.ink).italic(step.kind == "thinking")
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            .padding(.vertical, 6)
            .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button { UIPasteboard.general.string = step.text } label: { Label("Copy", systemImage: "doc.on.doc") }
            ShareLink(item: step.text) { Label("Share", systemImage: "square.and.arrow.up") }
        }
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

/// Where you were in each chat, and what you had typed: kept when you go back to the list, and the
/// drafts across launches. Local to this phone; nothing here is sent anywhere.
@MainActor
enum ReadingPlace {
    private static var rows: [String: String] = [:]
    private static let drafts = DraftStore()

    static func row(for key: String) -> String? { rows[key] }

    static func draft(for key: String) -> String { drafts.draft(for: key) }

    static func save(row: String?, draft: String, for key: String) {
        rows[key] = row
        drafts.save(draft, for: key)
    }
}


/// The chat's model and thinking level, as the Mac names them: muted, no state colour. Where the Mac can change
/// them it is a menu: the models it offers for this chat's own agent, the chosen model's thinking levels and fast
/// mode, each applied as it is picked, the way Conductor's own picker works. Not while a turn runs.
private struct SetupLine: View {
    @Environment(AppModel.self) private var model
    let session: PhoneSnapshot.Session
    let line: String

    /// Mid-turn, working or waiting on you: the Mac refuses a change until the turn ends.
    private var midTurn: Bool { ["working", "awaiting_approval", "awaiting_input"].contains(session.state) }

    var body: some View {
        let models = model.setupModels(for: session)
        let current = models.first { $0.id == session.modelId }
        Group {
            if models.isEmpty {
                label(changeable: false)
            } else {
                Menu {
                    Section("Model") {
                        ForEach(models) { option in
                            Button { pick(option, thinking: nil, fast: nil) } label: {
                                if option.id == session.modelId { Label(option.label, systemImage: "checkmark") } else { Text(option.label) }
                            }
                        }
                    }
                    if let current, !current.levels.isEmpty {
                        Section("Thinking") {
                            ForEach(current.levels, id: \.self) { level in
                                Button { pick(current, thinking: level, fast: nil) } label: {
                                    let name = Self.levelName(level)
                                    if level == session.effortId { Label(name, systemImage: "checkmark") } else { Text(name) }
                                }
                            }
                        }
                    }
                    if let current, session.agent == "claude" {
                        Section {
                            Button { pick(current, thinking: nil, fast: session.fast != true) } label: {
                                if session.fast == true { Label("Fast mode", systemImage: "checkmark") } else { Text("Fast mode") }
                            }
                        }
                    }
                } label: {
                    label(changeable: true)
                }
                .disabled(midTurn)
            }
        }
        .padding(.horizontal, 20).padding(.top, 6)
        .accessibilityIdentifier("chat-setup")
    }

    private func label(changeable: Bool) -> some View {
        HStack(spacing: 4) {
            Text(line).font(.caption).foregroundStyle(Theme.muted).lineLimit(1).truncationMode(.tail)
            if changeable && !midTurn {
                Image(systemName: "chevron.up.chevron.down").font(.caption2.weight(.semibold)).foregroundStyle(Theme.muted)
                    .accessibilityHidden(true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .frame(minHeight: changeable ? 28 : nil)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(session.setupAccessibilityLabel ?? line)
        .accessibilityHint(changeable ? (midTurn ? "Can be changed once this turn ends." : "Changes the model or thinking level.") : "")
    }

    private func pick(_ option: PhoneSnapshot.ChatModel, thinking: String?, fast: Bool?) {
        Task { await model.changeSetup(session, model: option, thinking: thinking, fast: fast) }
    }

    private static func levelName(_ level: String) -> String {
        let words = ChatPresets.levelName(level)
        return words.prefix(1).uppercased() + words.dropFirst()
    }
}
#endif
