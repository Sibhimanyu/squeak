import Foundation

/// The one signal for "which chat is the person looking at": the conversation window is on screen and key, the centre of
/// the window is a chat (a Duck's tab or a thread), not a pond page or a file, diff or Notebook tab over it. Every surface that
/// decides unread or pending (sidebar badge, For you, Duck tab and row, notifications) reads this and `ChatReadTracker`, so
/// none can disagree with what is drawn.
public struct ChatLook: Equatable, Sendable {
    /// Key (`SessionKey.stringValue`) of the chat that is the centre of the window, whether or not the window is key.
    public var centreChat: String?
    /// The conversation window is on screen and key (not Settings, the quick composer or another app in front).
    public var windowKey: Bool
    /// The thread's newest end is in view (or within a screen of it).
    public var nearBottom: Bool

    public init(centreChat: String? = nil, windowKey: Bool = false, nearBottom: Bool = false) {
        self.centreChat = centreChat; self.windowKey = windowKey; self.nearBottom = nearBottom
    }

    /// Builds it from the live state. `locationChat`: the chat the location shows; `loadedChat`: the chat the model has loaded
    /// (they differ while a page covers the chat); `centreItemOpen`: a file, diff or Notebook tab is selected over the Duck.
    public static func make(locationChat: String?, loadedChat: String?, centreItemOpen: Bool, windowOnScreen: Bool, windowKey: Bool,
                            nearBottom: Bool) -> ChatLook {
        let centre = (locationChat != nil && locationChat == loadedChat && !centreItemOpen) ? locationChat : nil
        return ChatLook(centreChat: centre, windowKey: windowOnScreen && windowKey, nearBottom: nearBottom)
    }

    /// The chat being looked at, or nil.
    public var visibleChat: String? { windowKey ? centreChat : nil }

    /// No notification, and no unread update, for the chat in front.
    public func isLookingAt(_ chat: String) -> Bool { visibleChat == chat }

    /// A chat on screen and near its bottom reads every new turn as it arrives; this is what the lists use so a mark never
    /// flashes in the gap before the seen log is written.
    public func reads(_ chat: String) -> Bool { visibleChat == chat && nearBottom }
}

/// When a chat's finished turn counts as read. Opening a chat reads it (wherever it is scrolled); while it stays on screen
/// every new turn reads as it arrives as long as the thread is near its bottom; leaving and then a NEW finished turn is
/// unread again, because `ChatSeenLog` keeps the turn's end time that was read.
public struct ChatReadTracker: Equatable, Sendable {
    /// The chat whose opening has been recorded; nil while no chat is on screen.
    public private(set) var opened: String?

    public init() {}

    /// The chat whose current turn should be written to the seen log now, or nil. `available`: the chat's session is known
    /// (an opening is only recorded once there is something to record against).
    public mutating func settle(_ screen: ChatLook, available: Bool) -> String? {
        guard let chat = screen.visibleChat else { opened = nil; return nil }
        if opened != chat {
            guard available else { return nil }
            opened = chat
            return chat
        }
        return screen.nearBottom ? chat : nil
    }
}

public enum ReadGate {
    /// A stream is unread when any of its threads is; a pond when any of its streams is.
    public static func anyUnread(_ chats: [HostSession], isUnread: (HostSession) -> Bool) -> Bool { chats.contains(where: isUnread) }
}
