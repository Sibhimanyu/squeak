import Foundation

/// A Send press, from the moment of the press until the host answers. The Mac decides nothing about the message
/// itself (the host owns waiting messages and steers); it only remembers what it drew on the press, so the right
/// pieces are settled when the host replies, and nothing is drawn twice.
///
/// `press` returns what to draw at once (a working look, a card, a timeline row); `settle` returns what to do with
/// each when the answer arrives. Both are pure: `AppModel.send` only carries the effects out.
public struct PressLedger: Equatable, Sendable {
    /// What the press knows about the chat when it is pressed.
    public struct Context: Equatable, Sendable {
        public var mode: SendMode
        /// The chat is working (or its turn is open): the message goes behind or into that turn.
        public var midTurn: Bool
        /// A Squeak chat the Mac has open (its message list is the host's).
        public var isOpenSqueakChat: Bool
        /// The open chat is drawn from the host's timeline: every press is a row of it.
        public var onTimeline: Bool
        /// A working chat of an add-on's host: a queued message shows in its queue stack before the daemon answers.
        public var addonHostWorking: Bool
        /// The words clear the draft on a press (they go back to it when nothing was sent).
        public var clearsDraft: Bool

        public init(
            mode: SendMode, midTurn: Bool, isOpenSqueakChat: Bool, onTimeline: Bool, addonHostWorking: Bool, clearsDraft: Bool
        ) {
            self.mode = mode
            self.midTurn = midTurn
            self.isOpenSqueakChat = isOpenSqueakChat
            self.onTimeline = onTimeline
            self.addonHostWorking = addonHostWorking
            self.clearsDraft = clearsDraft
        }
    }

    /// What to draw at the press. Each is "just pressed, not confirmed" until `settle`.
    public struct Plan: Equatable, Sendable {
        public let nonce: UUID
        /// The chat reads working from the press (not when it is already mid-turn).
        public let beginsWorking: Bool
        /// A timeline row named by the nonce the host echoes.
        public let timelineRow: Bool
        /// An older host's chat: a card in the queue stack, kept locally.
        public let localCard: Bool
        /// An add-on host's queue stack card.
        public let queueCard: Bool
        /// The transport echoes the message into the local transcript (only when nothing else draws it).
        public var echoes: Bool { !localCard && !timelineRow }
        let context: Context
    }

    /// What to do when the host answers.
    public struct Settlement: Equatable, Sendable {
        public enum LocalCard: Equatable, Sendable {
            case none
            case settle(accepted: Bool, queued: Bool)
        }
        public enum QueueCard: Equatable, Sendable {
            case none
            case accepted
            case failed(reason: String, unclear: Bool)
        }
        public var localCard: LocalCard = .none
        /// Re-read the host's pending list now (an accepted press with a local card).
        public var refreshPending = false
        /// The chat is not working after all.
        public var endsWorking = false
        /// The timeline row did not go: mark it not sent.
        public var timelineFailure: String?
        public var queueCard: QueueCard = .none
        /// Nothing left our hands and no card holds the words: they return to the draft.
        public var restoresDraft = false
        /// The host accepted it (a moved chat may need opening, a preset split noted).
        public var accepted = false
    }

    /// Presses not yet answered, by nonce. Only these are "unconfirmed"; the host's list is everything else.
    public private(set) var inFlight: [UUID: Plan] = [:]

    public init() {}

    public var isEmpty: Bool { inFlight.isEmpty }

    public mutating func press(_ context: Context, nonce: UUID = UUID()) -> Plan {
        let local = context.midTurn && !context.onTimeline && context.isOpenSqueakChat
        let plan = Plan(
            nonce: nonce,
            beginsWorking: !context.midTurn,
            timelineRow: context.onTimeline,
            localCard: local,
            queueCard: context.mode == .queue && context.addonHostWorking,
            context: context)
        inFlight[nonce] = plan
        return plan
    }

    /// The host answered (or the press failed): everything the press drew is settled once, then forgotten.
    public mutating func settle(_ nonce: UUID, _ result: SendResult) -> Settlement {
        guard let plan = inFlight.removeValue(forKey: nonce) else { return Settlement() }
        var out = Settlement()
        switch result {
        case .accepted:
            out.accepted = true
            if plan.localCard {
                out.localCard = .settle(accepted: true, queued: result.isQueuedDelivery)
                out.refreshPending = true
            }
            if plan.queueCard { out.queueCard = .accepted }
        case .uncertain(let reason):
            if plan.localCard { out.localCard = .settle(accepted: true, queued: true) }
            if plan.queueCard { out.queueCard = .failed(reason: reason, unclear: true) }
        case .refused(let reason), .notSent(let reason):
            if plan.localCard { out.localCard = .settle(accepted: false, queued: false) }
            if plan.beginsWorking { out.endsWorking = true }
            if plan.timelineRow { out.timelineFailure = reason }
            if plan.queueCard { out.queueCard = .failed(reason: reason, unclear: false) }
            out.restoresDraft = !plan.queueCard && plan.context.clearsDraft
        }
        return out
    }
}

extension SendResult {
    /// Accepted as a queued message (a card in the queue, not a steer or a plain send).
    fileprivate var isQueuedDelivery: Bool {
        if case .accepted(_, let delivery, _) = self { return delivery == .queued }
        return false
    }
}
