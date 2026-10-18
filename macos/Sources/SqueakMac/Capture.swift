import AppKit
import SqueakMacCore
import SwiftUI

/// SQUEAK_MAC_CAPTURE=<prefix>: opens the conversation window, waits for the first
/// catalog, writes <prefix>-window.png and <prefix>-popover.png from the views'
/// own pixels (no Screen Recording permission), then quits. Read-only: it never sends.
@MainActor
enum CaptureRunner {
    static func run(prefix: String, model: AppModel) async {
        let env = ProcessInfo.processInfo.environment
        if let a = env["SQUEAK_MAC_APPEARANCE"] { NSApp.appearance = NSAppearance(named: a == "light" ? .aqua : .darkAqua) }
        await model.broker.setMode(.foreground)
        await wait(seconds: 8) { model.hasLoaded }
        if let s = model.ordered.flattened.first(where: { $0.replyTarget != nil }) ?? model.ordered.flattened.first {
            model.select(s.key)
            await wait(seconds: 4) { !model.messages.isEmpty }
        }
        try? await Task.sleep(for: .milliseconds(800))

        let win = NSWindow(
            contentRect: NSRect(x: 80, y: 80, width: 1040, height: 700),
            styleMask: [.titled, .closable, .resizable, .fullSizeContentView], backing: .buffered, defer: false
        )
        win.contentView = NSHostingView(rootView: ConversationView().environment(model))
        win.makeKeyAndOrderFront(nil)
        try? await Task.sleep(for: .seconds(1))
        write(win.contentView, to: "\(prefix)-window.png")

        let pop = NSWindow(contentRect: NSRect(x: 200, y: 200, width: 360, height: 520), styleMask: [.borderless], backing: .buffered, defer: false)
        pop.contentView = NSHostingView(rootView: PopoverView().environment(model))
        pop.makeKeyAndOrderFront(nil)
        try? await Task.sleep(for: .milliseconds(700))
        write(pop.contentView, to: "\(prefix)-popover.png")

        // A fixed sample, so every markdown block shows up regardless of the live chats.
        let sample = NSWindow(contentRect: NSRect(x: 300, y: 300, width: 620, height: 640), styleMask: [.borderless], backing: .buffered, defer: false)
        sample.contentView = NSHostingView(rootView: MarkdownSample().frame(width: 620, height: 640))
        sample.makeKeyAndOrderFront(nil)
        try? await Task.sleep(for: .milliseconds(700))
        write(sample.contentView, to: "\(prefix)-markdown.png")

        // Component gallery: dark and light side by side, demo data only.
        let gallery = NSView(frame: NSRect(x: 0, y: 0, width: 1200, height: 900))
        for (i, name) in [NSAppearance.Name.darkAqua, .aqua].enumerated() {
            let host = NSHostingView(rootView: ComponentGallery().frame(width: 600, height: 900))
            host.frame = NSRect(x: CGFloat(i) * 600, y: 0, width: 600, height: 900)
            host.appearance = NSAppearance(named: name)
            gallery.addSubview(host)
        }
        let gw = NSWindow(contentRect: gallery.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        gw.contentView = gallery
        gw.makeKeyAndOrderFront(nil)
        try? await Task.sleep(for: .milliseconds(900))
        write(gallery, to: "\(prefix)-components.png")
        NSApp.terminate(nil)
    }

    private static func wait(seconds: Double, until condition: () -> Bool) async {
        let end = Date().addingTimeInterval(seconds)
        while !condition(), Date() < end { try? await Task.sleep(for: .milliseconds(150)) }
    }

    private static func write(_ view: NSView?, to path: String) {
        guard let view, let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return }
        view.cacheDisplay(in: view.bounds, to: rep)
        guard let data = rep.representation(using: .png, properties: [:]) else { return }
        try? FileManager.default.createDirectory(at: URL(fileURLWithPath: path).deletingLastPathComponent(), withIntermediateDirectories: true)
        try? data.write(to: URL(fileURLWithPath: path))
    }
}

private struct MarkdownSample: View {
    static let text = """
    ## What changed

    I fixed **three things** and left *one* alone. Run `swift test` to check; see [the notes](https://example.com/notes?a=1) for why.

    - Parser in `Core`
      - nested **bold** item
    - Renderer with an unclosed **marker
    1. First step
    2. Second step

    > A quoted line that explains the choice,
    > continued here.

    ```swift
    let long = "a very long line that should scroll horizontally instead of wrapping, as code never wraps"
    print(long)
    ```

    <b>HTML</b> stays literal, and snake_case_names too.
    """

    var body: some View {
        MarkdownView(text: Self.text)
            .padding(16)
            .background(Theme.surface)
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .background(Theme.bg)
    }
}

/// Every shared component with made-up data, for review without touching live chats.
private struct ComponentGallery: View {
    static let now = Date()
    static func demo(_ id: String, _ title: String, _ state: SessionState, ago: TimeInterval, repo: String, branch: String, agent: String) -> HostSession {
        HostSession(
            key: SessionKey(provider: "demo", hostSessionId: id), title: title, repoName: repo, branch: branch,
            agent: agent, state: state, lastActivityAt: now.addingTimeInterval(-ago)
        )
    }
    let checkout = demo("1", "Checkout retries", .blocked, ago: 5, repo: "orchard", branch: "fix/retry-logic", agent: "claude")
    let limiter = demo("2", "Rate limiter", .working, ago: 120, repo: "lighthouse", branch: "main", agent: "codex")
    let docs = demo("3", "Docs refresh", .finished, ago: 3600, repo: "orchard", branch: "docs/api", agent: "claude")
    let flaky = demo("4", "Fix flaky login test", .idle, ago: 86400 * 3, repo: "squeak", branch: "test/login-flake", agent: "codex")
    @State private var query = ""

    var body: some View {
        VStack(alignment: .leading, spacing: Space.l) {
            HStack(spacing: Space.s) {
                DuckGlyph(size: 18)
                Text("Squeak").font(.system(size: 15, weight: .semibold)).foregroundStyle(Theme.ink)
                Spacer()
                DuckGlyph(size: 48)
            }
            SearchField(text: $query, hint: "⌘F")
            SectionLabel("Needs you", count: 1)
            NeedsYouCard(
                session: checkout, question: "Should I preserve the existing retry count of 2, or move it to 3 for gateway timeouts?",
                choices: [Choice(letter: "A", label: "Keep 2"), Choice(letter: "B", label: "Use 3"), Choice(letter: "C", label: "Let me review")]
            )
            SectionLabel("Working")
            SessionRowView(session: limiter, showsAgent: true)
            Hairline()
            SectionLabel("Recent")
            SessionRowView(session: docs, isSelected: true, isPinned: true)
            SessionRowView(session: flaky)
            ShowEarlierRow(count: 12) {}
            Hairline()
            HStack(spacing: Space.s) {
                StateChip(state: .blocked); StateChip(state: .working); StateChip(state: .finished)
                StateChip(state: .idle); StateChip(state: .error)
            }
            HStack(spacing: Space.l) {
                ForEach([0.0, 120, 7200, 86400 * 3, 86400 * 14], id: \.self) { RelativeTimeText(Self.now.addingTimeInterval(-$0)) }
            }
            Spacer(minLength: 0)
        }
        .padding(Space.l)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(Theme.bg)
    }
}
