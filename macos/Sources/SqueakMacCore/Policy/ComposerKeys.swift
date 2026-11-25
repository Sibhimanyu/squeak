import Foundation

/// What a Return in the conversation composer does (DESIGN.md §8.10, keymap). While the agent works, ↵ does the
/// saved send default (steer unless a person chose queue) and ⌘↵ the other one; idle, both send. ⇧↵ is a new line.
public enum ComposerReturn: Sendable, Equatable {
    case plain, command, shift, shiftCommand
}

public enum ComposerKeyAction: Sendable, Equatable {
    case send, queue, steer, newLine
}

public enum ComposerKeys {
    public static func action(_ key: ComposerReturn, working: Bool, primary: SendMode = .steer) -> ComposerKeyAction {
        let first: ComposerKeyAction = primary == .steer ? .steer : .queue
        let second: ComposerKeyAction = primary == .steer ? .queue : .steer
        switch key {
        case .shift: return .newLine
        case .plain: return working ? first : .send
        case .command, .shiftCommand: return working ? second : .send
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
    public static func workingHint(canStop: Bool, primary: SendMode = .steer) -> String? {
        let first = primary == .steer ? "steer" : "queue"
        let second = primary == .steer ? "queue" : "steer"
        return "↵ \(first) · ⌘↵ \(second)" + (canStop ? " · ⌘. stop" : "")
    }
}
