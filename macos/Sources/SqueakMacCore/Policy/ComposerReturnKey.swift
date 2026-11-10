import Foundation

/// Resolve Return before AppKit's text-command translation, preserving IME composition,
/// multiline entry and application shortcuts such as Command-Option-Return to fork.
public enum ComposerReturnKey: Equatable, Sendable {
    case plain, command, option, newline, system

    public static func resolve(command: Bool, shift: Bool, option: Bool, control: Bool, composing: Bool) -> Self {
        if composing || control || (command && (option || shift)) { return .system }
        if command { return .command }
        if shift { return .newline }
        if option { return .option }
        return .plain
    }

    /// Keyboard intent is fixed, independently of the click-and-hold button's preference.
    public static func sendMode(working: Bool, command: Bool) -> SendMode {
        working && command ? .steer : .queue
    }
}
