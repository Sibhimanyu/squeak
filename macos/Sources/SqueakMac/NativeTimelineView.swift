import SwiftUI
import SqueakMacCore

// A Squeak chat's transcript, drawn from the timeline (`TurnTimeline`): one block per turn, keyed by the turn's row id;
// inside it the prompt, the turn's work and the agent's words, each keyed by its own step id. A row that exists is
// never replaced and never moves: data that arrives again changes nothing, and only a row that did not exist before fades in.

/// A newly inserted row fades in over a short beat. Opacity only: no offset, no scale, no relayout. Rows present when
/// the chat loaded, and rows added while the reader is up the page, never animate.
struct InsertFade: ViewModifier {
    @State private var shown: Bool

    init(enabled: Bool) { _shown = State(initialValue: !enabled) }

    func body(content: Content) -> some View {
        content
            .opacity(shown ? 1 : 0)
            .onAppear { if !shown { withAnimation(Motion.quick) { shown = true } } }
    }
}

extension View {
    func insertFade(_ enabled: Bool) -> some View { modifier(InsertFade(enabled: enabled)) }
}

/// The turns of the open chat. `message` draws a chat message (the prompt or one of the agent's) as the rest of the chat does.
struct NativeTurnsContent<Message: View, Queued: View>: View {
    let turns: [TimelineTurn]
    let details: [String: ToolDetail]
    /// The viewer's own member id in a pond (their prompts carry no name); nil on the owner's own Mac.
    var me: String?
    /// Turns at or past this index arrived after the chat loaded: they fade in (only while the reader follows the end).
    var fadeFrom: Int?
    var followsEnd: Bool
    var filesLine: (TimelineTurn) -> String?
    /// Steer steps whose card still waits at the bottom of the stream: drawn there, dimmed, not here.
    var hiddenSteers: Set<String> = []
    @ViewBuilder let message: (ChatMessage) -> Message
    /// The actions under a prompt still waiting in the queue (Steer / Edit / Remove).
    @ViewBuilder let queuedActions: (TimelineTurn) -> Queued

    var body: some View {
        ForEach(Array(turns.enumerated()), id: \.element.id) { index, turn in
            NativeTurnView(turn: turn, details: details, me: me, filesLine: filesLine(turn),
                           hiddenSteers: hiddenSteers.isEmpty ? [] : hiddenSteers.filter { id in turn.steps.contains { $0.id == id } },
                           message: message, queuedActions: queuedActions)
                .equatable()
                .insertFade(followsEnd && index >= (fadeFrom ?? Int.max))
                .padding(.top, index == 0 ? ChatSpacing.turnToMessage : ChatSpacing.messageToMessage)
                .id(turn.id)
        }
    }
}

/// Equatable on what it draws (the turn, the tool details, the viewer, the files line; never the message builder), so
/// a refresh that changed only the newest turn leaves every earlier turn's body unevaluated.
private struct NativeTurnView<Message: View, Queued: View>: View, Equatable {
    nonisolated static func == (a: NativeTurnView<Message, Queued>, b: NativeTurnView<Message, Queued>) -> Bool {
        a.turn == b.turn && a.me == b.me && a.filesLine == b.filesLine && a.details == b.details && a.hiddenSteers == b.hiddenSteers
    }

    let turn: TimelineTurn
    let details: [String: ToolDetail]
    let me: String?
    let filesLine: String?
    let hiddenSteers: Set<String>
    @ViewBuilder let message: (ChatMessage) -> Message
    @ViewBuilder let queuedActions: (TimelineTurn) -> Queued

    var body: some View {
        let segments = TimelineSteps.segments(of: turn, details: details, hiding: hiddenSteers)
        VStack(alignment: .leading, spacing: 0) {
            if let prompt = turn.promptMessage(me: me) { message(prompt) }
            if turn.state == .queued, turn.queuedId != nil { queuedActions(turn).padding(.top, 6) }
            ForEach(segments) { segment in
                switch segment {
                case .work(_, let steps, let live):
                    work(steps, live: live).padding(.top, ChatSpacing.turnToMessage)
                case .message(let id):
                    if let step = turn.steps.first(where: { $0.id == id }) {
                        message(turn.message(for: step)).padding(.top, ChatSpacing.messageToMessage)
                    }
                case .steer(_, let text, let author):
                    VStack(alignment: .leading, spacing: 2) {
                        if let name = TimelineLabels.author(author, me: me) {
                            Text(verbatim: name).font(Typo.meta).foregroundStyle(Theme.muted).lineLimit(1).accessibilityLabel("From \(name)")
                        }
                        SteerCard(text: text, state: .taken, cwd: nil)
                    }
                    .padding(.top, ChatSpacing.messageToMessage)
                }
            }
            if case .ended(.failed) = turn.state, let why = turn.error, !why.isEmpty {
                Text(verbatim: why).font(Typo.meta).foregroundStyle(Theme.warning)
                    .fixedSize(horizontal: false, vertical: true).textSelection(.enabled)
                    .padding(.top, ChatSpacing.messageToMessage)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private func work(_ steps: [ActivityStep], live: Bool) -> some View {
        if live {
            TurnBlockView(block: TurnFolding.block(steps: steps, working: true), filesLine: nil)
        } else if !TurnFolding.finished(steps: steps).folded.isEmpty {
            // A finished turn: one quiet line, "Worked for 1m 42s · 6 steps", that opens to its steps. Closed until asked.
            FoldedTurnView(steps: steps, steers: [], filesLine: filesLine)
        }
    }
}
