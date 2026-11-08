#if os(iOS)
import SqueakCore
import SwiftUI
import UIKit

/// The phone's one set of haptics (`HapticMap` says which moment feels how). Generators are kept prepared, so a
/// tap feels at once. The system's own haptics setting applies by itself: UIKit plays nothing when it is off.
@MainActor
enum Haptics {
    private static let light = UIImpactFeedbackGenerator(style: .light)
    private static let firm = UIImpactFeedbackGenerator(style: .medium)
    private static let selection = UISelectionFeedbackGenerator()
    private static let notification = UINotificationFeedbackGenerator()
    private static var last: (at: Date, kind: HapticKind)?

    /// Wakes the engine ahead of a likely tap (a screen appearing, a press beginning).
    static func prepare() {
        light.prepare(); firm.prepare(); selection.prepare(); notification.prepare()
    }

    static func play(_ event: HapticEvent) {
        let kind = HapticMap.kind(event)
        let now = Date()
        guard HapticMap.plays(kind, sinceLast: last.map { now.timeIntervalSince($0.at) }, last: last?.kind) else { return }
        last = (now, kind)
        switch kind {
        case .light: light.impactOccurred(); light.prepare()
        case .selection: selection.selectionChanged(); selection.prepare()
        case .firm: firm.impactOccurred(); firm.prepare()
        case .success: notification.notificationOccurred(.success)
        case .warning: notification.notificationOccurred(.warning)
        case .error: notification.notificationOccurred(.error)
        }
    }
}

extension View {
    /// A feeling on the tap itself, for a control with no action of its own to put it in (a row that navigates).
    /// Simultaneous, so it never takes the touch from the control.
    func tapHaptic(_ event: HapticEvent) -> some View {
        simultaneousGesture(TapGesture().onEnded { Haptics.play(event) })
    }
}

extension Binding {
    /// The same binding that feels something only when the person changes it (not when the Mac's value moves it).
    func haptic(_ event: HapticEvent) -> Binding<Value> {
        Binding(get: { wrappedValue }, set: { Haptics.play(event); wrappedValue = $0 })
    }
}
#endif
