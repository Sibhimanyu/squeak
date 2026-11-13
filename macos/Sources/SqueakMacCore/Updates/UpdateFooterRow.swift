import Foundation

/// The sidebar footer's update area, per state: one muted status line, then plain-text actions, the first in `ink`
/// medium and the rest `muted`. No filled, bordered or coloured buttons (DESIGN.md, "Footer update states").
public enum UpdateFooterRow {
    public struct Item: Equatable, Sendable {
        public enum Kind: Equatable, Sendable { case flow(UpdateFlowCopy.Action), retryTermination, restartEngine, cancelWaiting, later }
        public let kind: Kind
        public let label: String
        /// The first action reads `ink` medium; every other one `muted` regular.
        public let primary: Bool
    }

    public static let retryTerminationLabel = "Try again"
    public static let engineRestartLabel = "Restart now"
    public static let waitingCancelLabel = "Cancel"
    public static let laterLabel = "Later"

    /// Actions for an update phase (status text comes from `UpdateFlowCopy.footerStatus`). `retryTermination` puts
    /// "Try again" first while an install waits on the app to quit; `available` carries Later beside Install.
    public static func items(_ phase: UpdateFlow.Phase, inPlaceDenied: Bool = false, canRetryTermination: Bool = false) -> [Item] {
        var kinds: [Item.Kind] = []
        if case .installing = phase, canRetryTermination { kinds.append(.retryTermination) }
        kinds += UpdateFlowCopy.footerActions(phase, inPlaceDenied: inPlaceDenied).map { .flow($0) }
        if case .available = phase, !inPlaceDenied { kinds.append(.later) }
        return kinds.enumerated().map { i, kind in Item(kind: kind, label: label(kind), primary: i == 0) }
    }

    /// "Install when free" is waiting: the muted line and a plain Cancel.
    public static func waitingItems() -> [Item] { [Item(kind: .cancelWaiting, label: waitingCancelLabel, primary: false)] }

    /// A deferred engine update: the muted line and "Restart now" (ink medium).
    public static func engineItems() -> [Item] { [Item(kind: .restartEngine, label: engineRestartLabel, primary: true)] }

    static func label(_ kind: Item.Kind) -> String {
        switch kind {
        case .flow(let a): UpdateFlowCopy.label(a)
        case .retryTermination: retryTerminationLabel
        case .restartEngine: engineRestartLabel
        case .cancelWaiting: waitingCancelLabel
        case .later: laterLabel
        }
    }
}
