import Foundation

/// Which stream a pond's own thread starts in (the Start a thread sheet's picker).
public enum StartThreadStream: Equatable, Sendable {
    case new
    case existing(String)

    /// The `workspaceId` the host route takes; nil = a new stream.
    public var workspaceId: String? {
        if case .existing(let id) = self { id } else { nil }
    }
}

public enum StartThreadStreams {
    /// The project's streams on this Mac a thread can start in, newest activity first (a stream's newest chat, else when
    /// it was made); archived ones are gone. Ties keep the given order.
    public static func options(_ workspaces: [NativeWorkspace], projectId: String?, lastActive: [String: Date] = [:]) -> [NativeWorkspace] {
        guard let projectId else { return [] }
        func stamp(_ w: NativeWorkspace) -> Date { max(lastActive[w.id] ?? .distantPast, w.createdAt ?? .distantPast) }
        let mine = workspaces.enumerated().filter { $0.element.projectId == projectId && $0.element.state != "archived" }
        return mine.sorted { a, b in
            let (x, y) = (stamp(a.element), stamp(b.element))
            return x != y ? x > y : a.offset < b.offset
        }.map(\.element)
    }

    /// The most recently active stream, or a new one when there are none.
    public static func defaultChoice(_ options: [NativeWorkspace]) -> StartThreadStream {
        options.first.map { .existing($0.id) } ?? .new
    }

    /// A plain folder has no streams, so the picker is hidden and the thread runs in the folder.
    public static func showsPicker(isGitFolder: Bool) -> Bool { isGitFolder }

    /// A choice that no longer exists (the stream was archived while the sheet was open) falls back to the default.
    public static func valid(_ choice: StartThreadStream, in options: [NativeWorkspace]) -> StartThreadStream {
        if case .existing(let id) = choice, !options.contains(where: { $0.id == id }) { return defaultChoice(options) }
        return choice
    }
}
