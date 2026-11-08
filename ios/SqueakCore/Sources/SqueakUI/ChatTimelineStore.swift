import Foundation
import Observation
import SqueakCore
import SwiftUI

/// What a chat drew, whole: the rows and the snapshot they were built from, so a card that belongs to the
/// session's state arrives in the same swap as the rows around it.
struct TimelineFrame: Equatable {
    let rows: [ChatTimeline.Row]
    let session: PhoneSnapshot.Session
    let total: Int
    let live: Bool
}

/// Everything a timeline is built from. Equal inputs build equal frames, so an unchanged one costs nothing.
struct TimelineInput: Equatable {
    var session: PhoneSnapshot.Session
    var remembered: RememberedMessage?
    var sends: [ChatSend]
    var live: LiveTurn?
    var cachedHistory: [LiveTurn.HistoryEntry]?
    /// How far this phone's clock runs ahead of the Mac's (`ClockSkew.offset`): the Mac's times are read on it.
    var offset: TimeInterval = 0

    func build(now: Date = Date(), idleFor: TimeInterval? = nil, heldSteps: [LiveTurn.Step]? = nil) -> TimelineFrame {
        let rows = ChatTimeline.rows(session: session, remembered: remembered, sends: sends, live: live,
                                     cachedHistory: cachedHistory, now: now, idleFor: idleFor, heldSteps: heldSteps,
                                     offset: offset)
        let working = live?.working == true
        return TimelineFrame(rows: rows, session: session, total: working ? live?.total ?? 0 : session.activity?.total ?? 0, live: working)
    }

    /// The chat's own history is known (cached, or the Mac's live document has arrived).
    var historyKnown: Bool { cachedHistory != nil || live?.history != nil }
}

/// Holds a chat's timeline for the screen and changes it in one batched swap with animations off, instead of
/// rebuilding it on every piece of data. It opens on the last frame the chat had (kept by `AppModel`), or on a
/// placeholder until the history is known (at most `placeholderLimit`), then applies what arrives at most once per
/// `UpdateCoalescer.window`; the person's own sends apply at once.
@MainActor @Observable
final class ChatTimelineStore {
    /// How long a chat with nothing cached waits for its history before showing what it has.
    static let placeholderLimit: TimeInterval = 0.6

    /// Nil while the placeholder shows.
    private(set) var frame: TimelineFrame?
    /// Bumped on every swap that changed the rows, so controls can restart their settle time.
    private(set) var swaps = 0

    @ObservationIgnored private var input: TimelineInput?
    @ObservationIgnored private var coalescer = UpdateCoalescer()
    @ObservationIgnored private var pending: Task<Void, Never>?
    @ObservationIgnored private let sleep: @Sendable (TimeInterval) async -> Void
    @ObservationIgnored private let clock: @Sendable () -> Date
    /// Called with every frame shown, to keep it for the next visit.
    /// When the open chat was first seen not working (nil while it works), and its last live steps, for holding.
    @ObservationIgnored private var idleSince: Date?
    @ObservationIgnored private var lastSteps: (steps: [LiveTurn.Step], turnId: String?)?
    /// The chat `idleSince` and `lastSteps` belong to: the store is reused when another chat opens.
    @ObservationIgnored private var heldKey: String?
    @ObservationIgnored var onFrame: ((TimelineFrame) -> Void)?

    init(sleep: @escaping @Sendable (TimeInterval) async -> Void = { try? await Task.sleep(for: .seconds($0)) },
         clock: @escaping @Sendable () -> Date = { Date() }) {
        self.sleep = sleep
        self.clock = clock
    }

    /// Offer the newest inputs. `seed` is the frame from the last visit, used only on the first call.
    func submit(_ new: TimelineInput, seed: TimelineFrame? = nil) {
        if frame == nil, input == nil, let seed, seed.session.key == new.session.key {
            apply(seed, notify: false)
        }
        let previous = input
        guard new != previous else { return }
        input = new
        let now = clock()
        // The person's own send, or the first look when everything needed is here: no waiting.
        let urgent = previous.map { $0.sends != new.sends || $0.session.key != new.session.key }
            ?? false
        let firstReady = frame == nil && (new.historyKnown || !new.sends.isEmpty)
        switch coalescer.offer(at: now, urgent: urgent || firstReady,
                               delay: frame == nil ? Self.placeholderLimit : nil) {
        case .now:
            pending?.cancel()
            flush()
        case .pending:
            // Rides along with the swap already due.
            break
        case .schedule(let due):
            pending?.cancel()
            let wait = max(0, due.timeIntervalSince(now))
            pending = Task { [weak self, sleep] in
                await sleep(wait)
                guard !Task.isCancelled else { return }
                self?.flush()
            }
        }
    }

    /// Waits for a scheduled swap (tests).
    func settle() async { await pending?.value }

    private func flush() {
        coalescer.flushed()
        pending = nil
        guard let input else { return }
        let now = clock()
        if heldKey != input.session.key { heldKey = input.session.key; idleSince = nil; lastSteps = nil }
        if input.session.state == "working" { idleSince = nil } else if idleSince == nil { idleSince = now }
        // The live steps are held for as long as the chat keeps working, so the snapshot's six (which carry no
        // times) never swap in under a live turn; they go when the chat has rested, or its turn is another one.
        if let rested = idleSince, now.timeIntervalSince(rested) >= ChatTimeline.idleHold { lastSteps = nil }
        if let last = lastSteps, last.turnId != input.session.turnId { lastSteps = nil }
        if let live = input.live, live.working, !live.steps.isEmpty { lastSteps = (live.steps, input.session.turnId) }
        let held = lastSteps?.steps
        let idleFor = idleSince.map { now.timeIntervalSince($0) }
        apply(input.build(now: now, idleFor: idleFor, heldSteps: held), notify: true)
        // A steer held through a moment of rest is let go on its own once the hold passes.
        if let idleFor, idleFor < ChatTimeline.idleHold {
            let wait = ChatTimeline.idleHold - idleFor + 0.05
            pending = Task { [weak self, sleep] in
                await sleep(wait)
                guard !Task.isCancelled else { return }
                self?.flush()
            }
        }
    }

    private func apply(_ new: TimelineFrame, notify: Bool) {
        guard new != frame else { return }
        let rowsChanged = new.rows != frame?.rows
        // One swap, never animated: rows arriving must not slide while the scroll view holds the bottom.
        var transaction = Transaction()
        transaction.disablesAnimations = true
        withTransaction(transaction) {
            frame = new
            if rowsChanged { swaps += 1 }
        }
        if notify { onFrame?(new) }
    }
}

/// The last frame of the most recently open chats, newest kept.
struct TimelineFrameCache {
    static let limit = 12
    private var frames: [String: TimelineFrame] = [:]
    private var order: [String] = []

    func frame(for key: String) -> TimelineFrame? { frames[key] }

    mutating func keep(_ frame: TimelineFrame, for key: String) {
        frames[key] = frame
        order.removeAll { $0 == key }
        order.append(key)
        while order.count > Self.limit { frames[order.removeFirst()] = nil }
    }
}
