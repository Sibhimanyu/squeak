import Foundation

/// What a Return in the conversation composer does (DESIGN.md §8.10, keymap). While the agent works, ↵ queues
/// the words behind the turn and ⌘↵ steers them into it; idle, ↵ sends. ⇧↵ is always a new line.
public enum ComposerReturn: Sendable, Equatable {
    case plain, command, shift, shiftCommand
}

public enum ComposerKeyAction: Sendable, Equatable {
    case send, queue, steer, newLine
}

public enum ComposerKeys {
    public static func action(_ key: ComposerReturn, working: Bool) -> ComposerKeyAction {
        switch key {
        case .shift: return .newLine
        case .plain: return working ? .queue : .send
        case .command: return working ? .steer : .send
        // ⇧⌘↵ stays the other way round for anyone used to it: the queue, while working.
        case .shiftCommand: return working ? .queue : .send
        }
    }

    /// The send mode a key action asks the host for; nil for a new line.
    public static func mode(_ action: ComposerKeyAction) -> SendMode? {
        switch action {
        case .send, .queue: .queue
        case .steer: .steer
        case .newLine: nil
        }
    }

    /// The composer's hint, drawn only while the agent works.
    public static func workingHint(canStop: Bool) -> String? {
        "↵ queue · ⌘↵ steer" + (canStop ? " · ⌘. stop" : "")
    }
}
