import AppKit
import SqueakMacCore
import SqueakIcons
import SwiftUI

/// The apps' own marks (Claude, Codex, Conductor), the same files and the same colours as the iPhone's
/// `agent-*` images. Never recoloured or redrawn. The packaged app carries them in
/// `Contents/Resources/brand/agents` (scripts/build-app.sh); from a checkout they are in `macos/assets/agents`.
enum AgentMarkImages {
    @MainActor private static var cache: [AgentMarkAsset: NSImage] = [:]

    static func url(_ mark: AgentMarkAsset) -> URL? { url(fileName: mark.fileName) }

    static func url(fileName: String) -> URL? {
        if let r = Bundle.main.resourceURL {
            let u = r.appendingPathComponent("brand/agents/\(fileName)")
            if FileManager.default.fileExists(atPath: u.path) { return u }
        }
        let roots = [URL(fileURLWithPath: FileManager.default.currentDirectoryPath), Bundle.main.executableURL?.deletingLastPathComponent()]
        for case let start? in roots {
            var dir = start
            for _ in 0..<8 {
                for rel in ["macos/assets/agents/\(fileName)", "assets/agents/\(fileName)"] {
                    let u = dir.appendingPathComponent(rel)
                    if FileManager.default.fileExists(atPath: u.path) { return u }
                }
                dir.deleteLastPathComponent()
            }
        }
        return nil
    }

    @MainActor static func image(_ mark: AgentMarkAsset) -> NSImage? {
        if let c = cache[mark] { return c }
        guard let u = url(mark), let i = NSImage(contentsOf: u) else { return nil }
        cache[mark] = i
        return i
    }

    /// A copy at a fixed point size, for places that size an image themselves (menu items).
    @MainActor static func sized(_ mark: AgentMarkAsset, _ points: CGFloat) -> NSImage? {
        guard let i = image(mark)?.copy() as? NSImage else { return nil }
        i.size = NSSize(width: points, height: points)
        return i
    }
}

/// One mark at a size, decorative to VoiceOver (the name is always beside it as text).
struct AgentMark: View {
    let mark: AgentMarkAsset
    var size: CGFloat = 16

    init(_ mark: AgentMarkAsset, size: CGFloat = 16) { self.mark = mark; self.size = size }
    init?(agent: String?, size: CGFloat = 16) {
        guard let m = AgentMarkAsset(agent: agent) else { return nil }
        self.init(m, size: size)
    }

    var body: some View {
        Group {
            if let image = AgentMarkImages.image(mark) {
                Image(nsImage: image).resizable().interpolation(.high).scaledToFit()
            } else {
                Color.clear
            }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// The services' own app icons, bundled alongside the agent marks so they work without the apps installed.
struct ServiceMark: View {
    enum Service: String { case telegram, cliq }
    let service: Service
    var size: CGFloat = 20

    @MainActor private static var images: [Service: NSImage] = [:]

    private var image: NSImage? {
        if let cached = Self.images[service] { return cached }
        guard let url = AgentMarkImages.url(fileName: "agent-\(service.rawValue).png"),
              let image = NSImage(contentsOf: url) else { return nil }
        Self.images[service] = image
        return image
    }

    var body: some View {
        Group {
            if let image { Image(nsImage: image).resizable().interpolation(.high).scaledToFit() }
            else { Lucide(service == .telegram ? .send : .messageSquare, size: size * 0.8, color: Theme.muted) }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// The actual Terminal icon from macOS, with a symbol fallback if the app is unavailable.
struct TerminalMark: View {
    var size: CGFloat = 20
    private static let image: NSImage? = {
        let url = URL(fileURLWithPath: "/System/Applications/Utilities/Terminal.app")
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        return NSWorkspace.shared.icon(forFile: url.path)
    }()

    var body: some View {
        Group {
            if let image = Self.image { Image(nsImage: image).resizable().interpolation(.high).scaledToFit() }
            else { Lucide(.squareTerminal, size: size * 0.8, color: Theme.muted) }
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
    }
}

/// The agent a chat runs on, with Conductor as a corner badge when Conductor holds it (the iPhone's
/// `AgentAvatar`). An agent with no mark gets a neutral terminal tile, never another app's icon.
struct AgentAvatar: View {
    let session: HostSession
    var size: CGFloat = 20

    var body: some View {
        Group {
            if let mark = session.agentMark {
                AgentMark(mark, size: size)
            } else {
                Lucide(.squareTerminal, size: size * 0.6, color: Theme.muted)
                    .frame(width: size, height: size)
                    .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: size * 0.25))
                    .overlay(RoundedRectangle(cornerRadius: size * 0.25).stroke(Theme.line))
            }
        }
        .frame(width: size, height: size)
        .overlay(alignment: .bottomTrailing) {
            if session.showsConductorBadge {
                AgentMark(.conductor, size: size * 0.5)
                    .background(Theme.surface, in: Circle().inset(by: -1.5))
                    .offset(x: size * 0.12, y: size * 0.12)
            }
        }
        .accessibilityHidden(true)
    }
}

/// A name with its mark before it, for headings and pickers.
struct AgentLabel: View {
    let mark: AgentMarkAsset
    var text: String?
    var size: CGFloat = 16
    var spacing: CGFloat = 6

    var body: some View {
        HStack(spacing: spacing) {
            AgentMark(mark, size: size)
            Text(verbatim: text ?? mark.title)
        }
    }
}
