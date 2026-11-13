import Foundation

/// A pond can be any folder. One in a plain folder (kind `folder`) has no version history: chats run in the folder,
/// and everything that needs git (streams, Changes, pull requests, earlier file states) is left out or says why.
/// "Turn on version history" is the one way to a git pond, and it is never run by itself.
public enum FolderPond {
    public static let noStreams = "Streams need version history. Turn it on for this pond first."

    /// Streams, their "+" and menu items, Changes, Review and the Git actions are drawn only for a repository.
    public static func showsGitControls(_ project: NativeProject?) -> Bool { !(project?.isPlainFolder ?? false) }

    /// What the sidebar and the pond's page offer for a plain folder instead of streams.
    public static let streamsNote = "This pond is a plain folder, so it has no streams. Turn on version history to work in streams and see changes."

    public enum Offer: Equatable, Sendable {
        /// Within the limits: confirm with this sentence, then save what is in the folder.
        case commit(question: String)
        /// Over a limit: only turning it on without a first snapshot is offered, with the reason.
        case withoutCommit(reason: String)
    }

    /// "1,204 files, 38 MB" for the confirm.
    public static func sizeWords(files: Int, bytes: Int64) -> String {
        let n = files.formatted(.number.grouping(.automatic))
        let noun = files == 1 ? "file" : "files"
        return "\(n) \(noun), \(byteWords(bytes))"
    }

    public static func byteWords(_ bytes: Int64) -> String {
        let kb = 1024.0, mb = kb * 1024, gb = mb * 1024
        let b = Double(bytes)
        if b >= gb { return String(format: "%.1f GB", b / gb) }
        if b >= mb { return "\(Int((b / mb).rounded())) MB" }
        if b >= kb { return "\(Int((b / kb).rounded())) KB" }
        return "\(bytes) bytes"
    }

    /// The confirm's question, built from the host's preview; over a limit it is the host's own reason instead.
    public static func offer(_ preview: NativeHistoryPreview) -> Offer {
        if preview.tooBig {
            return .withoutCommit(reason: preview.reason ?? "This folder is too big to save a first snapshot of.")
        }
        let what = sizeWords(files: preview.files, bytes: preview.bytes)
        let ignore = preview.hasGitignore ? "" : " A .gitignore is added that leaves out macOS files and folders like node_modules."
        return .commit(question: "Save what is in this folder (\(what)) as the first version?\(ignore)")
    }
}
