import AppKit
import SqueakMacCore
import SqueakMarkup
import SwiftUI

/// SQUEAK_MAC_CAPTURE=<prefix>: opens the conversation window, waits for the first
/// catalog, writes <prefix>-window.png and <prefix>-popover.png from the views'
/// own pixels (no Screen Recording permission), then quits. Read-only: it never sends.
@MainActor
enum CaptureRunner {
    static func run(prefix: String, model: AppModel) async {
        let env = ProcessInfo.processInfo.environment
        if let a = env["SQUEAK_MAC_APPEARANCE"] { NSApp.appearance = NSAppearance(named: a == "light" ? .aqua : .darkAqua) }
        if model.demoMode, env["SQUEAK_MAC_CAPTURE_ONLY"] == "awake" { await runAwakeOnly(prefix: prefix, model: model); return }
        if env["SQUEAK_MAC_CAPTURE_ONLY"] == "updatebadge" { await runUpdateBadge(prefix: prefix); return }
        if model.demoMode, env["SQUEAK_MAC_CAPTURE_ONLY"] == "popup" { await runPopupOnly(prefix: prefix, model: model); return }
        if model.demoMode, env["SQUEAK_MAC_CAPTURE_ONLY"] == "popover" { await runPopoverOnly(prefix: prefix, model: model); return }
        if model.demoMode, env["SQUEAK_MAC_CAPTURE_ONLY"] == "refinements" {
            // Quick composer on demo-6's reply first, then the menu panel; the last one terminates.
            await runContextPreview(prefix: prefix, model: model)
            await runPopoverOnly(prefix: prefix, model: model)
            return
        }
        if model.demoMode { await runAskDemo(prefix: prefix, model: model) }
        if model.demoMode { await runWindowDemo(prefix: prefix, model: model) }
        if model.demoMode { await runDemo(prefix: prefix, model: model); return }
        await model.broker.setMode(.foreground)
        await wait(seconds: 8) { model.hasLoaded }
        if let s = model.ordered.flattened.first(where: { $0.replyTarget != nil }) ?? model.ordered.flattened.first {
            model.select(s.key)
            await wait(seconds: 4) { !model.messages.isEmpty }
        }
        try? await Task.sleep(for: .milliseconds(800))

        let win = NSWindow(
            contentRect: NSRect(x: 60, y: 60, width: 1200, height: 800),
            styleMask: [.titled, .closable, .resizable, .miniaturizable, .fullSizeContentView], backing: .buffered, defer: false
        )
        win.titlebarAppearsTransparent = true
        win.titleVisibility = .hidden
        win.contentView = NSHostingView(rootView: ConversationView().environment(model))
        win.makeKeyAndOrderFront(nil)
        try? await Task.sleep(for: .seconds(1))
        write(win.contentView?.superview ?? win.contentView, to: "\(prefix)-window.png")

        let pop = NSWindow(contentRect: NSRect(x: 200, y: 200, width: PopoverView.width, height: 520), styleMask: [.borderless], backing: .buffered, defer: false)
        pop.contentView = NSHostingView(rootView: PopoverView(drawsOwnSurface: true).environment(model))
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

    /// SQUEAK_MAC_CAPTURE_ONLY=updatebadge: the menu-bar mark with and without the update dot, on a dark and a
    /// light bar, at 8x. The real template images, tinted the way macOS tints them. Writes <prefix>.png.
    static func runUpdateBadge(prefix: String) async {
        let states: [(String, MenuBarIcon.State, Bool)] = [("plain", .normal, false), ("update", .normal, true), ("needs you 2", .needsYou(2), true)]
        func bar(dark: Bool) -> some View {
            HStack(spacing: 28) {
                ForEach(Array(states.enumerated()), id: \.offset) { _, s in
                    VStack(spacing: 8) {
                        Image(nsImage: MenuBarIcon.image(for: s.1, updateDot: s.2)).renderingMode(.template)
                            .resizable().interpolation(.high).aspectRatio(contentMode: .fit).frame(height: 18 * 8)
                        Text(s.0).font(.system(size: 14))
                    }
                }
            }
            .foregroundStyle(dark ? Color.white : Color.black)
            .padding(32).background(dark ? Color(red: 0.12, green: 0.12, blue: 0.14) : Color(red: 0.88, green: 0.89, blue: 0.91))
        }
        let host = NSHostingView(rootView: VStack(spacing: 0) { bar(dark: true); bar(dark: false) })
        host.frame = NSRect(origin: .zero, size: host.fittingSize)
        let win = NSWindow(contentRect: host.frame, styleMask: [.borderless], backing: .buffered, defer: false)
        win.contentView = host
        win.makeKeyAndOrderFront(nil)
        try? await Task.sleep(for: .milliseconds(600))
        write(host, to: "\(prefix).png")
        NSApp.terminate(nil)
    }

    /// SQUEAK_MAC_DEMO=1 SQUEAK_MAC_CAPTURE_ONLY=popover: just the menu-bar panel, dark and light, from
    /// DemoData with no network. Writes <prefix>-popover-dark.png, -light.png and -short.png (a 440pt-tall screen).
    /// Offscreen capture cannot draw the window material, so the panel sits on a stand-in desktop.
    static func runPopoverOnly(prefix: String, model: AppModel) async {
        try? await Task.sleep(for: .milliseconds(600))
        for (name, appearance, screen) in [("dark", NSAppearance.Name.darkAqua, CGFloat?.none), ("light", .aqua, nil), ("short", .darkAqua, 440)] {
            let backdrop: Color = name != "light" ? Color(red: 0.10, green: 0.10, blue: 0.12) : Color(red: 0.86, green: 0.87, blue: 0.90)
            let host = NSHostingView(rootView: PopoverView(drawsOwnSurface: true, screenHeightOverride: screen).environment(model).padding(16).background(backdrop))
            host.appearance = NSAppearance(named: appearance)
            let win = NSWindow(contentRect: NSRect(x: 200, y: 200, width: PopoverView.width + 32, height: 700), styleMask: [.borderless], backing: .buffered, defer: false)
            win.contentView = host
            win.makeKeyAndOrderFront(nil)
            for _ in 0..<3 {
                try? await Task.sleep(for: .milliseconds(500))
                win.setContentSize(NSSize(width: PopoverView.width + 32, height: host.fittingSize.height))
            }
            write(host, to: "\(prefix)-popover-\(name).png")
            win.orderOut(nil)
        }
        NSApp.terminate(nil)
    }

    /// SQUEAK_MAC_DEMO=1: popover, quick composer and every Settings page from DemoData, no network.
    /// Writes <prefix>-popover.png, <prefix>-composer.png, <prefix>-settings-connections.png.
    private static func runDemo(prefix: String, model: AppModel) async {
        try? await Task.sleep(for: .milliseconds(600))
        let dark = NSApp.effectiveAppearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua

        let pop = NSWindow(contentRect: NSRect(x: 200, y: 200, width: PopoverView.width, height: 600), styleMask: [.borderless], backing: .buffered, defer: false)
        let popHost = NSHostingView(rootView: PopoverView(drawsOwnSurface: true).environment(model))
        pop.contentView = popHost
        pop.makeKeyAndOrderFront(nil)
        try? await Task.sleep(for: .milliseconds(700))
        var h = popHost.fittingSize.height
        pop.setContentSize(NSSize(width: PopoverView.width, height: h))
        try? await Task.sleep(for: .milliseconds(500))
        h = popHost.fittingSize.height
        pop.setContentSize(NSSize(width: PopoverView.width, height: h))
        try? await Task.sleep(for: .milliseconds(500))
        write(pop.contentView, to: "\(prefix)-popover.png")
        pop.orderOut(nil)

        // The quick composer over a stand-in backdrop (a glass panel cannot blur a window that is not there).
        let qs = QuickComposerController.shared.state
        qs.prepare(model: model)
        let backdrop = LinearGradient(
            colors: dark ? [Color(red: 0.18, green: 0.16, blue: 0.62), Color(red: 0.05, green: 0.09, blue: 0.42)] : [Color(red: 0.74, green: 0.80, blue: 0.90), Color(red: 0.92, green: 0.92, blue: 0.94)],
            startPoint: .top, endPoint: .bottom)
        let cw = NSWindow(contentRect: NSRect(x: 100, y: 100, width: 800, height: 330), styleMask: [.borderless], backing: .buffered, defer: false)
        cw.contentView = NSHostingView(rootView: ZStack { backdrop; QuickComposerView(close: {}).environment(model).environment(qs) }.frame(width: 800, height: 330))
        cw.makeKeyAndOrderFront(nil)
        try? await Task.sleep(for: .milliseconds(900))
        write(cw.contentView, to: "\(prefix)-composer.png")
        // And with a message typed, so Send is lit.
        qs.text = "Ship it once the tests pass."
        try? await Task.sleep(for: .milliseconds(500))
        write(cw.contentView, to: "\(prefix)-composer-typed.png")
        qs.text = ""
        cw.orderOut(nil)

        // New chat sheet (demo workspaces; Start never sends in demo mode).
        let ns = NewChatController.shared.state
        ns.prepare(model: model, preselect: nil)
        try? await Task.sleep(for: .milliseconds(600))
        ns.form.text = "Add retries with backoff to the checkout call, and a test for the timeout case."
        let nw = NSWindow(contentRect: NSRect(x: 120, y: 120, width: NewChatSheet.width, height: 560), styleMask: [.borderless], backing: .buffered, defer: false)
        nw.isOpaque = false
        nw.backgroundColor = .clear
        let nHost = NSHostingView(rootView: NewChatSheet(close: {}).panelSurface().environment(model).environment(ns))
        nw.contentView = nHost
        nw.makeKeyAndOrderFront(nil)
        try? await Task.sleep(for: .milliseconds(900))
        nw.setContentSize(nHost.fittingSize)
        try? await Task.sleep(for: .milliseconds(500))
        write(nw.contentView, to: "\(prefix)-newchat.png")
        ns.form.query = "light"
        ns.error = "Conductor's relay isn't connected"
        try? await Task.sleep(for: .milliseconds(500))
        nw.setContentSize(nHost.fittingSize)
        try? await Task.sleep(for: .milliseconds(400))
        write(nw.contentView, to: "\(prefix)-newchat-error.png")
        nw.orderOut(nil)

        // Settings lives in the main window: photograph it page by page, in a real window.
        let sw = NSWindow(
            contentRect: NSRect(x: 80, y: 80, width: 1100, height: 720),
            styleMask: [.titled, .closable, .resizable, .miniaturizable, .fullSizeContentView], backing: .buffered, defer: false)
        sw.titlebarAppearsTransparent = true
        sw.titleVisibility = .hidden
        sw.contentView = NSHostingView(rootView: ConversationView().environment(model))
        // SQUEAK_MAC_SETTINGS_HEIGHT: a taller window, for the longer Settings pages.
        let settingsHeight = ProcessInfo.processInfo.environment["SQUEAK_MAC_SETTINGS_HEIGHT"].flatMap(Double.init) ?? 720
        sw.setContentSize(NSSize(width: 1100, height: settingsHeight))
        sw.makeKeyAndOrderFront(nil)
        let only = ProcessInfo.processInfo.environment["SQUEAK_MAC_SETTINGS_TAB"].flatMap { SettingsSection(link: $0) }
        for section in SettingsSection.allCases where only == nil || only == section {
            model.openSettingsInPlace(section)
            try? await Task.sleep(for: .milliseconds(1400))
            write(sw.contentView?.superview ?? sw.contentView, to: "\(prefix)-settings-\(section.rawValue).png")
        }
        model.closeSettings()
        sw.orderOut(nil)
        // The two sheets, from demo data (the model is in demo mode).
        for (name, view) in [("link-sheet", AnyView(LinkChatSheet())), ("pair-sheet", AnyView(PairSheet()))] {
            let host = NSHostingView(rootView: view.environment(model))
            let fw = NSWindow(contentRect: NSRect(x: 120, y: 120, width: 500, height: 420), styleMask: [.titled], backing: .buffered, defer: false)
            fw.contentView = host
            fw.makeKeyAndOrderFront(nil)
            try? await Task.sleep(for: .seconds(1.2))
            fw.setContentSize(host.fittingSize); try? await Task.sleep(for: .milliseconds(400))
            write(fw.contentView, to: "\(prefix)-\(name).png")
            fw.orderOut(nil)
        }
        for n in 0..<4 {
            let ow = NSWindow(contentRect: NSRect(x: 120, y: 120, width: 480, height: 420), styleMask: [.titled], backing: .buffered, defer: false)
            ow.contentView = NSHostingView(rootView: OnboardingView(step: n, finish: {}).environment(model))
            ow.makeKeyAndOrderFront(nil)
            try? await Task.sleep(for: .milliseconds(700))
            write(ow.contentView, to: "\(prefix)-onboarding-\(n + 1).png")
            ow.orderOut(nil)
        }
        NSApp.terminate(nil)
    }

    private static func wait(seconds: Double, until condition: () -> Bool) async {
        let end = Date().addingTimeInterval(seconds)
        while !condition(), Date() < end { try? await Task.sleep(for: .milliseconds(150)) }
    }

    static func write(_ view: NSView?, to path: String) {
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
        MessageText(markdown: Self.text, style: .squeak)
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
                LogoLockup(height: 22)
                Spacer()
            }
            SearchField(text: $query, hint: "⌘F")
            SectionLabel("Needs you", count: 1)
            NeedsYouCard(
                session: checkout, question: "Should I preserve the existing retry count of 2, or move it to 3 for gateway timeouts?",
                choices: [Choice(letter: "A", label: "Keep 2"), Choice(letter: "B", label: "Use 3"), Choice(letter: "C", label: "Let me review")]
            )
            SectionLabel("Working")
            SessionRowView(session: limiter)
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
