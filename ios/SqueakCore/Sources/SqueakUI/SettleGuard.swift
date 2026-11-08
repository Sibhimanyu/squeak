import SwiftUI

private struct ChatSettleKey: EnvironmentKey {
    static let defaultValue = ChatSettleSignal()
}

extension EnvironmentValues {
    /// Set by the chat's scroll view: moves when the rows or the content's size change, and says when it scrolls.
    var chatSettle: ChatSettleSignal {
        get { self[ChatSettleKey.self] }
        set { self[ChatSettleKey.self] = newValue }
    }
}

/// The time a `SettleGuard` reads and waits on; tests give it their own.
struct SettleClock: Sendable {
    var now: @Sendable () -> Date
    var sleep: @Sendable (TimeInterval) async -> Void

    static let live = SettleClock(now: { Date() }, sleep: { try? await Task.sleep(for: .seconds(max(0, $0))) })
}

/// A control that sends something with one tap ignores touches until it has been on screen, and the layout
/// around it unmoved, for `SettleState.layoutSettle` (0.5 s), and for `scrollSettle` (0.3 s) after a scroll stops.
/// While the chat scrolls it ignores touches altogether, so the tap that stops a coasting list presses nothing.
/// It looks the same throughout: no dimming, no spinner. A touch it ignores falls through to the chat behind it.
struct SettleGuard: ViewModifier {
    @Environment(\.chatSettle) private var signal
    /// A VoiceOver double-tap is deliberate, never a stray touch on a moving screen: the guard stands aside.
    @Environment(\.accessibilityVoiceOverEnabled) private var voiceOver
    let clock: SettleClock
    @State private var state: SettleState
    @State private var settled = false
    /// The epoch this control last restarted for; nil until it has seen one change.
    @State private var seenEpoch: Int?
    @State private var tick = 0

    init(clock: SettleClock = .live) {
        self.clock = clock
        _state = State(initialValue: SettleState(appearedAt: clock.now()))
    }

    /// Read in the same pass as a new epoch, so there is no frame in which a moved layout still takes taps.
    private var open: Bool { voiceOver || (settled && !signal.scrolling && (seenEpoch ?? signal.epoch) == signal.epoch) }

    func body(content: Content) -> some View {
        content
            .allowsHitTesting(open)
            .onChange(of: signal.epoch) { _, epoch in
                seenEpoch = epoch
                state.layoutChanged(at: clock.now())
                settled = false
                tick += 1
            }
            .onChange(of: signal.scrolling) { _, scrolling in
                state.scrollChanged(scrolling: scrolling, at: clock.now())
                if scrolling { settled = false }
                tick += 1
            }
            .task(id: tick) {
                while !Task.isCancelled {
                    // A scroll in progress has no end yet: the change that ends it restarts this task.
                    guard let due = state.settledAt else { return }
                    let wait = due.timeIntervalSince(clock.now())
                    if wait <= 0 { settled = true; return }
                    await clock.sleep(wait)
                }
            }
    }
}

extension View {
    /// See `SettleGuard`.
    func settleGuard(clock: SettleClock = .live) -> some View { modifier(SettleGuard(clock: clock)) }
}
