import Foundation

// DESIGN.md 8.12, Esc: step back one level. It never leaves full screen. Popovers, menus, suggestion lists (@ and /),
// sheets and inline editors handle Esc themselves before the window sees it (rung 1, kept first); what reaches the window is
// decided here, pure, so the key's behaviour is tested rather than discovered.

/// What the window does with an Esc nobody else took.
public enum EscapeStep: Equatable, Sendable {
    /// Nothing, but the key is still swallowed: Esc never exits full screen.
    case nothing
    /// Close the work pane (open).
    case closePane
    /// A Duck's chat: go to the Pond's Room.
    case toRoom
    /// The Room: go to the Pond's Dashboard.
    case toDashboard
}

public enum EscapeRule {
    /// Where the person is.
    public enum Page: Equatable, Sendable {
        case duckChat, room, dashboard
        /// Settings, Usage, composing, Archived, an artifact page: Esc does nothing here.
        case other
    }

    /// The first rung that applies wins. `overlayOpen` (a sheet or anything else that owns Esc) comes first and leaves the key to
    /// it. Esc is not bound to stopping a turn or clearing the
    /// composer anywhere, so `turnRunning` and a draft never change the step: a draft is kept per Duck and survives the move.
    /// The classic layout never navigates: it only swallows the key.
    public static func step(
        isNewLayout: Bool, overlayOpen: Bool, paneOpen: Bool, page: Page, turnRunning: Bool
    ) -> EscapeStep {
        guard isNewLayout, !overlayOpen else { return .nothing }
        if paneOpen { return .closePane }
        switch page {
        case .duckChat: return .toRoom
        case .room: return .toDashboard
        case .dashboard, .other: return .nothing
        }
    }
}
