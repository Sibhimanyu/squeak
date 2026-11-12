import AppKit
import SqueakMacCore
import SwiftUI

/// DESIGN.md §7. The only file that builds an `Animation`: everything else says `Motion.quick`, `.standard`,
/// `.emphasis` or `.none`. Reduce Motion is read here, once: movement becomes opacity-only and durations drop to
/// `quick`. Never animate a value that changes many times a second (streaming text, timers, scroll-follow) and
/// never a frame size of the transcript: animate opacity, offset or scale on fixed-size containers.
enum Motion {
    static var reduceMotion: Bool { NSWorkspace.shared.accessibilityDisplayShouldReduceMotion }

    private static func ease(_ token: MotionToken) -> Animation {
        .easeOut(duration: token.resolved(reduceMotion: reduceMotion).duration)
    }

    /// 120 ms ease-out: hover, press release, small toggles.
    static var quick: Animation { ease(.quick) }
    /// 200 ms ease-out: panels, sidebar, tab insert/remove, popovers, list insert/remove.
    static var standard: Animation { ease(.standard) }
    /// 320 ms ease-out: sheets and onboarding only.
    static var emphasis: Animation { ease(.emphasis) }
    /// No animation: streaming text, timers, scroll-follow.
    static let none: Animation? = nil

    /// Loops (duck and tab pulses, the update artwork). Callers skip them under Reduce Motion.
    static var pulse: Animation { .easeInOut(duration: 0.9).repeatForever(autoreverses: true) }
    static var drift: Animation { .easeInOut(duration: 3.0).repeatForever(autoreverses: true) }
    static var pulseStep: Animation { .easeInOut(duration: 0.9) }

    /// The sidebar column sizer, in step with its AppKit twin (same duration and curve).
    static func column(duration: Double) -> Animation? {
        reduceMotion ? nil : .timingCurve(1.0 / 3, 0, 2.0 / 3, 1, duration: duration)
    }

    /// Press-down is instant, release eases at `quick`. Use as `.animation(Motion.release(pressed), value: pressed)`.
    static func release(_ isPressed: Bool) -> Animation? { isPressed ? nil : quick }

    /// A pane or panel entering on an edge; Reduce Motion crossfades with no travel.
    static func slide(_ edge: Edge) -> AnyTransition {
        reduceMotion ? .opacity : .move(edge: edge).combined(with: .opacity)
    }

    /// A fold's children: fade, with a short drop from the top.
    static var fold: AnyTransition {
        reduceMotion ? .opacity : .opacity.combined(with: .offset(y: -4))
    }

    /// A message that arrives while following: fade and a slight rise (at most 6 pt).
    static var rise: AnyTransition {
        reduceMotion ? .opacity : .opacity.combined(with: .offset(y: CGFloat(MotionRules.maxRise)))
    }

    /// A small control or card appearing: fade, with a scale from just under full size.
    static var pop: AnyTransition {
        reduceMotion ? .opacity : .opacity.combined(with: .scale(scale: 0.96))
    }
}

/// A message arriving while the person follows the chat: fades in with a rise of at most 6 pt. Opacity and offset
/// only (a compositing change, never a relayout), and only when `enabled` at the row's first appearance: history
/// loads and paging older rows never animate.
struct ArrivalRise: ViewModifier {
    @State private var shown: Bool

    init(enabled: Bool) { _shown = State(initialValue: !enabled) }

    func body(content: Content) -> some View {
        content
            .opacity(shown ? 1 : 0)
            .offset(y: shown || Motion.reduceMotion ? 0 : CGFloat(MotionRules.maxRise))
            .onAppear { if !shown { withAnimation(Motion.standard) { shown = true } } }
    }
}

extension View {
    func arrivalRise(_ enabled: Bool) -> some View { modifier(ArrivalRise(enabled: enabled)) }

    /// `.animation` at a token, for a value that changes only when the person acts.
    func motion<V: Equatable>(_ a: Animation?, value: V) -> some View { animation(a, value: value) }

    /// Pressed state shows at once; release eases at `quick`.
    func pressFeedback(_ isPressed: Bool) -> some View { animation(Motion.release(isPressed), value: isPressed) }
}
