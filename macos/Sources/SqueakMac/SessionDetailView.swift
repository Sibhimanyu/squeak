import AppKit
import SqueakIcons
import SqueakMarkup
import SqueakMacCore
import SwiftUI

// MARK: - Detail

struct DetailView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        Group {
            if model.navFilter == .usage {
                UsageDetailView()
            } else if let s = model.selectedSession {
                SessionDetail(session: s).id(s.key)
            } else if let key = model.selected {
                pick(StartedChats.staleNote(for: key))
            } else if !model.isConnected && model.health != nil {
                VStack(spacing: Space.m) {
                    ConnectionNotice().frame(maxWidth: 460)
                    Text("Drafts are saved on this Mac and never sent on their own after reconnecting.")
                        .font(Typo.meta).foregroundStyle(Theme.subtle)
                }
                .padding(Space.xl)
            } else {
                DashboardPage().screen("Dashboard")
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private func pick(_ note: String?) -> some View {
        VStack(spacing: Space.m) {
            DuckMark(width: 48)
            Text("Pick a chat").font(Typo.heading).foregroundStyle(Theme.muted)
            if let note {
                Text(note).font(Typo.body).foregroundStyle(Theme.subtle).multilineTextAlignment(.center).frame(maxWidth: 320)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// The reason Squeak cannot reach its service, with the fix, in one quiet card.
struct ConnectionNotice: View {
    @Environment(AppModel.self) private var model
    var compact = false

    var body: some View {
        if let help = model.connectionHelp, model.health != nil {
            VStack(alignment: .leading, spacing: Space.xs) {
                HStack(spacing: 6) {
                    Circle().fill(Theme.offline).frame(width: 9, height: 9)
                    Text(model.connectionTitle).font(Typo.label)
                    Spacer()
                    Button("Check again") { model.recheck() }.controlSize(.small)
                }
                Text(help).font(Typo.body).foregroundStyle(Theme.muted)
                    .lineLimit(compact ? 2 : nil).fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
            }
            .padding(Space.m)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
            .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Theme.line))
        }
    }
}

struct SessionDetail: View {
    let session: HostSession
    @Environment(AppModel.self) private var model
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var focusToken = 0
    private var images: ImageTray { model.imageTray(for: session.key) }
    /// Mirror of the follow model (`TranscriptFollow`, driven by `TranscriptScrollFollower`): the newest end is followed.
    @State private var atBottom = true
    /// Bumped to put the view back on the newest end: the jump button, or a message just sent.
    @State private var jumpToken = 0
    /// Something arrived while you were reading further up: the jump button says "New".
    @State private var newBelow = false
    /// The newest end has been on screen once: only then does reaching the top page older rows in (a chat that is
    /// still laying out must never page itself).
    @State private var reachedBottom = false
    /// Rows at or past this index arrived after the chat loaded: only those rise in, and only while following.
    @State private var liveFloor: Int?
    @State private var viewportHeight: CGFloat = 0
    /// The scroll view's width, read once; the column below is given exactly this (capped), never measured at ideal size.
    @State private var viewportWidth: CGFloat = 0
    @State private var dockHeight: CGFloat = 0
    /// The message that was first before an earlier page was asked for: kept in place when the page lands.
    @State private var keepAnchor: String?
    /// First rendered row (`TranscriptWindow`): only the newest rows are laid out, in a plain stack, so the bottom is exact.
    @State private var windowStart: String?
    @State private var topVisible = false
    /// The long queue/steer explanation shows until the first message sent mid-turn; a short line after.
    @AppStorage("queueSteerExplained") private var queueSteerExplained = false
    /// While a decision waits the composer is folded to one quiet button; this opens it.
    @State private var composerExpanded = false

    private var agent: String { SessionText.agentName(session.agent) ?? "Agent" }
    /// The host's state, with the chat read as working from the moment Send is pressed (`OptimisticWork`), so the live
    /// row, Stop and the composer's ↵ / ⌘↵ routing never wait for the host's first word.
    private var liveState: SessionState { model.effectiveState(session) }
    /// The timeline's rows without its working row: the working row is drawn last, below the turn's steps.
    /// Computed once per change (`ChatRowsCache`), not once per read: the body asks for it many times.
    private var rows: [ChatTimeline.Row] { rowsCache.rows(messages: model.displayMessages, state: liveState) }
    @State private var rowsCache = ChatRowsCache()
    /// Per-message products the rows need (turn footers, lettered options), built once per change, not once per body pass.
    @State private var rowCache = TranscriptRowCache()
    /// The dock's one line: sending, working, waiting for an approval, waiting for background tasks.
    private var indicator: ChatIndicator {
        // No "Sending…" state: the row reads Working… from the press (the bubble itself shows it is still going out).
        ChatIndicator.resolve(
            state: liveState, awaitingApproval: session.awaitingApproval == true || nativeCard?.kind == .approval,
            backgroundCount: session.backgroundCount ?? 0, backgroundWaiting: session.backgroundWaiting == true, sending: false)
    }
    /// The model this chat runs, named: Squeak's own chat from its host, any other from the daemon's session (nil when unknown).
    private var chatModelName: String? {
        let name = isNative ? model.native.info.map { ModelNames.label($0.model, in: model.chatModels) } : model.chatExtras?.model
        return name.flatMap { $0.isEmpty ? nil : $0 }
    }
    private var turn: TurnBlock { TurnFolding.block(steps: model.activity, working: isWorking) }
    /// Where the turn's steps sit: before the turn's first agent message once it ended, at the end while it works.
    private func turnInsertIndex(in rows: [ChatTimeline.Row]) -> Int? {
        guard !turn.isEmpty else { return nil }
        if isWorking { return rows.count }
        let lastUser = rows.lastIndex { if case .message(let m, _) = $0 { m.role == .user } else { false } }
        let from = (lastUser ?? -1) + 1
        guard from <= rows.count else { return rows.count }
        return rows[from...].firstIndex { if case .message(let m, _) = $0 { m.role == .assistant } else { false } } ?? rows.count
    }
    private var isNative: Bool { session.source == .squeak }
    /// The finished turn's "N files changed" (the host's checkpoints), on its fold.
    private var turnFilesLine: String? {
        guard isNative, !isWorking else { return nil }
        let hid = model.hostId(session)
        return NativeHistory.latestTurn(in: model.history.turns(for: hid)).flatMap { NativeHistory.filesChangedLine($0.files) }
    }
    private func historyHandle(for m: ChatMessage) -> HistoryHandle? {
        guard isNative, m.role == .user, let hid = model.hostId(session),
              let turn = NativeHistory.turn(forMessageId: m.id, in: model.history.turns(for: hid)) else { return nil }
        return HistoryHandle(session: session, turn: turn, disabled: NativeHistory.disabledReason(working: isWorking || liveState == .working))
    }
    private var canStop: Bool { working && (session.conductorSessionId != nil || isNative) }
    private func stop() { Task { if isNative { await model.nativeInterrupt(session) } else { await model.stopChat(session) } } }
    /// The card a Squeak-run chat waits on, once the host has said what it is.
    private var nativeCard: NativeCard? { isNative && model.native.key == session.key ? model.native.card : nil }
    /// Cheap stand-in for the row ids (count, first, last): O(1) per body pass where `rows.map(\.id)` was O(n).
    private var rowsToken: RowsToken {
        let m = model.displayMessages
        return RowsToken(count: m.count, first: m.first?.id, last: m.last?.id)
    }
    private var firstMessageID: String? { model.displayMessages.first?.id }
    /// The host's own status (the open native chat's) draws the working line even when the catalog lags it.
    private var hostSaysWorking: Bool {
        let info = model.native.key == session.key ? model.native.info : nil
        return ChatLiveness.showsWorkingLine(
            indicatorActive: false, isWorking: false, hostStatus: info?.status, backgroundCount: info?.backgroundCount,
            optimistic: model.optimistic[session.key]?.isStarted == true)
    }

    private var isWorking: Bool { ChatTimeline.isWorking(messages: model.displayMessages, state: liveState) }

    var body: some View {
        VStack(spacing: 0) {
            if model.isOffline(for: session) {
                ConnectionNotice(compact: true).padding(.horizontal, 16).padding(.bottom, Space.s)
            }
            transcript
        }
        .environment(\.agentModelContext, AgentModelContext(chatModelName: chatModelName, choices: model.chatModels))
        .onAppear { focusToken += 1 }
        .onReceive(NotificationCenter.default.publisher(for: .squeakFocusComposer)) { _ in composerExpanded = true; focusToken += 1 }
        // The chat's model, stuck state and background work, from the daemon, while the chat is on screen.
        .task(id: session.key.stringValue) {
            model.chatExtras = nil
            model.chatNote = nil
            while !Task.isCancelled {
                await model.refreshChatExtras(session)
                try? await Task.sleep(for: .seconds(3))
            }
        }
        // A Squeak-run chat: its host record, open request, queue, and the live stream, only while it is on screen.
        .task(id: "native-\(session.key.stringValue)-\(model.windowVisible)") {
            guard isNative, model.windowVisible else { return }
            await model.runNativeChat(session)
        }
        // A Squeak chat's turns and what each changed (Edit, Fork, Restore, "N files changed"); read again when a turn ends.
        .task(id: "turns-\(session.key.stringValue)-\(isWorking)") {
            guard isNative else { return }
            await model.loadTurns(session)
        }
        .sheet(item: Bindable(model.history).restoreAsk) { RestoreSheet(ask: $0) }
        .background {
            // ⌘⌥↵ forks this chat at its latest turn.
            if isNative {
                Button("Fork this chat") { model.forkChat(session) }
                    .keyboardShortcut(.return, modifiers: [.command, .option])
                    .disabled(isWorking || liveState == .working)
                    .opacity(0).accessibilityHidden(true)
            }
        }
        // The turn's steps: read once on opening (a finished turn folds to "Worked · N steps"), and every 2 s while it works.
        .task(id: "\(session.key.stringValue)-\(isWorking)") {
            await model.refreshActivity()
            guard isWorking else { return }
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(2))
                await model.refreshActivity()
            }
        }
    }

    // MARK: Transcript

    @ViewBuilder
    private var transcript: some View {
        if case .unsupported(let why) = session.capabilities.readTranscript {
            note(.eyeOff, "Can't show this conversation", why)
        } else if model.transcriptPhase == .loading {
            LoadingSkeleton(shape: .messages, word: "Opening chat…")
                .safeAreaInset(edge: .bottom, spacing: 0) { bottomBar }
        } else if rows.count == 1, rows[0] == .empty {
            note(.messageSquareText, "No messages yet", "Send one below to start. Messages appear here as the agent and you exchange them.")
                .safeAreaInset(edge: .bottom, spacing: 0) { bottomBar }
        } else {
            Group {
                ScrollView {
                    // A plain VStack of a bounded window: its layout is exact, so the end is always real content. The top
                    // sentinel sits in a one-child lazy stack, because only that reports visibility.
                    VStack(alignment: .leading, spacing: 0) {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            EarlierRow(paging: model.paging, kind: earlierKind, onLoad: { pageUp() })
                                .onAppear { topVisible = true; pageUp() }
                                .onDisappear { topVisible = false }
                        }
                        turnAndRows()
                        if nativeCard != nil {
                            // A Squeak chat's request is pinned above the composer (the dock), never lost in the scroll.
                        } else if let display = model.askCardDisplay(for: session.key) {
                            AskCard(
                                ask: display.ask, framed: true, canSend: sendBlock == nil && model.isReachable(session) && display.phase == .live,
                                onSend: { form in await model.answer(form, for: session.key) }, result: display.outcome,
                                answeredElsewhere: display.phase == .answeredElsewhere
                            )
                            .padding(.top, ChatSpacing.turnToMessage)
                            .id(display.ask.toolUseId)
                        } else if !isNative, ApprovalWait.isWaiting(state: session.state, awaitingApproval: session.awaitingApproval, hasQuestionCard: false) {
                            approvalCard.padding(.top, ChatSpacing.turnToMessage).arrivalRise(true).id("approval")
                        }
                    }
                    // Text sits 20 pt inside the composer's edges (a 720 pt column inside the composer's 760).
                    .padding(.horizontal, CGFloat(Tokens.Workbench.transcriptTextInset))
                    .padding(.horizontal, Metrics.readingInset)
                    .modifier(TranscriptColumnWidth(container: viewportWidth, cap: Metrics.readingColumn + 2 * Metrics.readingInset))
                    .padding(.top, 44)
                    // At least the dock fade's height, so the last message is fully readable when scrolled to the end.
                    .padding(.bottom, DockFade.bottomPadding(base: Space.l))
                    // Short chats sit on the composer: the content is at least as tall as what shows above the dock.
                    .frame(maxWidth: .infinity, minHeight: max(0, viewportHeight - dockHeight).rounded(), alignment: .bottom)
                    // The follow model (TranscriptFollow): keeps the newest end in view while the reader is on it, never moves them otherwise.
                    .background(TranscriptFollowDriver(jumpToken: jumpToken, holdPlace: keepAnchor != nil, onFollowChange: { followChanged($0) }))
                }
                .onGeometryChange(for: CGSize.self) { $0.size } action: { size in
                    setHeight(&viewportHeight, size.height)
                    if abs(size.width - viewportWidth) > 0.5 { viewportWidth = size.width }
                }
                // A 28pt fade at the top where the newest-anchored transcript runs under the tabs.
                .mask(topFade)
                // The scroll-to-newest control floats above the dock; thread navigation reserves room inside it.
                .safeAreaInset(edge: .bottom, spacing: 0) {
                    bottomBar.overlay(alignment: .top) { jumpButton() }
                        // Text dissolves into the dock instead of being cut: the background fading in over the last 48 pt.
                        .background(alignment: .top) {
                            LinearGradient(colors: [Theme.bg.opacity(0), Theme.bg], startPoint: .top, endPoint: .bottom)
                                .frame(height: CGFloat(Tokens.Workbench.dockFadeHeight))
                                .offset(y: -CGFloat(Tokens.Workbench.dockFadeHeight))
                                .allowsHitTesting(false).accessibilityHidden(true)
                        }
                        .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { setHeight(&dockHeight, $0) }
                }
                .onChange(of: model.transcriptPhase, initial: true) { _, _ in markLive() }
                .onChange(of: session.key) { _, _ in liveFloor = nil; markLive() }
                .onChange(of: rowIDs.isEmpty) { _, empty in
                    // Rows arriving into an empty chat start the window at the newest rows, never at a stale row.
                    if !empty { windowStart = nil; keepAnchor = nil }
                }
                .onChange(of: rowsToken, initial: true) { _, _ in
                    if keepAnchor != nil, TranscriptWindow.anchorToKeep(keepAnchor, rowIDs: rowIDs) == nil { keepAnchor = nil }
                }
                .onChange(of: rows.last?.id) { _, _ in
                    // Following needs nothing here: the scroll driver sees the content grow. A message just sent re-attaches.
                    let user = model.displayMessages.last?.role == .user
                    if atBottom { return }
                    if TranscriptPin.followsEnd(atBottom: false, lastIsUserMessage: user) { jumpToken += 1 } else { newBelow = TranscriptPin.marksNewBelow(atBottom: false, lastIsUserMessage: user) }
                }
                .onChange(of: atBottom) { _, now in
                    guard now else { return }
                    newBelow = false
                    reachedBottom = true
                    if topVisible { pageUp() }
                }
                .onChange(of: firstMessageID) { _, _ in
                    // An earlier page landed in front: show it, and put the reader back on the row they were at.
                    if keepAnchor != nil { pageUp(fromHost: true) }
                }
                .onChange(of: model.paging.loading) { _, loading in
                    // Still at the top after a page (a short one): the next page is wanted too.
                    if !loading, topVisible, model.paging.error == nil, keepAnchor == nil { pageUp() }
                }
                .task(id: keepAnchor) {
                    // The anchor only has to hold while the new rows are laid out.
                    guard keepAnchor != nil else { return }
                    try? await Task.sleep(for: .milliseconds(700))
                    if !Task.isCancelled, !model.paging.loading { keepAnchor = nil }
                }
            }
        }
    }

    private var rowIDs: [String] { rows.map(\.id) }

    private var earlierKind: TranscriptWindow.EarlierKind {
        let ids = rowIDs
        return TranscriptWindow.earlierKind(
            rowCount: ids.count, hidden: TranscriptWindow.hasHidden(rowIDs: ids, start: windowStart), paging: model.paging)
    }

    /// The scroll driver's word on whether the newest end is followed. Reaching it once lets the top page older rows in.
    private func markLive() {
        if model.transcriptPhase != .loading, liveFloor == nil { liveFloor = rows.count }
    }

    private func followChanged(_ following: Bool) {
        atBottom = following
        if following { reachedBottom = true }
    }

    /// Writes a measured height only when it moved by more than half a point: a measurement that feeds the frame it
    /// measured would otherwise relayout on sub-point jitter forever.
    @discardableResult
    private func setHeight(_ slot: inout CGFloat, _ new: CGFloat) -> Bool {
        guard HeightGuard.shouldWrite(old: slot, new: new) else { return false }
        slot = new
        return true
    }

    @ViewBuilder private func turnAndRows() -> some View {
        let footers = footers
        let rows = self.rows
        let insert = turnInsertIndex(in: rows)
        let turn = self.turn
        ForEach(indexedRows(rows, visible: TranscriptWindow.visible(
            rowIDs: rows.map(\.id), start: windowStart,
            turnIDs: rows.map { if case .message(let m, _) = $0 { m.turnId } else { nil } }))) { item in
            VStack(alignment: .leading, spacing: 0) {
                if item.index == insert { TurnBlockView(block: turn, filesLine: turnFilesLine).padding(.bottom, ChatSpacing.turnToMessage) }
                rowView(item.row, footers: footers)
            }
            .arrivalRise(atBottom && item.index >= (liveFloor ?? Int.max))
            .padding(.top, item.index == 0 ? ChatSpacing.turnToMessage : ChatSpacing.messageToMessage)
            .id(item.row.id)
        }
        if insert == rows.count { TurnBlockView(block: turn, filesLine: turnFilesLine).padding(.top, ChatSpacing.turnToMessage) }
        // What the agent is writing right now; the persisted message replaces it.
        if isNative, model.native.key == session.key {
            StreamingRow(buffer: model.native.stream) { text in
                rowView(.message(ChatMessage(id: "native-streaming", role: .assistant, text: text), muted: false))
            }
            .id("native-streaming")
        }
    }

    private struct IndexedRow: Identifiable {
        let index: Int
        let row: ChatTimeline.Row
        var id: String { row.id }
    }

    private func indexedRows(_ rows: [ChatTimeline.Row], visible: Range<Int>) -> [IndexedRow] { visible.map { IndexedRow(index: $0, row: rows[$0]) } }

    /// The agent's progress tracker (Squeak's update_progress), newest update of the turn; gone once cleared.
    private var tracker: ProgressTracker? {
        guard isNative, case .progress(let steps, let current, let percent, let status)? =
            model.activity.last(where: { $0.kind == "progress" })?.detail, !steps.isEmpty else { return nil }
        return ProgressTracker(steps: steps, current: current, percent: percent, status: status)
    }

    /// The live row, in the dock (§8.10): reserved while a turn runs, so nothing can clip it.
    private var liveRow: some View {
        WorkbenchLiveRow(
            steps: model.activity.filter { $0.kind != "progress" && $0.kind != "retry" }, since: TurnFolding.turnStart(messages: model.displayMessages, steps: model.activity),
            label: indicator.line(workingLabel: ChatTimeline.workingLabel(model.activity), model: chatModelName),
            onStop: canStop ? { stop() } : nil)
    }

    /// The footers of the finished turns (elapsed, time, copy), by their last message's id.
    private var footers: [String: TurnFooter] { rowCache.footers(model.displayMessages, working: liveState == .working) }

    @ViewBuilder private func rowView(_ row: ChatTimeline.Row, footers: [String: TurnFooter] = [:]) -> some View {
        if case .message(let m, let muted) = row {
            MessageRowView(
                message: m, agentName: agent, canOpenHost: model.openURL != nil, agentWorking: liveState == .working,
                layout: choiceLayout(for: m, muted: muted),
                canAnswer: sendBlock == nil && model.isReachable(session), onChoose: choose, muted: muted,
                history: historyHandle(for: m), footer: footers[m.id]
            )
            .equatable()
        }
    }

    private func choiceLayout(for m: ChatMessage, muted: Bool) -> ChoiceLayout? {
        guard !muted, m.id == needsYouMessageID, model.askCardDisplay(for: session.key) == nil else { return nil }
        return rowCache.choiceLayout(for: m)
    }

    private var topFade: some View {
        VStack(spacing: 0) {
            LinearGradient(colors: [.clear, .black], startPoint: .top, endPoint: .bottom).frame(height: 24)
            Rectangle()
        }
    }

    /// The reader reached the top: render older rows already loaded, else ask the host for the next page. Either way the
    /// row they were on stays put (`keepAnchor`). From the host (`fromHost`) the page has just landed in front.
    private func pageUp(fromHost: Bool = false) {
        guard reachedBottom, fromHost || !model.paging.loading else { return }
        let ids = rowIDs
        if let e = TranscriptWindow.expanded(rowIDs: ids, start: windowStart) {
            keepAnchor = e.anchor
            windowStart = e.start
        } else if !fromHost, model.paging.canLoad, model.paging.known, !ids.isEmpty {
            let first = ids[TranscriptWindow.startIndex(rowIDs: ids, start: windowStart)]
            keepAnchor = first
            windowStart = first
            model.loadEarlier()
        }
    }

    private func note(_ symbol: LucideName, _ title: String, _ message: String) -> some View {
        VStack(spacing: Space.s) {
            Lucide(symbol, size: 28, color: Theme.subtle)
            Text(title).font(Typo.heading)
            Text(message).font(Typo.body).foregroundStyle(Theme.muted).multilineTextAlignment(.center)
        }
        .frame(maxWidth: 340)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// A tool-permission block: Squeak cannot give it for a Conductor chat, so the card says where, with a link.
    /// No tool name, command or reason reaches the app today, so the card shows none (§8.2: never invent one).
    private var approvalCard: some View {
        ApprovalCardView(
            model: ApprovalCardModel(heading: WaitingKind.approval.words), agent: agent, actions: nil,
            unavailableNote: ApprovalWait.line,
            link: session.capabilities.openInHost.isSupported && (model.openURL != nil || model.demoMode)
                ? (title: "Open in \(model.openHostName ?? "app")", action: { model.openInHost() }) : nil)
    }

    /// An answer card or lettered options are waiting on the person and can still be answered.
    private var decisionPending: Bool {
        if let d = model.askCardDisplay(for: session.key) { return d.phase == .live }
        guard sendBlock == nil, model.isReachable(session), let id = needsYouMessageID,
              let m = model.displayMessages.first(where: { $0.id == id }) else { return false }
        return ChoiceLayout.make(m.text) != nil
    }

    private var composerFolded: Bool {
        ComposerFold.isFolded(decisionPending: decisionPending, expanded: composerExpanded, hasDraft: hasText || images.hasImages)
    }

    /// The agent's last message, when it is the last thing in the chat and the chat needs you.
    private var needsYouMessageID: String? {
        guard liveState != .working, liveState != .error, let last = model.displayMessages.last, last.role == .assistant else { return nil }
        return last.id
    }

    private func choose(_ c: ChoiceCard) {
        guard sendBlock == nil, model.isReachable(session) else { return }
        let key = session.key
        Task { _ = await model.send(c.letter, to: key, answering: true) }
    }

    /// Back to the newest message in one click (or ⌘↓): a round button while the end of the chat is out of view, a
    /// "New" pill when something arrived meanwhile.
    private func jumpButton() -> some View {
        ZStack {
            if TranscriptPin.jumpButtonVisible(atBottom: atBottom, rowCount: rows.count) {
                Button {
                    newBelow = false
                    jumpToken += 1
                } label: {
                    HStack(spacing: 6) {
                        Lucide(.chevronDown, size: 14, color: Theme.ink)
                        if newBelow { Text("New").font(Typo.meta.weight(.semibold)).foregroundStyle(Theme.ink) }
                    }
                    .padding(.horizontal, newBelow ? 12 : 0)
                    .frame(minWidth: 28, minHeight: 28)
                    .background(Theme.surfaceRaised, in: Capsule())
                    .overlay(Capsule().stroke(Theme.line))
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .help("Jump to the newest message (⌘↓)")
                .accessibilityLabel(newBelow ? "New messages. Jump to the newest" : "Jump to the newest message")
                .keyboardShortcut(.downArrow, modifiers: [.command])
                .transition(Motion.pop)
            }
        }
        .offset(y: -44)
        .animation(Motion.standard, value: atBottom)
        .animation(Motion.standard, value: newBelow)
    }

    // MARK: Bottom bar: summary line and the floating composer

    private var bottomBar: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let tracker { tracker }
            if indicator.isActive || isWorking || hostSaysWorking {
                liveRow
            } else if WorkbenchNav.attention(model) != nil {
                HStack {
                    Spacer(minLength: 0)
                    NextAttentionPill()
                }
                .frame(height: 40)
            }
            if let extras = model.chatExtras, liveState == .working {
                if let stall = extras.stalled {
                    StuckCard(stall: stall) { Task { await model.stopChat(session) } }
                }
                if !extras.background.isEmpty {
                    BackgroundStrip(extras: extras, crowded: extras.stalled != nil)
                }
            }
            if let note = model.chatNote {
                HStack(spacing: 8) {
                    Text(verbatim: note).font(Typo.meta).foregroundStyle(Theme.negative)
                    ReportProblemButton(problem: note, place: "Conversation", title: "Report")
                }
                .padding(.leading, 4)
            }
            if isNative, let note = model.native.note {
                HStack(spacing: 8) {
                    Text(verbatim: note).font(Typo.meta).foregroundStyle(Theme.muted)
                    if let retry = model.native.retry { Button("Retry", action: retry).buttonStyle(.plain).font(Typo.meta.weight(.semibold)).foregroundStyle(Theme.ink) }
                }
                .padding(.leading, 4)
            }
            if session.source == .conductor {
                QueueStack(model: model, sessionId: session.key.hostSessionId, isWorking: working,
                           onEdit: { model.setDraft($0) })
            } else if isNative {
                NativeQueueStack(session: session)
            }
            if let card = nativeCard { pinnedCard(card) }
            if composerFolded {
                Button { composerExpanded = true; focusToken += 1 } label: {
                    Text(ComposerFold.foldedTitle).font(Typo.label).foregroundStyle(Theme.muted)
                        .padding(.horizontal, Space.s).frame(height: Metrics.button).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(ComposerFold.foldedTitle)
            } else {
                composer
            }
            // The old "send / new line" hint row is gone; only a problem in words keeps a line.
            if !composerFolded {
                Group {
                    if let problem = problemNote {
                        ComposerHintLine(problem: problem, keys: [], help: destinationNote)
                    } else {
                        Color.clear.frame(height: 0)
                    }
                }
                    .task(id: model.serviceDown(session)) {
                        while model.serviceDown(session), !Task.isCancelled {
                            model.probeService()
                            try? await Task.sleep(for: .seconds(2.5))
                        }
                    }
            }
        }
        .onChange(of: decisionPending) { _, pending in if !pending { composerExpanded = false } }
        .padding(.horizontal, Metrics.readingInset)
        .frame(maxWidth: Metrics.readingColumn + 2 * Metrics.readingInset)
        .padding(.top, 8)
        .padding(.bottom, 8)
        .frame(maxWidth: .infinity)
        .squeakWindowCanvas()
    }

    /// The request the agent waits on, directly above the composer. A long plan scrolls inside its own box.
    @ViewBuilder private func pinnedCard(_ card: NativeCard) -> some View {
        let view = NativeNeedsYouCard(session: session, card: card, focusComposer: { composerExpanded = true; focusToken += 1 }).id(card.id)
        if card.kind == .plan { ScrollView { view }.frame(maxHeight: 340) } else { view }
    }

    // MARK: Composer

    private var sendBlock: String? {
        if case .unsupported(let why) = session.capabilities.send { return why }
        if session.replyTarget == nil { return "Squeak has no way to reply to this chat." }
        return nil
    }

    private var composerPhase: ComposerPhase {
        if let card = nativeCard {
            switch card.kind {
            case .approval: return .approval
            case .plan: return .plan
            case .question: return .question
            }
        }
        if let d = model.askCardDisplay(for: session.key), d.phase == .live { return d.ask.kind == .plan ? .plan : .question }
        if ApprovalWait.isWaiting(state: session.state, awaitingApproval: session.awaitingApproval, hasQuestionCard: false) { return .approval }
        if decisionPending { return .question }
        return working ? .working : .idle
    }

    private var placeholder: String {
        ComposerPrompt.placeholder(
            agent: agent, workspace: model.sidebarTree.place(of: session.key)?.workspace.displayTitle, phase: composerPhase,
            readOnlyReason: sendBlock, offline: model.isOffline(for: session))
    }

    /// A reason the chat cannot be answered right now, in the hint line's place.
    private var problemNote: String? {
        if let why = sendBlock { return "Can't reply here: \(why)" }
        if model.isOffline(for: session) { return "Not connected. Replies wait until Squeak's service is back." }
        if model.serviceDown(session) { return "Reconnecting to Squeak's service… Send tries again." }
        return nil
    }

    private var hintKeys: [KeyHint] {
        if let card = nativeCard {
            switch card.kind {
            // With words in the composer a bare ↵ or ⌫ is the text's; the ⌘ forms and the typed reply remain.
            case .approval:
                return hasText
                    ? [KeyHint(key: "↵", label: "denies with your words"), KeyHint(key: "⌘↵", label: "allow for this chat"), KeyHint(key: "⌘⌫", label: "deny")]
                    : [KeyHint(key: "↵", label: "allow once"), KeyHint(key: "⌘↵", label: "this chat"), KeyHint(key: "⌫", label: "deny")]
            case .plan:
                return hasText
                    ? [KeyHint(key: "↵", label: "sends your note"), KeyHint(key: "⌘↵", label: "approve"), KeyHint(key: "⌘⌫", label: "keep planning")]
                    : [KeyHint(key: "↵", label: "approve"), KeyHint(key: "⌫", label: "keep planning")]
            case .question:
                return hasText
                    ? [KeyHint(key: "↵", label: "sends your own answer"), KeyHint(key: "⌘1–9", label: "answer")]
                    : [KeyHint(key: "1–9", label: "answer"), KeyHint(key: "0", label: "other")]
            }
        }
        return ComposerHints.keys(phase: composerPhase, canStop: canStop)
    }

    private var destinationNote: String {
        if let why = sendBlock { return "Can't reply here: \(why)" }
        if model.isOffline(for: session) { return "Not connected. Replies wait until Squeak's service is back." }
        if model.serviceDown(session) { return "Reconnecting to Squeak's service… Send tries again." }
        if working {
            return queueSteerExplained
                ? "↵ queues after this turn · ⌘↵ steers now"
                : "↵ queues it until \(agent) finishes this turn. ⌘↵ steers it into the turn now."
        }
        return "Replies go to \(session.source.replyDestination)."
    }

    /// While the agent is mid-turn a message is either queued behind the turn or steered into it.
    private var working: Bool { liveState == .working }

    private var hasText: Bool { !model.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
    /// While a card waits the duck primary is on the card and Send is off (DESIGN.md §8.10).
    private var canSend: Bool { nativeCard == nil && sendBlock == nil && model.isReachable(session) && (hasText || images.hasImages) }

    private func cardReply(_ text: String) {
        guard let card = nativeCard else { return }
        switch card.kind {
        case .approval: model.nativeDeny(session, message: text)
        case .plan: model.nativeKeepPlanning(session, message: text)
        case .question: model.nativeAnswer(session, option: nil, other: text); model.setDraft("")
        }
    }

    private var composer: some View {
        let editable = sendBlock == nil && model.isReachable(session)
        return ChatComposerBox(
            text: Binding(get: { model.draft }, set: { model.setDraft($0) }),
            placeholder: placeholder, editable: editable, focusToken: focusToken,
            chatID: session.key.hostSessionId,
            tray: editable && session.capabilities.attachments.isSupported ? images : nil,
            canSend: canSend, working: working, agent: agent,
            sendHelp: session.capabilities.attachments.reason.map { "Send (↵). Attachments: \($0)" } ?? "Send (↵). Paste, drop or + attaches images",
            sendDefault: model.sendDefault,
            onSend: { send($0) },
            phase: composerPhase, canStop: canStop, onStop: stop,
            mode: ComposerMode.chip(source: session.source, mode: isNative && model.native.key == session.key ? model.native.mode : nil),
            onMode: isNative ? { model.nativeSetMode(session, $0) } : nil,
            cardReply: nativeCard == nil ? nil : { cardReply($0) },
            contextText: session.contextTokens.flatMap { t in session.contextLimit.flatMap { ContextFormat.tooltip(tokens: t, limit: $0) } } ?? ContextLeft.text(used: session.contextPercent),
            contextLow: UsageFormat.contextIsLow(session.contextPercent),
            contextUsed: session.contextPercent,
            picker: pickerSource
        ) {
            if let extras = model.chatExtras, session.conductorSessionId != nil {
                ChatSetupLine(session: session, extras: extras, inline: true)
            } else if isNative {
                NativeModelMenu(session: session)
            }
        }
    }

    /// `@` lists the chat's folder; `/` lists a Claude chat Squeak runs by its init message, else custom commands.
    private var pickerSource: ComposerPickerSource? {
        guard let cwd = session.cwd, !cwd.isEmpty else { return nil }
        let host = model.nativeHost, hostId = session.key.hostSessionId
        let nativeClaude = isNative && session.agent == "claude"
        return ComposerPickerSource(
            folder: cwd,
            commands: {
                let custom = SlashCommands.custom(cwd: cwd)
                guard nativeClaude, let rows = try? await host.messages(id: hostId, after: 0, limit: 60) else { return custom }
                let fromInit = SlashCommands.fromInit(rows)
                return fromInit.isEmpty ? custom : SlashCommands.merged(fromInit, custom: custom)
            },
            identity: session.key.hostSessionId + "|" + cwd)
    }

    private func send(_ mode: SendMode) {
        let typed = model.draft
        guard canSend else { return }
        // Images are saved into the chat's folder only now; if that fails nothing is sent and everything stays.
        guard let t = images.prepareToSend(text: typed, folder: session.cwd) else { return }
        let sentImages = images.hasImages
        let key = session.key
        // The mode only means something mid-turn; an idle chat is simply sent.
        let effective: SendMode = working ? mode : .queue
        if working { queueSteerExplained = true }
        // The field clears as it sends and keeps focus, so the next message can be typed at once.
        focusToken += 1
        if sentImages { images.clear() }
        Task { _ = await model.send(t, to: key, mode: effective) }
    }
}

/// The transcript column at one exact width once the container is measured (`TranscriptColumn.fixedWidth`), so the stack
/// is proposed a single width and its text is typeset once per width; the flexible cap only until the first reading.
private struct TranscriptColumnWidth: ViewModifier {
    let container: CGFloat
    let cap: CGFloat

    func body(content: Content) -> some View {
        // One view shape either way (identity stays put when the first reading lands).
        let width = TranscriptColumn.fixedWidth(container: container, cap: cap)
        return content.frame(minWidth: width ?? 0, maxWidth: width ?? cap)
    }
}
