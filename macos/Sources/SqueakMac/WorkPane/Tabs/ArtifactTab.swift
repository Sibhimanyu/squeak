import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

/// An artifact opened as a tab of the Pond workspace: full size, with one header row (name, the Duck that made it, one
/// Export menu). The viewers underneath are the existing ones, asked to draw in tab mode (`tab: true`), so the classic
/// layout keeps its own toolbar unchanged.
struct ArtifactTab: View {
    let pond: String
    let path: String

    var body: some View {
        ArtifactViewerPage(pond: pond, path: path, embedded: true, tab: true)
    }
}

/// The tab's one header row. `leading` holds what a canvas needs to be edited by hand (its tools); `menu` is the
/// Export menu's content. Flows: the name and Duck say what this is and who made it; Export saves it elsewhere or
/// reveals it in Finder; zoom is Cmd+=, Cmd+-, Cmd+0 (and pinch), so there are no zoom buttons.
struct ArtifactTabHeader<Leading: View, Trailing: View, MenuContent: View>: View {
    let name: String
    let duck: String?
    let kind: ArtifactKind
    var menuEnabled = true
    var zoom: ArtifactZoomKeys?
    @ViewBuilder var leading: Leading
    @ViewBuilder var trailing: Trailing
    @ViewBuilder var menu: MenuContent

    var body: some View {
        HStack(spacing: Space.s) {
            Lucide(kind.lucide, size: 15, color: Theme.muted)
            Text(verbatim: name).font(Typo.heading).foregroundStyle(Theme.ink).lineLimit(1).truncationMode(.middle)
                .layoutPriority(-1)
            if let duck {
                Text(verbatim: duck).font(Typo.meta).foregroundStyle(Theme.subtle).lineLimit(1).fixedSize()
            }
            leading
            Spacer(minLength: Space.s)
            trailing
            Menu {
                menu
            } label: {
                HStack(spacing: 4) { Text("Export").lineLimit(1).fixedSize(); Lucide(.chevronDown, size: 11, color: Theme.ink) }
            }
            .menuStyle(.button).buttonStyle(CompactToolStyle()).menuIndicator(.hidden).fixedSize()
            .disabled(!menuEnabled).help("Export, reveal in Finder, copy the path").accessibilityLabel("Export")
        }
        .padding(.horizontal, Space.m).frame(height: 40)
        .background(zoomShortcuts)
    }

    @ViewBuilder private var zoomShortcuts: some View {
        if let zoom {
            ZStack {
                Button("") { zoom.zoomIn() }.keyboardShortcut("=", modifiers: .command)
                Button("") { zoom.zoomOut() }.keyboardShortcut("-", modifiers: .command)
                Button("") { zoom.fit() }.keyboardShortcut("0", modifiers: .command)
            }
            .opacity(0).allowsHitTesting(false).accessibilityHidden(true)
        }
    }
}

/// What Cmd+=, Cmd+- and Cmd+0 do for the viewer showing.
struct ArtifactZoomKeys {
    let zoomIn: () -> Void
    let zoomOut: () -> Void
    let fit: () -> Void
}

/// The Reveal in Finder, Copy path and Save a copy actions of the Export menu, shared by both viewers.
@MainActor enum ArtifactTabActions {
    static func reveal(_ path: String) { NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)]) }

    static func copyPath(_ path: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(path, forType: .string)
    }

    /// Asks where to put a copy of the file, then copies it.
    static func saveCopy(of path: String) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = ArtifactTabMenu.copyName(path: path)
        panel.title = "Save a copy"
        panel.begin { response in
            guard response == .OK, let dest = panel.url else { return }
            try? FileManager.default.removeItem(at: dest)
            try? FileManager.default.copyItem(at: URL(fileURLWithPath: path), to: dest)
        }
    }
}
