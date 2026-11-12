import Foundation

/// A thread's own name, as the person types it (Rename…). The host enforces the same rule (1-200 characters, one line);
/// checking here only spares a round trip and lets the prompt say why.
public enum ThreadTitle {
    public static let maxLength = 200

    public enum Problem: Error, Equatable, Sendable {
        case empty, tooLong

        public var words: String {
            switch self {
            case .empty: "A thread's name can't be empty."
            case .tooLong: "A thread's name is at most \(ThreadTitle.maxLength) characters."
            }
        }
    }

    /// The trimmed, single-line name, or why it is refused. Line breaks inside the text fold to one space.
    public static func check(_ raw: String) -> Result<String, Problem> {
        let flat = raw.split(whereSeparator: { $0.isNewline }).map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }.joined(separator: " ")
        if flat.isEmpty { return .failure(.empty) }
        if flat.count > maxLength { return .failure(.tooLong) }
        return .success(flat)
    }

    /// Only Squeak's own chats can be renamed: the host owns their names. Conductor and terminal threads carry theirs.
    public static func canRename(_ s: HostSession) -> Bool { s.source == .squeak && NativeAdapter.nativeId(s) != nil }
}
