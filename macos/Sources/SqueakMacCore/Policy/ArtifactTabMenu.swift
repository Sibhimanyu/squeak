import Foundation

/// The one Export menu in an artifact tab's header: only what fits the artifact. A canvas exports as a PDF or as PNGs
/// (the export code the canvas viewer already has); any other file can be saved as a copy. Every artifact can be
/// revealed in Finder and have its path copied. Zoom has no buttons: it is Cmd+=, Cmd+- and Cmd+0, and pinch.
public enum ArtifactTabMenu {
    public enum Entry: Equatable, Sendable {
        case pdfAllBoards
        case png(scale: CanvasExport.Scale, allBoards: Bool)
        case saveCopy
        case reveal
        case copyPath

        public var title: String {
            switch self {
            case .pdfAllBoards: "PDF, all artboards\u{2026}"
            case .png(let scale, let all): "\(all ? "All artboards" : "This artboard") as \(scale.menuTitle)\u{2026}"
            case .saveCopy: "Save a copy\u{2026}"
            case .reveal: "Reveal in Finder"
            case .copyPath: "Copy path"
            }
        }
    }

    /// Groups of entries (a divider between groups). `fileAvailable` is false while a remote file has not arrived or
    /// the file is gone: then only what needs no file is left (nothing), so the menu is empty.
    public static func groups(kind: ArtifactKind, fileAvailable: Bool = true, canExportCanvas: Bool = true) -> [[Entry]] {
        guard fileAvailable else { return [] }
        var out: [[Entry]] = []
        if kind == .canvas {
            if canExportCanvas {
                out.append([.pdfAllBoards])
                out.append([.png(scale: .one, allBoards: false), .png(scale: .two, allBoards: false),
                            .png(scale: .one, allBoards: true), .png(scale: .two, allBoards: true)])
            }
        } else {
            out.append([.saveCopy])
        }
        out.append([.reveal, .copyPath])
        return out
    }

    /// The Duck named in the header, nil for a file no Duck owns.
    public static func duckLabel(_ item: ArtifactItem) -> String? {
        guard let d = item.duckName?.trimmingCharacters(in: .whitespaces), !d.isEmpty else { return nil }
        return d
    }

    /// A copy's suggested name: the file's own name.
    public static func copyName(path: String) -> String { (path as NSString).lastPathComponent }
}
