import Foundation

/// What ⌘V (or a drop) on a composer does with what is on the pasteboard: attach pictures, or paste as the text view
/// always did. One decision for every composer (Duck chat, new Duck, Room, popups); the views only read the pasteboard
/// into `Facts` and carry out the answer.
public enum ComposerPaste {
    /// What the pasteboard holds, as far as the decision needs: type identifiers (UTIs or the legacy names) and the file
    /// URLs on it, already sorted into pictures and anything else by the caller (it asks the file's content type).
    public struct Facts: Equatable, Sendable {
        public var types: [String]
        public var imageFileCount: Int
        public var otherFileCount: Int

        public init(types: [String], imageFileCount: Int = 0, otherFileCount: Int = 0) {
            self.types = types
            self.imageFileCount = imageFileCount
            self.otherFileCount = otherFileCount
        }
    }

    public enum Action: Equatable, Sendable {
        /// The copied picture files are attached.
        case imageFiles
        /// The picture bytes of this pasteboard type are attached (a screenshot, "Copy Image" in a browser).
        case imageData(type: String)
        /// Not ours: the text view pastes as it always did (text, a copied non-picture file's name, anything else).
        case text
    }

    /// Raw picture types, best first: PNG keeps transparency, TIFF is what most apps offer, then the camera and web formats.
    /// The legacy names are what older apps still put on the pasteboard.
    public static let imageTypes = [
        "public.png", "Apple PNG pasteboard type", "public.tiff", "NeXT TIFF v4.0 pasteboard type",
        "public.jpeg", "public.heic", "com.compuserve.gif",
    ]

    static let textTypes: Set<String> = ["public.utf8-plain-text", "NSStringPboardType", "public.plain-text", "public.utf16-plain-text"]
    public static func hasText(_ types: [String]) -> Bool { types.contains { textTypes.contains($0) } }

    /// Copied picture files always count. Raw picture bytes count only with no words beside them, so copying cells from a
    /// spreadsheet (text, and a picture of it) still pastes the words. `rawNeedsNoText` is false for a drop, where the
    /// person meant the picture.
    public static func decide(_ facts: Facts, rawNeedsNoText: Bool) -> Action {
        if facts.imageFileCount > 0 { return .imageFiles }
        // A copied file that is not a picture (a PDF, a folder) never becomes picture bytes (its icon is on the pasteboard too).
        if facts.otherFileCount > 0 { return .text }
        guard let type = imageTypes.first(where: facts.types.contains) else { return .text }
        if rawNeedsNoText, hasText(facts.types) { return .text }
        return .imageData(type: type)
    }
}
