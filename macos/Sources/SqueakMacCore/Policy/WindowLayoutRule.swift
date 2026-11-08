import Foundation

/// How the conversation window fits its width, decided apart from the view so CI can test it.
public enum WindowLayoutRule {
    /// With a chat open, a window narrower than this shrinks the sidebar to its icon rail on its own.
    public static let narrowWidth: CGFloat = 1150

    /// Whether the sidebar is an icon rail. `saved` is the person's own choice and is never rewritten here.
    /// A narrow window with a chat open collapses it unless the person widened it by hand since the window
    /// became narrow (`expandedByHand`); a wide window, or no chat, shows what they saved.
    public static func sidebarCollapsed(saved: Bool, chatOpen: Bool, windowWidth: CGFloat, expandedByHand: Bool) -> Bool {
        if saved { return true }
        return chatOpen && windowWidth < narrowWidth && !expandedByHand
    }

    /// The session list column hides only while a chat is open: with none, the list is the way to pick one.
    public static func listHidden(saved: Bool, chatOpen: Bool) -> Bool { saved && chatOpen }
}
