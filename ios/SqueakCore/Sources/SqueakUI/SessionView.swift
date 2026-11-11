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
    /// The chat's timeline as the screen holds it: opened from the last visit, then changed in one batched swap.
    @State private var timeline = ChatTimelineStore()
    /// The messages mount a moment after the screen does, so the push starts on the tap with only the header, the
    /// skeleton and the composer to lay out; `RowWindow` then mounts the newest rows and older ones as the reader
    /// nears the top. Both are per visit: each chat opened is a new `SessionView`.
    #if DEBUG
    @State private var mounted = ProcessInfo.processInfo.arguments.contains("-squeak-old-open")
    #else
    @State private var mounted = false
    #endif
    @State private var window = RowWindow()

    var body: some View {
        #if DEBUG
        let _ = OpenProbe.mark("body")
        #endif
        Group {
            if let session {
                content(session)
            } else {
                // Only after the chat has been in neither list for longer than the Mac's two documents
                // ever disagree (`SeenSessions`): it really is gone, so leave a way out of the blank.
                VStack(spacing: 12) {
                    Text("This session is no longer on your Mac's list.").foregroundStyle(Theme.muted).multilineTextAlignment(.center)
                    Button("Back to sessions") { Haptics.play(.tap); dismiss() }.buttonStyle(.bordered).tint(Theme.ink)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity).background(Theme.bg)
            }
        }
        // A chat has its composer at the bottom: the app's tab bar floats over it, so it steps aside.
        .toolbar(.hidden, for: .tabBar)
        .onAppear {
            #if DEBUG
            OpenProbe.mark("appear")
            #endif
            screen.report?("Session"); model.watch(key); model.markSeen(key)
        }
        // Whatever it says while you are looking at it, you have read; and what it said when you leave.
        .onChange(of: session?.lastActivityAt) { _, _ in model.markSeen(key) }
        .onDisappear { model.markSeen(key) }
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
                        if model.workspaceActions, session.conductorSessionId != nil, session.workspaceId != nil {
                            let resting = !["working", "awaiting_approval", "awaiting_input"].contains(session.state)
                            Section("Workspace") {
                                Button("Open a pull request", systemImage: "arrow.triangle.pull") {
                                    Task { await model.askForPullRequest(session) }
                                }
                                .disabled(!resting)
                                Button("Archive workspace", systemImage: "archivebox", role: .destructive) { model.archiveTarget = session }
                                    .disabled(!resting)
                            }
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
        let input = TimelineInput(session: session, remembered: model.remembered[session.key], sends: sends, live: live,
                                  cachedHistory: model.lastHistory[session.key], offset: model.clockSkew.offset)
        // What was on screen last time is the first frame; nothing is drawn row by row as data arrives.
        let frame = timeline.frame ?? model.cachedFrame(session.key)
        let all = frame?.rows ?? []
        let hidden = mounted ? window.hidden(all) : 0
        let rows = mounted ? Array(window.slice(all)) : []
        #if DEBUG
        let _ = OpenProbe.mark(frame == nil || !mounted ? "content (skeleton)" : "content (\(rows.count) of \(all.count) rows)")
        #endif
        let cards = ChatQueue.cards(session: session, live: live, sends: sends, hidden: model.hiddenQueued)
        chatScroll(
            Group {
                if let frame, mounted {
                    ChatRows(
                        rows: rows, session: frame.session, sending: model.isSending(session.key), stopping: model.isStopping(session.key),
                        total: frame.total, live: frame.live,
                        // Asking the Mac for earlier messages waits until the ones already held are all mounted.
                        earlier: hidden > 0 ? .none : model.earlierRow(for: frame.session),
                        stepsOpen: $stepsOpen, openParts: $openParts
                    )
                } else {
                    ChatSkeleton()
                }
            }
            .padding(.horizontal, 20).padding(.top, 16).padding(.bottom, 16)
            .frame(maxWidth: .infinity, alignment: .leading),
            sends: sends.count, ready: frame != nil && mounted,
            arrivals: "\(all.last?.id ?? "")|\(stepCount(all))",
            top: PrependAnchor.topID(rows), ids: rows.map(\.id), prepended: model.justPrepended(session.key),
            layoutToken: timeline.swaps, hiddenAbove: hidden,
            onNearTop: { window.grow(all) },
            onPull: { await model.loadEarlier(session, manual: true) }
        )
        // The first look: a beat after the push has begun, then the rows (and the build of them, when the chat has
        // no frame yet) arrive.
        .task {
            await Task.yield()
            try? await Task.sleep(for: .milliseconds(80))
            mounted = true
        }
        .onChange(of: mounted && frame != nil) { _, ready in if ready { window.place(all) } }
        .onChange(of: timeline.swaps) { _, _ in window.replaceIfLost(all) }
        .onChange(of: input, initial: true) { _, new in if mounted { feed(new) } }
        .onChange(of: mounted) { _, _ in
            if !window.placed, frame != nil { window.place(all) }
            feed(input)
        }
        .onDisappear { ReadingPlace.save(row: nil, draft: draft, for: key) }
        .sheet(item: Binding(get: { model.subagent?.key == session.key ? model.subagent : nil },
                             set: { if $0 == nil { model.closeSubagent() } })) { watch in
            SubagentSheet(watch: watch, unavailable: model.subagentUnavailable(session)) { model.closeSubagent() }
        }
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
            BottomStack {
                if session.state == "error" {
                    FailureNotice(reason: Presentation.failureReason(session), canReply: Presentation.replyBlock(session) == nil)
                }
                if let tasks = session.background, !tasks.isEmpty, session.state == "working" {
                    BackgroundStrip(tasks: tasks, onOpen: { model.openSubagent($0, in: session) })
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
                }
                // A film's call is answered on its card; a chat box under it would only say it can't send.
                if session.workflow == nil {
                    Composer(
                        session: session, agentName: Presentation.agentName(session.agent),
                        working: session.state == "working" && Presentation.replyBlock(session) == nil,
                        block: Presentation.replyBlock(session), stopping: model.isStopping(session.key),
                        draft: $draft, photos: $photos, composing: $composing
                    )
                }
            }
            // No animation on the queue arriving: it lands with the rest of what the chat opens with, and a card
            // sliding in under a settling list moves the bottom the reader is anchored on.
        }
    }

    /// The chat's scroll view: it opens at the newest message and follows what arrives while you are at the
    /// bottom (iOS 18's scroll APIs); on iOS 17 it opens at the bottom and the system keeps it there.
    @ViewBuilder
    private func chatScroll<Rows: View>(
        _ rows: Rows, sends: Int, ready: Bool, arrivals: String, top: String?, ids: [String], prepended: Bool, layoutToken: Int,
        hiddenAbove: Int, onNearTop: @escaping () -> Void,
        onPull: @escaping () async -> Void
    ) -> some View {
        if #available(iOS 18, *) {
            FollowingScroll(sends: sends, ready: ready, arrivals: arrivals, top: top, ids: ids, prepended: prepended, layoutToken: layoutToken, hiddenAbove: hiddenAbove, onNearTop: onNearTop, onPull: onPull) { rows }
        } else {
            ScrollView { rows.environment(\.chatSettle, ChatSettleSignal(epoch: layoutToken)) }.defaultScrollAnchor(.bottom).scrollDismissesKeyboard(.interactively).refreshable { await onPull() }
        }
    }

    /// Hands the timeline the newest inputs; the frame it builds is kept for the next visit.
    private func feed(_ new: TimelineInput) {
        timeline.onFrame = { [model] in model.keepFrame($0, for: new.session.key) }
        timeline.submit(new, seed: model.cachedFrame(new.session.key))
    }

    private func stepCount(_ rows: [ChatTimeline.Row]) -> Int {
        guard case .working(_, let steps)? = rows.last else { return 0 }
        return steps.count * 1_000 + (steps.last?.text.count ?? 0) % 1_000
    }
}

/// What sits under the chat (notices, queue, background work, setup line, composer). At large text sizes it would
/// fill most of the screen and truncate, so from `.xxLarge` up its height is capped at 40% of the screen and it
/// scrolls; at the normal sizes it is the plain stack it always was.
private struct BottomStack<Content: View>: View {
    @ViewBuilder var content: Content
    @Environment(\.dynamicTypeSize) private var size
    @State private var measured: CGFloat = 0

    var body: some View {
        if size >= .xxLarge {
            ScrollView {
                VStack(spacing: 0) { content }
                    .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { measured = $0 }
            }
            .scrollBounceBehavior(.basedOnSize)
            .frame(height: min(measured, BottomStack.cap))
        } else {
            VStack(spacing: 0) { content }
        }
    }

    static var cap: CGFloat { UIScreen.main.bounds.height * 0.4 }
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

private final class BottomGap { var gap = 0.0 }

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
    /// The chat has a frame of rows (cached or built): the settle clock starts.
    let ready: Bool
    /// What the end of the chat holds: a change is something arriving there.
    let arrivals: String
    /// The first message row's id, every row's id, and whether older messages just landed above: the reader's
    /// place is kept by scrolling back to the row that was first (`PrependAnchor`).
    let top: String?
    let ids: [String]
    let prepended: Bool
    /// Moves when the timeline swapped in new rows: the controls inside settle again (`SettleGuard`).
    let layoutToken: Int
    /// Rows held but not mounted above the first one, and the call that mounts the next batch (`RowWindow`).
    let hiddenAbove: Int
    let onNearTop: () -> Void
    /// Pull down at the top: ask for earlier messages.
    let onPull: () async -> Void
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
    /// Moves whenever the layout does (new rows, the content's size, the room); the controls that send read it.
    @State private var settleEpoch = 0
    /// The chat is shown (`ChatReveal`): until then it is laid out at opacity 0 under the skeleton, scrolled to
    /// the bottom on every height change where nobody sees it, and revealed once, in one frame.
    @State private var settled = false
    @State private var reveal = ChatReveal()
    /// How far the visible bottom is from the content's end (inset included), read by the reveal loop. A plain
    /// box, not state: it changes every scrolled frame and nothing is drawn from it.
    @State private var bottom = BottomGap()
    @State private var openedAt = ProcessInfo.processInfo.systemUptime
    /// Within a screenful and a half of the first mounted row.
    @State private var nearTop = false
    /// Older rows were just mounted above: the place-keeping scroll (`PrependAnchor`) treats it as a prepend.
    @State private var growing = false
    #if DEBUG
    @State private var trace = ScrollTrace()
    /// `-squeak-scroll-grow`: height added below the content after the reveal, +48 pt every 250 ms for 5 s.
    @State private var growth: CGFloat = 0
    #endif

    var body: some View {
        ScrollView {
            VStack(spacing: 0) {
            content
                .opacity(settled ? 1 : 0)
            #if DEBUG
            Color.clear.frame(height: growth)
            #endif
            }
                .environment(\.holdChatScroll, { following = false })
                .environment(\.chatSettle, ChatSettleSignal(epoch: settleEpoch + layoutToken, scrolling: dragging))
        }
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
                geometry.visibleRect.minY < geometry.containerSize.height * 1.5
            } action: { _, near in
                nearTop = near
                growIfNeeded()
            }
            .onChange(of: hiddenAbove) { _, _ in growIfNeeded() }
            .onChange(of: settled) { _, _ in growIfNeeded() }
            .task(id: growing) {
                guard growing else { return }
                try? await Task.sleep(for: .milliseconds(300))
                growing = false
            }
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentSize.height - geometry.visibleRect.maxY < 32
            } action: { _, near in
                nearBottom = near
                if dragging { following = near }
                if near { newBelow = false }
            }
            // While the chat is not yet shown it is laid out unseen: its height changes many times as it opens, and
            // the bottom is re-taken on each, where nobody watches. Once shown the scroll view's own anchor holds
            // the bottom as content grows; nothing scrolls on a height change any more.
            .onScrollGeometryChange(for: Double.self) { $0.contentSize.height } action: { _, height in
                settleEpoch += 1
                if !settled {
                    reveal.sample(height: height, ready: ready, at: ProcessInfo.processInfo.systemUptime)
                    if following, !dragging { position.scrollTo(edge: .bottom) }
                }
            }
            // The room changed (the keyboard, the queue): while following, the bottom is re-taken.
            .onScrollGeometryChange(for: Double.self) { $0.containerSize.height } action: { _, _ in
                settleEpoch += 1
                if following, !dragging { position.scrollTo(edge: .bottom) }
            }
            .onScrollGeometryChange(for: Double.self) { $0.contentSize.height + $0.contentInsets.bottom - $0.visibleRect.maxY } action: { _, gap in
                bottom.gap = gap
            }
            .task(id: ready) {
                guard ready, !settled else { return }
                reveal.markReady(at: ProcessInfo.processInfo.systemUptime)
                while !settled, !Task.isCancelled {
                    let now = ProcessInfo.processInfo.systemUptime
                    // Settled, and really at the bottom (the layout caught up with the scroll): only then is it
                    // shown. A late frame that is not there yet is scrolled to again, up to a second.
                    if reveal.decide(at: now), !following || abs(bottom.gap) < 2 || now - openedAt > 1 {
                        var transaction = Transaction()
                        transaction.disablesAnimations = true
                        withTransaction(transaction) {
                            if following { position.scrollTo(edge: .bottom) }
                            settled = true
                        }
                        #if DEBUG
                        trace.note("reveal", since: openedAt)
                        #endif
                        break
                    }
                    if reveal.shown, following { position.scrollTo(edge: .bottom) }
                    try? await Task.sleep(for: .milliseconds(16))
                }
            }
            #if DEBUG
            .onAppear { trace.note("open", since: openedAt) }
            // `-squeak-scroll-up`: after the reveal, the reader scrolls to 100 pt from the top of what is mounted, three
            // times 1.2 s apart (each lets the next batch of older rows mount); the trace shows the gap to the bottom.
            .task(id: settled) {
                guard settled, ProcessInfo.processInfo.arguments.contains("-squeak-scroll-up") else { return }
                for _ in 0..<4 {
                    try? await Task.sleep(for: .milliseconds(1200))
                    following = false
                    // To the first mounted row, as a reader reaching the top would be: a fixed y would be re-applied
                    // by the scroll position on every growth and fight the place-keeping.
                    guard let first = ids.first else { continue }
                    trace.note("scrollTo first row", since: openedAt)
                    position.scrollTo(id: first, anchor: .top)
                }
            }
            .task(id: settled) {
                guard settled, ProcessInfo.processInfo.arguments.contains("-squeak-scroll-grow") else { return }
                for _ in 0..<20 {
                    try? await Task.sleep(for: .milliseconds(250))
                    growth += 48
                }
            }
            .onScrollGeometryChange(for: [Double].self) { [$0.contentSize.height, $0.visibleRect.maxY, $0.contentInsets.bottom, $0.containerSize.height] } action: { _, new in
                trace.sample(content: new[0], visibleMaxY: new[1], inset: new[2], container: new[3], settled: settled, since: openedAt)
            }
            #endif
            .onScrollPhaseChange { old, phase in
                let wasDragging = Self.isUserPhase(old)
                dragging = Self.isUserPhase(phase)
                // Only a finger lets go of the bottom. A phase change the view did not get from you (the push
                // landing, a scroll this view ran, content arriving in pieces) must never stop following: it left
                // a chat opened mid-load sitting at its top, with the jump button turning up later.
                if wasDragging, !dragging { following = nearBottom }
            }
            .onChange(of: arrivals) { _, _ in if !following { newBelow = true } }
            .onChange(of: sends) { _, _ in
                following = true
                newBelow = false
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.25)) { position.scrollTo(edge: .bottom) }
            }
            .refreshable { await onPull() }
            // Older messages landed above: the message that was first stays under the reader's eye. Not while
            // following the bottom, where the growth above is out of sight anyway.
            .onChange(of: top) { old, new in
                guard let target = PrependAnchor.target(oldTop: old, newTop: new, ids: ids, prepended: prepended || growing, following: following) else { return }
                following = false
                position.scrollTo(id: target, anchor: .top)
            }
            .overlay(alignment: .bottom) {
                if !settled {
                    ChatSkeleton()
                        .padding(.horizontal, 20).padding(.bottom, 16)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(Theme.bg)
                }
            }
            .overlay(alignment: .bottom) { jumpButton }
    }

    /// The reader is near the first mounted row and older ones are held: mount the next batch, in one transaction
    /// with animations off; `PrependAnchor` then keeps the first row where it was.
    private func growIfNeeded() {
        guard settled, nearTop, hiddenAbove > 0, !growing else { return }
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            growing = true
            onNearTop()
        }
    }

    private static func isUserPhase(_ phase: ScrollPhase) -> Bool {
        phase == .tracking || phase == .interacting || phase == .decelerating
    }

    /// Back to the newest message in one tap: a round button, or a "New" pill when something arrived meanwhile.
    private var jumpButton: some View {
        ZStack {
                if settled, !following, newBelow || farFromBottom {
                    Button { Haptics.play(.tap); 
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
                    .buttonStyle(.press)
                    .padding(.bottom, 8)
                    .accessibilityLabel(newBelow ? "New messages. Jump to the newest" : "Jump to the newest message")
                    .transition(.opacity.combined(with: .scale(scale: 0.9)))
                }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: 0.18), value: settled && !following && (newBelow || farFromBottom))
    }
}

/// An errored chat says so above the composer, with the agent's own reason when the Mac sent it,
/// and what to do next: the composer under it is the recovery.
private struct FailureNotice: View {
    let reason: String?
    let canReply: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Lucide(.circleX, size: 15, color: Theme.negative).padding(.top, 2)
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
            Capsule().fill(Theme.negative).frame(width: 3).padding(.vertical, 10).padding(.leading, 4).accessibilityHidden(true)
        }
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
        .padding(.horizontal, 16).padding(.bottom, 8)
        .accessibilityElement(children: .combine)
    }
}

/// The chat's subagents and background shells while it works: one line saying how many run, opening to a row
/// each with what it is, how long it has run, and how it ended. Folded by default once there are more than two.
private struct BackgroundStrip: View {
    let tasks: [PhoneSnapshot.Session.BackgroundTask]
    /// A subagent whose steps can be read was tapped.
    var onOpen: (PhoneSnapshot.Session.BackgroundTask) -> Void = { _ in }
    @State private var open: Bool?

    private var running: Int { tasks.filter { $0.status == "running" }.count }
    private var isOpen: Bool { open ?? (tasks.count <= 2) }

    private var summary: String {
        let agents = tasks.filter { $0.kind == "agent" }.count
        let shells = tasks.count - agents
        let what = [agents > 0 ? "\(agents) \(agents == 1 ? "duckling" : "ducklings")" : nil,
                    shells > 0 ? "\(shells) \(shells == 1 ? "shell" : "shells")" : nil].compactMap { $0 }.joined(separator: ", ")
        return running == 0 ? "\(what) · all ended" : running == tasks.count ? "\(what) · running" : "\(what) · \(running) running"
    }

    var body: some View {
        TimelineView(.periodic(from: .now, by: 15)) { context in
            VStack(alignment: .leading, spacing: 0) {
                Button { Haptics.play(.tap); 
                    withAnimation(.easeOut(duration: 0.2)) { open = !isOpen }
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "square.stack.3d.up").font(.footnote).foregroundStyle(Theme.muted).accessibilityHidden(true)
                        Text(summary).font(.footnote.weight(.medium)).foregroundStyle(Theme.ink).multilineTextAlignment(.leading)
                        Spacer(minLength: 8)
                        Image(systemName: "chevron.down").font(.caption.weight(.semibold)).foregroundStyle(Theme.muted)
                            .rotationEffect(.degrees(isOpen ? 180 : 0)).accessibilityHidden(true)
                    }
                    .padding(.horizontal, 14).frame(minHeight: 44).contentShape(Rectangle())
                }
                .buttonStyle(.press)
                .accessibilityLabel("Background work: \(summary)")
                .accessibilityHint(isOpen ? "Hides the list." : "Shows each one.")
                if isOpen {
                    VStack(alignment: .leading, spacing: 0) {
                        ForEach(tasks) { task in
                            Rectangle().fill(Theme.line).frame(height: 1)
                            row(task, now: context.date)
                        }
                    }
                }
            }
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
            .padding(.horizontal, 16).padding(.bottom, 8)
        }
    }

    @ViewBuilder
    private func row(_ task: PhoneSnapshot.Session.BackgroundTask, now: Date) -> some View {
        if task.canOpenSteps {
            Button { Haptics.play(.tap); onOpen(task) } label: { rowContent(task, now: now).contentShape(Rectangle()) }
                .buttonStyle(.press)
                .accessibilityHint("Shows its steps.")
        } else {
            rowContent(task, now: now)
        }
    }

    private func rowContent(_ task: PhoneSnapshot.Session.BackgroundTask, now: Date) -> some View {
        HStack(alignment: .center, spacing: 10) {
            Image(systemName: task.kind == "agent" ? "person.2" : "terminal")
                .font(.footnote).foregroundStyle(Theme.muted).frame(width: 18).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(task.label).font(.subheadline).foregroundStyle(Theme.ink).lineLimit(2)
                // Claude Code's "Agent "…" finished" only repeats the label; a shell's exit code is worth a line.
                if task.status != "running", let summary = task.summary, !summary.contains(task.label) || task.kind == "shell" {
                    Text(summary).font(.caption).foregroundStyle(Theme.muted).lineLimit(2)
                }
            }
            Spacer(minLength: 8)
            status(task, now: now)
            if task.canOpenSteps {
                Image(systemName: "chevron.right").font(.caption.weight(.semibold)).foregroundStyle(Theme.subtle)
                    .accessibilityHidden(true)
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 10)
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private func status(_ task: PhoneSnapshot.Session.BackgroundTask, now: Date) -> some View {
        let time = task.duration(now: now)
        switch task.status {
        case "running":
            HStack(spacing: 6) {
                GlyphLoader(size: 12, quiet: true)
                if let time { Text(time).font(.caption.monospacedDigit()).foregroundStyle(Theme.muted) }
            }
        case "done":
            Label(time ?? "done", systemImage: "checkmark").labelStyle(.titleAndIcon)
                .font(.caption).foregroundStyle(Theme.muted)
                .accessibilityLabel(time.map { "done after \($0)" } ?? "done")
        case "failed":
            Label { Text("failed") } icon: { Lucide(.circleX, size: 12, color: Theme.negative) }.font(.caption).foregroundStyle(Theme.negative)
        default:
            Text("stopped").font(.caption).foregroundStyle(Theme.muted)
        }
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
                Lucide(.triangleAlert, size: 15, color: Theme.warning)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Seems stuck").font(.subheadline.weight(.semibold)).foregroundStyle(Theme.ink)
                    Text(stalled.line(now: context.date)).font(.footnote).foregroundStyle(Theme.muted).lineLimit(2)
                    Text(canStop ? "Stop it, then reply to run the turn again." : "Stop it on your Mac, then try again.")
                        .font(.footnote).foregroundStyle(Theme.muted)
                }
                Spacer(minLength: 0)
                if canStop {
                    Button(action: stop) {
                        if stopping { GlyphLoader().controlSize(.small) } else { Text("Stop").font(.subheadline.weight(.semibold)) }
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
                Capsule().fill(Theme.warning).frame(width: 3).padding(.vertical, 10).padding(.leading, 4).accessibilityHidden(true)
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
        // labels-v2: project · workspace · +added −removed; no state word, no age. Context only when it runs low.
        let context = UsageFormat.contextIsLow(session.contextPercent) ? UsageFormat.context(session.contextPercent) : nil
        let lines = Presentation.headerLines(project: Presentation.projectName(session), workspace: Presentation.workspaceName(session),
                                             git: session.git, context: context)
        VStack(spacing: 1) {
            Text(Presentation.displayTitle(session))
                .font(.headline).lineLimit(1).truncationMode(.tail)
            ViewThatFits(in: .horizontal) {
                // By position: ViewThatFits traps on two children with one id.
                ForEach(Array(lines.enumerated()), id: \.offset) { line(line: $0.element, context: context) }
            }
            .font(.caption).foregroundStyle(Theme.muted).monospacedDigit()
        }
        .frame(maxWidth: 260)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Presentation.displayTitle(session))
        .accessibilityValue(lines[0])
        .accessibilityAddTraits(.isHeader)
    }

    /// One candidate line; "39% context" turns the warning colour from 80% on (DESIGN.md: state colours, never the duck's).
    private func line(line: String, context: String?) -> some View {
        Group {
            if let context, UsageFormat.contextIsLow(session.contextPercent), let range = line.range(of: context) {
                Text(String(line[..<range.lowerBound]))
                    + Text(context).foregroundColor(Theme.needsYou)
                    + Text(String(line[range.upperBound...]))
            } else {
                Text(line)
            }
        }
        .lineLimit(1)
    }
}

/* ---------- chat ---------- */

/// What sits above a chat's first message while older ones are paged in: a sentinel that asks when it comes on
/// screen, a spinner, "Start of chat", or a row to tap when the last try failed (never silent).
private struct EarlierRowView: View {
    @Environment(AppModel.self) private var model
    let row: EarlierPaging.Row
    let session: PhoneSnapshot.Session
    @State private var visible = false

    var body: some View {
        switch row {
        case .none:
            EmptyView()
        case .sentinel:
            sentinel
        case .loading:
            HStack(spacing: 8) {
                GlyphLoader().controlSize(.small)
                Text("Loading earlier messages…").font(.subheadline).foregroundStyle(Theme.muted)
            }
            .frame(maxWidth: .infinity, minHeight: 36)
            .accessibilityElement(children: .combine)
        case .start:
            Text("Start of chat").font(.footnote).foregroundStyle(Theme.subtle)
                .frame(maxWidth: .infinity, minHeight: 28)
        case .catchingUp:
            HStack(spacing: 8) {
                GlyphLoader().controlSize(.small)
                Text("Catching up…").font(.subheadline).foregroundStyle(Theme.muted)
            }
            .frame(maxWidth: .infinity, minHeight: 36)
            .accessibilityElement(children: .combine)
        case .failed:
            VStack(spacing: 0) {
                Button { Haptics.play(.tap); Task { await model.loadEarlier(session, manual: true) } } label: {
                    Text("Couldn't load earlier messages. Try again.").font(.subheadline).foregroundStyle(Theme.muted)
                        .frame(maxWidth: .infinity, minHeight: 44)
                }
                .buttonStyle(.press)
                ReportProblemButton(problem: "Couldn't load earlier messages.", place: "Session › Earlier messages")
            }
        }
    }

    @ViewBuilder private var sentinel: some View {
        if #available(iOS 18, *) {
            Color.clear.frame(height: 24)
                .onScrollVisibilityChange(threshold: 0.1) { visible = $0 }
                // A beat on screen, so the chat opening at its top for a frame before it jumps to the bottom asks for nothing.
                // The request is its own task: this row is replaced by the spinner, which must not cancel it.
                .task(id: visible) {
                    guard visible else { return }
                    try? await Task.sleep(for: .milliseconds(350))
                    guard !Task.isCancelled else { return }
                    let model = model, session = session
                    Task { await model.loadEarlier(session) }
                }
        } else {
            Button { Haptics.play(.tap); Task { await model.loadEarlier(session, manual: true) } } label: {
                Text("Load earlier messages").font(.subheadline).foregroundStyle(Theme.muted).frame(maxWidth: .infinity, minHeight: 44)
            }
            .buttonStyle(.press)
        }
    }
}

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
    let earlier: EarlierPaging.Row
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
            EarlierRowView(row: earlier, session: session)
            ForEach(rows) { row in
                switch row {
                case .sent(let message):
                    SentBubble(text: message.text, date: message.date, line: message.status == .sending && message.onChannel ? message.line : message.status.visibleLine,
                               failed: message.status.failed,
                               mark: message.status.mark, dimmed: message.status.waitingToBeRead, spoken: message.line)
                    if message.status.failed { FailedSendActions(sendId: message.id, session: session, problem: message.status.line) }
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
                    // A hairline closes the previous answer before what comes next.
                    if muted { Rectangle().fill(Theme.line).frame(height: 1).accessibilityHidden(true) }
                    // What the turn left on disk, a tap from its diff.
                    if !muted, session.state != "working", let git = session.git, session.conductorSessionId != nil {
                        Button { Haptics.play(.tap); showingDiff = true } label: {
                            HStack(spacing: 6) {
                                Lucide(.gitBranch, size: 14, color: Theme.muted).accessibilityHidden(true)
                                Text(git).font(.subheadline).foregroundStyle(Theme.muted).monospacedDigit()
                                Lucide(.chevronRight, size: 12, color: Theme.subtle)
                            }
                            .frame(minHeight: 36).contentShape(Rectangle())
                        }
                        .buttonStyle(.press)
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
                        AgentMessage(agentName: agentName, text: text, atISO: atISO ?? "", muted: false, choices: nil, disabled: true) { _ in }
                            .equatable()
                            // An earlier answer's images load on a tap too; without this they were "[image: …]" text.
                            .environment(\.messageImage, { alt, source in AnyView(ChatImage(alt: alt, source: source, session: session)) })
                    }
                case .worked(_, let steps, let messageId):
                    // Tappable only when the Mac says it answers for this message; else a plain count.
                    if let messageId, model.workSteps == true, session.conductorSessionId != nil {
                        OpenWork(session: session, messageId: messageId, count: steps)
                    } else {
                        WorkedNote(steps: steps)
                    }
                case .working(let label, let steps):
                    // After a steer the live part is its own count; "the latest 3 of 7" would count the folded parts too.
                    WorkingRow(agentName: agentName, label: stopping ? "Stopping…" : label, steps: steps, total: parted ? steps.count : total, live: live, open: $stepsOpen)
                case .empty(let text):
                    EmptyChat(text: text, loading: model.lastHistory[session.key] == nil && !model.historyLanded(session.key))
                }
            }
            if let progress = session.workflowProgress {
                FilmProgressCard(progress: progress)
            }
            if let workflow = session.workflow {
                // A film's call has its own card; a question read from the director's transcript would repeat it.
                WorkflowCard(workflow: workflow, owner: .session(session))
            } else if let request = session.nativeRequest {
                // A Squeak chat's own request, answered through the session host (never Conductor's answer path).
                NativeRequestCard(request: request, agentName: agentName, session: session).id(request.id)
            } else {
                AnswerCardSlot(session: session, agentName: agentName)
            }
        }
        .sheet(isPresented: $showingDiff) { DiffView(session: session) }
        // No implicit animation on rows arriving: in a chat pinned to its bottom, content that slides while the
        // scroll view is also adjusting itself put two lines of text on top of each other for a moment.
    }
}

/// A chat with nothing in it. While its history has not arrived yet it is a short skeleton (a few grey bars where
/// messages will be) for up to 6 seconds; after that, or once the history is in, it is DESIGN.md §8.7's empty state:
/// the resting duck and a sentence saying what is true.
private struct EmptyChat: View {
    let text: String
    let loading: Bool
    @State private var gaveUp = false
    @ScaledMetric(relativeTo: .body) private var duck: CGFloat = 72

    var body: some View {
        if loading, !gaveUp {
            VStack(alignment: .leading, spacing: 14) {
                bar(0.35, height: 14)
                bar(0.9, height: 44)
                bar(0.6, height: 14)
                bar(0.8, height: 44)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Loading messages")
            .task { try? await Task.sleep(for: .seconds(6)); gaveUp = true }
        } else {
            VStack(spacing: 12) {
                Image("duck-asleep", bundle: .module).resizable().scaledToFit().frame(width: duck, height: duck).accessibilityHidden(true)
                Text(text).font(.subheadline).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 32)
            .accessibilityElement(children: .combine)
        }
    }

    private func bar(_ fraction: CGFloat, height: CGFloat) -> some View { SkeletonBar(fraction: fraction, height: height) }
}

/// Fixed-height neutral bars where messages will be: the chat's first frame when nothing of it is kept yet.
/// Still, not shimmering (DESIGN.md keeps motion for state), so nothing moves until the real rows swap in once.
private struct ChatSkeleton: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            SkeletonBar(fraction: 0.35, height: 14)
            SkeletonBar(fraction: 0.9, height: 44)
            SkeletonBar(fraction: 0.6, height: 14)
            SkeletonBar(fraction: 0.8, height: 44)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Loading messages")
    }
}

/// "Worked · N steps" with nothing to open (the steps are not on this phone): a check and plain text, so it
/// does not read as the folded row beside it, which has a clipboard, a chevron and a tap.
private struct WorkedNote: View {
    let steps: Int
    @ScaledMetric(relativeTo: .subheadline) private var glyph: CGFloat = 14

    var body: some View {
        HStack(spacing: 6) {
            Lucide(.check, size: glyph, color: Theme.subtle)
            Text(steps == 1 ? "Worked · 1 step" : "Worked · \(steps) steps").font(.subheadline).foregroundStyle(Theme.muted)
            Spacer(minLength: 0)
        }
        .frame(minHeight: 28)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(.isStaticText)
    }
}

/// "Worked · N steps" before a message, opened on a tap: the Mac reads the steps then (once per message, kept for
/// the session) and they show in the same list as a finished turn's folded steps. A failure says so, with Try again.
private struct OpenWork: View {
    @Environment(AppModel.self) private var model
    let session: PhoneSnapshot.Session
    let messageId: String
    let count: Int
    @State private var open = false
    @State private var loading = false
    @State private var problem: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.holdChatScroll) private var hold
    @ScaledMetric(relativeTo: .subheadline) private var glyph: CGFloat = 14

    var body: some View {
        let loaded = model.workSteps(for: session, messageId: messageId)
        VStack(alignment: .leading, spacing: 8) {
            Button { Haptics.play(.tap); 
                hold()
                withAnimation(reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.86)) { open.toggle() }
                if open { Task { await load() } }
            } label: {
                HStack(spacing: 6) {
                    Lucide(.clipboardList, size: glyph, color: Theme.muted).accessibilityHidden(true)
                    Text(count == 1 ? "Worked · 1 step" : "Worked · \(count) steps")
                        .font(.subheadline.weight(.medium)).foregroundStyle(Theme.muted)
                    Lucide(open ? .chevronUp : .chevronDown, size: glyph - 2, color: Theme.muted)
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.press)
            .accessibilityValue(open ? "Expanded" : "Collapsed")
            .accessibilityHint(open ? "Hides these steps" : "Loads the steps from your Mac")
            if open {
                if let loaded {
                    StepList(steps: loaded.steps.map { TurnStep(kind: $0.kind, text: $0.text) }, total: loaded.steps.count, live: false, readable: true)
                        .padding(.leading, 4)
                        .transition(.opacity)
                    if loaded.more > 0 {
                        Text(loaded.more == 1 ? "1 more step left out" : "\(loaded.more) more steps left out")
                            .font(.footnote).foregroundStyle(Theme.muted).padding(.leading, 4)
                    }
                    HideStepsButton { withAnimation(reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.86)) { open = false } }
                } else if loading {
                    HStack(spacing: 8) { GlyphLoader().controlSize(.small); Text("Loading the steps…").font(.footnote).foregroundStyle(Theme.muted) }
                        .frame(minHeight: 36)
                } else if let problem {
                    HStack(spacing: 8) {
                        Text(problem).font(.footnote).foregroundStyle(Theme.error)
                        Button("Try again") { Haptics.play(.tap); Task { await load() } }
                            .font(.footnote.weight(.medium)).foregroundStyle(Theme.ink).frame(minHeight: 44)
                    }
                }
            }
        }
    }

    private func load() async {
        guard model.workSteps(for: session, messageId: messageId) == nil, !loading else { return }
        loading = true
        problem = nil
        if case .refused(let why) = await model.loadWork(session, messageId: messageId) { problem = why }
        loading = false
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
    @State private var selecting = false

    static func == (a: Self, b: Self) -> Bool {
        a.agentName == b.agentName && a.text == b.text && a.atISO == b.atISO && a.muted == b.muted
            && a.choices == b.choices && a.disabled == b.disabled
    }

    var body: some View {
        let reading = Presentation.read(message: text, choices: choices)
        VStack(alignment: .leading, spacing: 10) {
            // An answer from before the one being worked on: said in words, at full contrast, never by fading it.
            if muted { Text("Previous answer").font(.footnote.weight(.medium)).foregroundStyle(Theme.muted) }
            HStack(spacing: 6) {
                Text(agentName).font(.subheadline.weight(.semibold))
                Text(Age.clock(atISO)).font(.subheadline).foregroundStyle(Theme.muted).monospacedDigit()
                    .accessibilityElement(children: .combine)
                Spacer(minLength: 4)
                // The whole message out of the phone in one tap; the text itself stays selectable.
                Menu {
                    Button { UIPasteboard.general.string = text } label: { Label("Copy", systemImage: "doc.on.doc") }
                    Button { selecting = true } label: { Label("Select text", systemImage: "text.cursor") }
                    // Each link in the message, whole, one tap: no selecting a URL by its handles.
                    ForEach(MessageLinks.urls(in: text), id: \.self) { link in
                        Button { UIPasteboard.general.string = link } label: { Label("Copy link: \(MessageLinks.host(link))", systemImage: "link") }
                    }
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
        .accessibilityElement(children: .contain)
        .sheet(isPresented: $selecting) { SelectableTextSheet(text: text, title: agentName) }
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
    @ScaledMetric(relativeTo: .subheadline) private var chevron: CGFloat = 14

    init(agentName: String, label: String, steps: [TurnStep] = [], total: Int = 0, live: Bool = false, open: Binding<Bool> = .constant(false)) {
        self.agentName = agentName; self.label = label; self.steps = steps; self.total = total; self.live = live; _open = open
    }

    static let boxLines = 3

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { Haptics.play(.tap); 
                hold()
                withAnimation(reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.86)) { open.toggle() }
            } label: {
                HStack(spacing: 8) {
                    WorkingGlyph()
                    Text(label).font(.subheadline).foregroundStyle(Theme.muted).lineLimit(2)
                    if !steps.isEmpty {
                        Spacer(minLength: 4)
                        Lucide(open ? .chevronUp : .chevronDown, size: chevron, color: Theme.muted)
                    }
                }
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.press)
            // Nothing to open yet ("Starting…"): not tappable, but not greyed either, as .disabled would do.
            .allowsHitTesting(!(steps.isEmpty && !open))
            .accessibilityLabel("Working: \(label)")
            .accessibilityValue(steps.isEmpty ? "" : open ? "Expanded" : "Collapsed")
            .accessibilityHint(steps.isEmpty ? "" : open ? "Hides the steps" : "Shows the steps of this turn")
            if open, !steps.isEmpty {
                // Opened to read: thinking and notes whole, tool calls one line each.
                StepList(steps: steps, total: max(total, steps.count), live: live, readable: true)
                    .padding(.leading, 4)
                    .transition(.opacity)
                HideStepsButton { withAnimation(reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.86)) { open = false } }
            } else if !steps.isEmpty {
                // The box opens the turn too: it is what you see, so it is what you tap.
                Button { Haptics.play(.tap); 
                    hold()
                    withAnimation(reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.86)) { open = true }
                } label: {
                    LiveBox(steps: Array(steps.suffix(Self.boxLines)), first: max(total, steps.count) - min(steps.count, Self.boxLines))
                        .contentShape(RoundedRectangle(cornerRadius: 12))
                }
                .buttonStyle(.press)
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
    @ScaledMetric(relativeTo: .footnote) private var glyph: CGFloat = 13
    @ScaledMetric(relativeTo: .footnote) private var lineHeight: CGFloat = 20

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ForEach(StableIndexed.make(steps, first: first)) { item in
                let offset = item.offset, step = item.element
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Lucide(StepList.icon(step.kind), size: glyph, color: Theme.muted).frame(width: glyph + 3).accessibilityHidden(true)
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
        .frame(maxWidth: .infinity, minHeight: CGFloat(WorkingRow.boxLines) * lineHeight, alignment: .bottomLeading)
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
    @ScaledMetric(relativeTo: .subheadline) private var glyph: CGFloat = 14

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Button { Haptics.play(.tap); 
                hold()
                withAnimation(reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.86)) { open.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Lucide(.clipboardList, size: glyph, color: Theme.muted).accessibilityHidden(true)
                    Text(steps.count == 1 ? "Worked · 1 step" : "Worked · \(steps.count) steps")
                        .font(.subheadline.weight(.medium)).foregroundStyle(Theme.muted)
                    Lucide(open ? .chevronUp : .chevronDown, size: glyph - 2, color: Theme.muted)
                    Spacer(minLength: 0)
                }
                .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
                .contentShape(Rectangle())
            }
            .buttonStyle(.press)
            .accessibilityValue(open ? "Expanded" : "Collapsed")
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
        Button(action: { Haptics.play(.tap); action() }) {
            HStack(spacing: 6) {
                Lucide(.chevronUp, size: 12, color: Theme.muted)
                Text("Hide steps").font(.subheadline).foregroundStyle(Theme.muted)
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.press)
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
                    Button(showAll ? "Show less" : "Show all \(cards.count)") { Haptics.play(.tap); showAll.toggle() }
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
    @Environment(\.dynamicTypeSize) private var size

    /// From `.xxLarge` the actions sit under the text, so the text keeps the card's whole width.
    private var stacked: Bool { size >= .xxLarge }

    var body: some View {
        let layout = stacked ? AnyLayout(VStackLayout(alignment: .leading, spacing: 0)) : AnyLayout(HStackLayout(alignment: .center, spacing: 8))
        layout {
            VStack(alignment: .leading, spacing: 2) {
                Text(card.text).font(.subheadline).foregroundStyle(Theme.ink).lineLimit(stacked ? 3 : 2)
                if let problem {
                    Text(problem).font(.caption).foregroundStyle(Theme.muted).lineLimit(2)
                } else if card.pending {
                    HStack(spacing: 6) {
                        Lucide(.clock, size: 13, label: "", color: Theme.muted).accessibilityHidden(true)
                        Text("Queuing…").font(.caption).foregroundStyle(Theme.muted)
                    }
                } else if !card.actionable {
                    // Say why there is no Steer now / Edit / Delete, where they would be.
                    Text("Queued in Conductor · it can be changed from your Mac, not from here right now")
                        .font(.caption).foregroundStyle(Theme.muted).lineLimit(2)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, stacked && card.actionable ? 10 : 0)
            if card.actionable {
                HStack(spacing: 8) {
                    Button { Haptics.play(.tap); onSteer(card) } label: {
                        Text("Steer now").font(.footnote.weight(.semibold)).foregroundStyle(Theme.ink)
                            .fixedSize(horizontal: true, vertical: false)
                            .padding(.horizontal, 10).frame(minHeight: 32)
                            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 8))
                            .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.line))
                    }
                    .buttonStyle(.press)
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
        }
        .padding(.leading, 12).padding(.trailing, card.actionable ? (stacked ? 12 : 0) : 12).padding(.vertical, card.actionable ? 0 : 10)
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
    /// When set (the Needs you card), the send's state is reported up to the card's top status line
    /// instead of being printed here.
    var report: Binding<NeedsYou.Receipt?>? = nil
    /// Called once the Mac has confirmed the answer (never on the tap), so the chat knows this phone answered it.
    var onDelivered: (() -> Void)? = nil

    private var receipt: NeedsYou.Receipt? {
        if sending { return .init(phase: .sending, line: "Sending…", sendId: nil, summary: nil) }
        guard let result else { return nil }
        return result.delivered ? .init(phase: .sent, line: result.line, sendId: nil, summary: result.line)
            : .init(phase: .failed, line: result.line, sendId: nil, summary: nil)
    }

    private var canAnswer: Bool { session.question?.toolUseId != nil && session.conductorSessionId != nil }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("\(agentName)'s plan").font(.headline).accessibilityAddTraits(.isHeader)
            MessageText(markdown: plan, style: .squeak)
                .padding(14)
                .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 12))
                .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
            if let result, result.delivered, report == nil {
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
                        Button("Cancel") { Haptics.play(.tap); revising = false; note = "" }
                            .buttonStyle(.bordered).tint(Theme.muted).frame(minHeight: 44)
                        Button { send(approve: false) } label: {
                            Text(sending ? "Sending…" : "Send changes").frame(maxWidth: .infinity, minHeight: 44)
                        }
                        .buttonStyle(.borderedProminent).tint(Theme.primaryFill).foregroundStyle(Theme.primaryText)
                        .disabled(sending || note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .settleGuard()
                    } else {
                        Button { Haptics.play(.tap); revising = true; noteFocused = true } label: {
                            Text("Ask for changes").frame(maxWidth: .infinity, minHeight: 44)
                        }
                        .buttonStyle(.bordered).tint(Theme.ink)
                        Button { send(approve: true) } label: {
                            Text(sending ? "Sending…" : "Approve").frame(maxWidth: .infinity, minHeight: 44)
                        }
                        .buttonStyle(.borderedProminent).tint(Theme.primaryFill).foregroundStyle(Theme.primaryText)
                        .disabled(sending)
                        .settleGuard()
                    }
                }
                if let result, !result.delivered, !result.line.isEmpty, report == nil {
                    Text(result.line).font(.footnote).foregroundStyle(Theme.muted)
                }
            } else {
                Text("Approve this plan in Conductor on your Mac; update Squeak on your Mac to answer from here.")
                    .font(.footnote).foregroundStyle(Theme.muted)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .onChange(of: receipt) { _, new in report?.wrappedValue = new }
    }

    private func send(approve: Bool) {
        sending = true
        let answer = AnswerCommand.PlanAnswer(approve: approve, note: approve ? nil : note.trimmingCharacters(in: .whitespacesAndNewlines))
        Task {
            let outcome = await model.answer(nil, plan: answer, to: session)
            sending = false
            result = outcome.delivered ? (true, approve ? "Approved" : "Sent back with your changes") : outcome
            if outcome.delivered { onDelivered?() }
        }
    }
}

/// The chat's one answer card. While the question is pending it is the live card; if the question goes
/// away or is replaced without this phone having answered it, the card stays as a disabled "Answered
/// elsewhere" note (the decision is `AnswerCard.standing`) until the chat is working again.
struct AnswerCardSlot: View {
    let session: PhoneSnapshot.Session
    let agentName: String
    @State private var remembered: PhoneSnapshot.Question?
    @State private var answeredHere: Set<String> = []

    private var live: PhoneSnapshot.Question? { session.state == "awaiting_input" ? session.question : nil }

    var body: some View {
        Group {
            if let live {
                let id = live.toolUseId ?? "unidentified"
                let done: () -> Void = { if let tool = live.toolUseId { answeredHere.insert(tool) } }
                if let plan = live.plan {
                    PlanCard(plan: plan, agentName: agentName, session: session, onDelivered: done).id(id)
                } else {
                    QuestionCard(question: live, agentName: agentName, session: session, onDelivered: done).id(id)
                }
            } else if let remembered,
                      AnswerCard.standing(shown: remembered.toolUseId, session: session, answeredHere: remembered.toolUseId.map(answeredHere.contains) ?? false) == .answeredElsewhere {
                StaleAnswerCard(question: remembered, agentName: agentName)
            }
        }
        .onChange(of: live, initial: true) { _, new in if let new { remembered = new } }
        .onChange(of: session.state) { _, state in if state == "working" { remembered = nil } }
    }
}

/// A question or plan that is no longer waiting, shown so a tap cannot land on it and the person sees why.
private struct StaleAnswerCard: View {
    let question: PhoneSnapshot.Question
    let agentName: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label { Text("Answered elsewhere").font(.subheadline.weight(.semibold)) } icon: { Lucide(.info, size: 14, color: Theme.muted) }
                .foregroundStyle(Theme.muted)
            if question.plan != nil {
                Text("\(agentName)'s plan is no longer waiting on you.").font(.footnote).foregroundStyle(Theme.muted)
            } else {
                ForEach(Array(question.questions.enumerated()), id: \.offset) { _, prompt in
                    Text(prompt.question).font(.subheadline).foregroundStyle(Theme.muted)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
        .allowsHitTesting(false)
        .accessibilityElement(children: .combine)
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
    @State private var summary: String?
    /// When set (the Needs you card), the send's state is reported up to the card's top status line.
    var report: Binding<NeedsYou.Receipt?>? = nil
    /// Called once the Mac has confirmed the answer (never on the tap).
    var onDelivered: (() -> Void)? = nil

    private var receipt: NeedsYou.Receipt? {
        if sending { return .init(phase: .sending, line: "Sending…", sendId: nil, summary: nil) }
        guard let result else { return nil }
        return result.delivered ? .init(phase: .sent, line: result.line, sendId: nil, summary: summary)
            : .init(phase: .failed, line: result.line, sendId: nil, summary: nil)
    }

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
        .onChange(of: receipt) { _, new in report?.wrappedValue = new }
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
            Haptics.play(.option)
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
        .buttonStyle(.press)
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
            Button { Haptics.play(.tap); 
                withAnimation(reduceMotion ? nil : .easeOut(duration: 0.15)) { _ = otherOpen.insert(index) }
            } label: {
                Text("Something else…").font(.subheadline.weight(.medium)).foregroundStyle(Theme.muted)
                    .frame(maxWidth: .infinity, minHeight: 36, alignment: .leading)
            }
            .buttonStyle(.press)
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
                        summary = NeedsYou.clip(question.questions.indices.flatMap { i in
                            Array(picked[i] ?? []).sorted() + [(other[i] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)].filter { !$0.isEmpty }
                        }.joined(separator: ", "))
                        Task {
                            let outcome = await model.answer(answers, to: session)
                            sending = false
                            if !outcome.line.isEmpty { result = outcome }
                            if outcome.delivered { onDelivered?() }
                        }
                    } label: {
                        HStack(spacing: 8) {
                            if sending { GlyphLoader(color: Theme.primaryText) }
                            Text(sending ? "Sending…" : "Send answer").font(.body.weight(.semibold))
                        }
                        .foregroundStyle(complete ? Theme.primaryText : Theme.muted)
                        .frame(maxWidth: .infinity, minHeight: 48)
                        .background(complete ? Theme.primaryFill : Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 12))
                    }
                    .buttonStyle(.press)
                    .disabled(!complete || sending)
                    .settleGuard()
                }
                if let result {
                    if report == nil { Text(result.line).font(.footnote).foregroundStyle(result.delivered ? Theme.muted : Theme.needsYou) }
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
    /// Sending, sent or read as a glyph beside the time instead of a line of words.
    var mark: DeliveryMark? = nil
    /// Queued behind a turn in progress: lighter until the agent reaches it.
    var dimmed = false
    /// What VoiceOver says for the delivery state; the full words even where a glyph shows.
    var spoken: String? = nil
    @State private var selecting = false

    static func == (a: Self, b: Self) -> Bool {
        a.text == b.text && a.date == b.date && a.line == b.line && a.failed == b.failed && a.mark == b.mark
            && a.dimmed == b.dimmed && a.spoken == b.spoken
    }

    @ViewBuilder private var markView: some View {
        switch mark {
        case .sending: Lucide(.clock, size: 13, label: "", color: Theme.muted)
        case .sent: Lucide(.check, size: 14, label: "", color: Theme.muted)
        case .read: Lucide(.checkCheck, size: 14, label: "", color: Theme.ink)
        case nil: EmptyView()
        }
    }

    var body: some View {
        VStack(alignment: .trailing, spacing: 4) {
            HStack(spacing: 6) {
                Text("You").fontWeight(.semibold)
                if let date { Text(date.formatted(date: .omitted, time: .shortened)).foregroundStyle(Theme.muted).monospacedDigit() }
                markView.accessibilityHidden(true)
            }
            .font(.subheadline)
            // Photos travel as `[Image: path]` lines in the text; here they are pills, and the words are the rest.
            let parts = PhotoAttachment.split(text)
            if !parts.body.isEmpty || parts.refs.isEmpty {
                Text(parts.body)
                    .foregroundStyle(dimmed ? Theme.muted : Theme.ink)
                    .padding(.horizontal, 14).padding(.vertical, 10)
                    .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 12))
                    .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line))
                    .contentShape(.contextMenuPreview, RoundedRectangle(cornerRadius: 12))
                    .contextMenu {
                        Button { UIPasteboard.general.string = parts.body } label: { Label("Copy", systemImage: "doc.on.doc") }
                        Button { selecting = true } label: { Label("Select text", systemImage: "text.cursor") }
                        ShareLink(item: parts.body) { Label("Share", systemImage: "square.and.arrow.up") }
                    }
            }
            if !parts.refs.isEmpty { SentPhotoStrip(refs: parts.refs) }
            // Exactly one muted line per message this phone sent.
            if let line { Text(line).font(.footnote).foregroundStyle(failed ? Theme.error : Theme.muted).multilineTextAlignment(.trailing) }
        }
        // A sent message never runs the whole width: about 85% of it, the rest left to the agent's side.
        .padding(.leading, UIScreen.main.bounds.width * 0.1)
        .frame(maxWidth: .infinity, alignment: .trailing)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("You\(date.map { ", \($0.formatted(date: .omitted, time: .shortened))" } ?? ""): \(text)\((spoken ?? line).map { ". \($0)" } ?? "")")
        .sheet(isPresented: $selecting) { SelectableTextSheet(text: PhotoAttachment.split(text).body, title: "You") }
    }
}

/// What to do with a message that did not go through: send it again, or take its text back to edit.
/// Neither happens by itself: an unconfirmed message may be in the chat already.
struct FailedSendActions: View {
    @Environment(AppModel.self) private var model
    let sendId: UUID
    let session: PhoneSnapshot.Session
    var problem: String? = nil

    var body: some View {
        HStack(spacing: 8) {
            if let problem { ReportProblemButton(problem: problem, place: "Session › Reply", title: "Report") }
            Spacer(minLength: 0)
            Button("Edit") { Haptics.play(.tap); model.edit(sendId, in: session) }
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
    /// The text of the option being sent right now: it shows a spinner and the others dim.
    var sending: String? = nil
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
                let isSending = sending != nil && sending == option.sent
                Button { Haptics.play(.tap); onPick(option.sent) } label: {
                    HStack(alignment: .top, spacing: 12) {
                        Group {
                            if isSending { GlyphLoader() } else { Text(option.letter).font(.body.weight(.bold)) }
                        }
                        .frame(width: 32, height: 32)
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
                .buttonStyle(.press)
                .disabled(disabled)
                // A lettered answer is one tap and cannot be taken back: not while the chat is still settling.
                .settleGuard()
                .opacity(disabled && !isSending ? 0.55 : 1)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(isSending ? "Sending. " : "")\(option.letter): \(split.title)\(detail.map { ". \($0)" } ?? "")\(recommended ? ", recommended" : "")")
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
    /// Where the Mac saved the photos when the message after them failed: Send then names these again instead of uploading.
    @State private var savedRefs: [String]?
    /// Bumped on each clear, so the field is rebuilt and cannot keep text of its own.
    @State private var generation = 0

    init(session: PhoneSnapshot.Session, agentName: String, working: Bool, block: String?, stopping: Bool = false,
         draft: Binding<String>, photos: Binding<[ChatPhoto]>, composing: FocusState<Bool>.Binding) {
        key = session.key; label = session.label; self.agentName = agentName; self.working = working; self.block = block
        self.stopping = stopping; _draft = draft; _photos = photos; self.composing = composing
    }

    /// The hold-to-steer hint shows until the first message sent mid-turn; nothing after.
    @AppStorage("squeak.queueSteerExplained") private var explained = false
    private var empty: Bool { draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && photos.isEmpty }

    /// Always there: after a send the field clears and keeps focus, so the next message can be typed at once.
    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ComposerBox(
                placeholder: "Reply to \(agentName)…", text: $draft, photos: $photos, focused: composing, fieldId: generation,
                locked: block != nil, attachEnabled: block == nil && uploading == nil && savedRefs == nil,
                photosLocked: uploading != nil || savedRefs != nil,
                accessibilityLabel: "Message for \(label)", hasContent: !empty
            ) {
                SetupLine(key: key)
            } primary: {
                sendButton
            }
            caption
        }
        .padding(.horizontal, 12).padding(.top, 8).padding(.bottom, 8)
        .frame(maxWidth: .infinity, alignment: .leading)
        .onChange(of: photos.isEmpty) { _, none in if none { savedRefs = nil } }
        // Opaque, so the conversation scrolling underneath never shows through the box or the caption.
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
        Haptics.play(.send)
        let sending = photos
        let already = savedRefs
        uploadProblem = nil
        if already == nil { uploading = "Sending photo 1 of \(sending.count)…" }
        Task {
            guard let session = model.session(key) else { uploading = nil; giveBack(text); return }
            // Photos the Mac already saved (the message failed last time) are not uploaded again.
            let result: UploadResult
            if let already {
                result = .saved(already)
            } else {
                result = await model.upload(sending, to: .session(session)) { done, total in
                    uploading = "Sending photo \(min(done + 1, total)) of \(total)…"
                }
            }
            uploading = nil
            switch result {
            case .failed(let why):
                giveBack(text)
                uploadProblem = why
            case .saved(let refs):
                let message = PhotoAttachment.compose(text, refs: refs)
                let started = await model.send(message, to: session, mode: wasWorking ? mode : .queue)
                if started {
                    savedRefs = nil
                    photos = []
                } else {
                    savedRefs = refs
                    giveBack(text)
                    uploadProblem = "The photos are on your Mac, but the message wasn't sent. Press Send to try again."
                }
            }
        }
    }

    @ScaledMetric(relativeTo: .body) private var stopGlyph: CGFloat = 12

    private var sendDisabled: Bool { block != nil || empty || uploading != nil }

    /// Send is the one primary control: a round button filled with duck (ink on light, §8.9), an arrow up.
    /// Mid-turn it is a menu whose tap is Queue and whose hold is the choice; with nothing typed it stops the turn.
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
                ComposerRound(filled: false) {
                    RoundedRectangle(cornerRadius: 3).fill(stopping ? Theme.muted : Theme.needsYou)
                        .frame(width: stopGlyph, height: stopGlyph)
                }
            }
            .buttonStyle(.press)
            .disabled(stopping)
            .accessibilityLabel(stopping ? "Stopping \(agentName)" : "Stop \(agentName)")
            .accessibilityHint("Stops the turn in progress, as Stop does in Conductor")
            .accessibilityAddTraits(.isButton)
        } else if working {
            let primary = model.sendMode
            let other: ReplyMode = primary == .steer ? .queue : .steer
            Menu {
                modeButton(other)
                modeButton(primary)
            } label: {
                sendFace
            } primaryAction: {
                send(primary)
            }
            .menuStyle(.button)
            .buttonStyle(.press)
            .menuIndicator(.hidden)
            .disabled(sendDisabled)
            .accessibilityLabel(primary == .steer ? "Steer now" : "Queue")
            .accessibilityHint(primary == .steer
                ? "Sends your message into the turn in progress. Use the Queue action to hold it until \(agentName) finishes."
                : "Holds your message until \(agentName) finishes this turn. Use the Steer now action to send it into the turn.")
            .accessibilityAction(named: other == .steer ? "Steer now" : "Queue") { if !sendDisabled { send(other) } }
        } else {
            Button { send() } label: { sendFace }
                .buttonStyle(.press)
                .disabled(sendDisabled)
                .accessibilityLabel("Send")
        }
    }

    @ViewBuilder
    private func modeButton(_ mode: ReplyMode) -> some View {
        Button { send(mode) } label: {
            if mode == .steer {
                Text("Steer now")
                Text("Goes into the turn in progress")
            } else {
                Text("Queue")
                Text("\(agentName) reads it after this turn")
            }
        }
    }

    private var sendFace: some View {
        ComposerRound(filled: !sendDisabled) {
            Lucide(.arrowUp, size: 18, color: sendDisabled ? Theme.muted : Theme.primaryText)
        }
    }

    /// One line at most, and none at all once you know how it works.
    @ViewBuilder
    private var caption: some View {
        if let block {
            Text(block).font(.footnote).foregroundStyle(Theme.muted)
        } else if let pending = model.inFlight[key] {
            // A menu action the Mac has not answered: the menu closed on the tap, so the chat says it is working.
            HStack(spacing: 8) { GlyphLoader().controlSize(.small); Text(pending).font(.footnote).foregroundStyle(Theme.muted) }
        } else if let uploading {
            HStack(spacing: 8) { GlyphLoader().controlSize(.small); Text(uploading).font(.footnote).foregroundStyle(Theme.muted) }
        } else if let uploadProblem {
            HStack(spacing: 8) {
                Text(uploadProblem).font(.footnote).foregroundStyle(Theme.error)
                if savedRefs != nil {
                    Button("Drop photos") { Haptics.play(.tap); savedRefs = nil; photos = []; self.uploadProblem = nil }
                        .font(.footnote).foregroundStyle(Theme.ink)
                } else {
                    ReportProblemButton(problem: uploadProblem, place: "Session › Photos", title: "Report")
                }
            }
        } else if let problem = model.problemFor[key] {
            HStack(spacing: 8) {
                Text(problem).font(.footnote).foregroundStyle(Theme.muted)
                ReportProblemButton(problem: problem, place: "Session › Reply", title: "Report")
            }
        } else if working, !explained {
            Text("Send queues it · hold to steer · empty, it stops \(agentName)")
                .font(.footnote).foregroundStyle(Theme.muted)
        }
    }
}

/// One subagent's steps, opened from the chat's background list: what the Mac reads from its transcript while
/// this is open. Says why when there is nothing to show, rather than an empty screen.
struct SubagentSheet: View {
    let watch: AppModel.SubagentWatch
    /// Why steps are not on offer on this phone or channel (verbose off, no stream); nil when they are.
    let unavailable: String?
    let close: () -> Void

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    HStack(spacing: 8) {
                        chip
                        Spacer(minLength: 0)
                    }
                    content
                }
                .padding(.horizontal, 20).padding(.vertical, 16)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .background(Theme.bg.ignoresSafeArea())
            .navigationTitle(watch.feed?.label ?? watch.task.label)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done", action: close) } }
        }
        .presentationDetents([.medium, .large])
    }

    private var status: String { watch.feed?.status ?? watch.task.status }

    @ViewBuilder private var chip: some View {
        let color: Color = status == "failed" ? Theme.negative : Theme.muted
        HStack(spacing: 6) {
            if status == "running" { GlyphLoader(size: 12, quiet: true) }
            Text(Self.statusWord(status)).font(.caption.weight(.medium)).foregroundStyle(color)
        }
        .padding(.horizontal, 10).padding(.vertical, 5)
        .background(Theme.surfaceRaised, in: Capsule())
        .accessibilityLabel("Duckling \(Self.statusWord(status))")
    }

    static func statusWord(_ status: String) -> String {
        switch status {
        case "running": return "Running"
        case "done": return "Done"
        case "failed": return "Failed"
        default: return "Stopped"
        }
    }

    /// The words for a state that has no steps to show; nil when there are steps.
    static func explanation(for watch: AppModel.SubagentWatch, unavailable: String?) -> String? {
        if let unavailable { return unavailable }
        if case .refused(let reason) = watch.phase { return reason }
        if watch.phase == .asking { return "Asking your Mac\u{2026}" }
        guard let feed = watch.feed else { return "Waiting for the first steps\u{2026}" }
        if !feed.available { return "Its steps can't be read yet. They show here as soon as the duckling writes them." }
        if feed.steps.isEmpty { return "It hasn't taken a step yet." }
        return nil
    }

    @ViewBuilder private var content: some View {
        if let words = Self.explanation(for: watch, unavailable: unavailable) {
            HStack(spacing: 10) {
                if watch.phase == .asking || (watch.phase == .following && watch.feed == nil) { GlyphLoader() }
                Text(words).font(.subheadline).foregroundStyle(Theme.muted)
            }
        } else if let feed = watch.feed {
            StepList(steps: feed.steps.map { TurnStep(kind: $0.kind, text: $0.text) }, total: feed.total,
                     live: status == "running", readable: true, scope: "duckling")
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
    /// What the steps belong to, for the live line: "turn", or "duckling".
    var scope = "turn"

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
                Text(total > steps.count ? "Live · the latest \(steps.count) of \(total) steps" : "Live · every step of this \(scope)")
                    .font(.footnote).foregroundStyle(Theme.muted).padding(.bottom, 4)
            } else if total > steps.count {
                Text("The latest \(steps.count) of \(total) steps this turn")
                    .font(.footnote).foregroundStyle(Theme.muted).padding(.bottom, 4)
            }
            ForEach(StableIndexed.make(steps, first: total - steps.count)) { item in
                row(item.element, index: item.id)
            }
        }
    }

    /// One line per step, like a chat app's collapsed reasoning: icon, kind, first line. A step with
    /// more to say opens on a tap to its whole text.
    private func row(_ step: Step, index: Int) -> some View {
        let more = step.text.count > 60 || step.text.contains("\n")
        let open = more && startsOpen(step) != toggled.contains(index)
        return Button { Haptics.play(.tap); 
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
        .buttonStyle(.press)
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
        default: return "Background duckling"
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
    let key: String

    var body: some View {
        // It reads the chat itself, so a streamed step redraws this label and not the field being typed in.
        if let session = model.session(key), let line = model.pendingSetupLine(session) ?? session.setupLine {
            picker(session, line)
        }
    }

    private func picker(_ session: PhoneSnapshot.Session, _ line: String) -> some View {
        // Mid-turn, working or waiting on you: the Mac refuses a change until the turn ends.
        let midTurn = ["working", "awaiting_approval", "awaiting_input"].contains(session.state)
        let models = model.setupModels(for: session)
        let current = models.first { $0.id == session.modelId }
        return Group {
            if models.isEmpty {
                label(session, line, midTurn, changeable: false)
            } else {
                Menu {
                    Section("Model") {
                        ForEach(models) { option in
                            Button { pick(session, option, thinking: nil, fast: nil) } label: {
                                if option.id == session.modelId { Label(option.label, systemImage: "checkmark") } else { Text(option.label) }
                            }
                        }
                    }
                    if let current, !current.levels.isEmpty {
                        Section("Thinking") {
                            ForEach(current.levels, id: \.self) { level in
                                Button { pick(session, current, thinking: level, fast: nil) } label: {
                                    let name = Self.levelName(level)
                                    if level == session.effortId { Label(name, systemImage: "checkmark") } else { Text(name) }
                                }
                            }
                        }
                    }
                    if let current, session.agent == "claude" {
                        Section {
                            Button { pick(session, current, thinking: nil, fast: session.fast != true) } label: {
                                if session.fast == true { Label("Fast mode", systemImage: "checkmark") } else { Text("Fast mode") }
                            }
                        }
                    }
                } label: {
                    label(session, line, midTurn, changeable: true)
                }
                .disabled(midTurn)
            }
        }
        .accessibilityIdentifier("chat-setup")
    }

    private func label(_ session: PhoneSnapshot.Session, _ line: String, _ midTurn: Bool, changeable: Bool) -> some View {
        SetupLabelText(line: line, changeable: changeable && !midTurn)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(session.setupAccessibilityLabel ?? line)
            .accessibilityHint(changeable ? (midTurn ? "Can be changed once this turn ends." : "Changes the model or thinking level.") : "")
    }

    private func pick(_ session: PhoneSnapshot.Session, _ option: PhoneSnapshot.ChatModel, thinking: String?, fast: Bool?) {
        Task { await model.changeSetup(session, model: option, thinking: thinking, fast: fast) }
    }

    private static func levelName(_ level: String) -> String {
        let words = ChatPresets.levelName(level)
        return words.prefix(1).uppercased() + words.dropFirst()
    }
}
#endif

#if os(iOS) && DEBUG
import Foundation

/// `-squeak-scroll-trace`: one line per scroll geometry change (elapsed ms, settled, content height, visible
/// bottom, the gap between them) in `Documents/scroll-trace.txt`, to prove a chat appears at its bottom. Debug only.
struct ScrollTrace {
    private let on = ProcessInfo.processInfo.arguments.contains("-squeak-scroll-trace")
    private var url: URL { URL.documentsDirectory.appending(path: "scroll-trace.txt") }

    func sample(content: Double, visibleMaxY: Double, inset: Double, container: Double, settled: Bool, since start: Double) {
        // The bottom inset (the composer under the list) is part of what the scroll view can show below the content.
        write(String(format: "%.0f sample settled=%d content=%.1f inset=%.1f container=%.1f visibleMaxY=%.1f gap=%.1f", ms(start), settled ? 1 : 0, content, inset, container, visibleMaxY, content + inset - visibleMaxY))
    }

    func note(_ text: String, since start: Double) { write(String(format: "%.0f %@", ms(start), text)) }

    private func ms(_ start: Double) -> Double { (ProcessInfo.processInfo.systemUptime - start) * 1000 }

    private func write(_ line: String) {
        guard on, let data = (line + "\n").data(using: .utf8) else { return }
        if let handle = try? FileHandle(forWritingTo: url) {
            handle.seekToEndOfFile(); handle.write(data); try? handle.close()
        } else {
            try? data.write(to: url)
        }
    }
}
#endif
