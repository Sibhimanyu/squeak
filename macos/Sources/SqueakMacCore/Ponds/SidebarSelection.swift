import Foundation

/// What the sidebar may draw as selected: only the thing that is actually on screen.
public enum SidebarSelection {
    /// A stream row looks selected only while one of its chats is the open one and no page (a pond's home or
    /// settings, the Dashboard, Create, Usage, Settings) is covering it. The last-opened chat stays remembered
    /// behind a page, but it is not on screen, so it must not light its stream.
    public static func streamSelected(containsOpenChat: Bool, pageShowing: Bool) -> Bool {
        containsOpenChat && !pageShowing
    }
}
