import Foundation

/// The one header of a diff tab and the review-all tab: the Duck, its branch, what the tab shows, and "Ask <Duck> to fix…".
public struct DiffTabHeader: Equatable, Sendable {
    public let duck: String
    public let branch: String?
    public let title: String
    /// The path when the tab is one file; nil for review-all.
    public let path: String?

    public init(duck: String, branch: String?, path: String?, fileCount: Int = 0) {
        let name = duck.trimmingCharacters(in: .whitespacesAndNewlines)
        self.duck = name.isEmpty ? "the Duck" : name
        let b = branch?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.branch = (b?.isEmpty ?? true) ? nil : b
        self.path = path
        if let path { title = ChangeListing.split(path).name } else { title = ChangeListing.header(count: fileCount) }
    }

    /// The button's label. Named flow: a person reading a diff taps it, types what is wrong, and the Duck gets it as a message.
    public var askLabel: String { "Ask \(duck) to fix…" }
    public var askPlaceholder: String { path == nil ? "Say what to fix in these changes" : "Say what to fix in this file" }

    /// The message the Duck receives: the words, with the file named when the tab is one file.
    public func askMessage(_ words: String) -> String? {
        let text = words.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        guard let path else { return text }
        return "About \(path):\n\(text)"
    }
}

/// Whether review-all shows merge and PR controls: only for a Duck on its own branch in a repository, never Main.
public enum ReviewAllControls {
    public static func shows(isSqueakChat: Bool, canSeeCode: Bool, isMain: Bool, hasHistory: Bool) -> Bool {
        isSqueakChat && canSeeCode && !isMain && hasHistory
    }
}
