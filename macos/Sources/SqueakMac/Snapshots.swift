import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

// Offscreen UI snapshots: `SqueakMac --snapshots [dir]` renders key views into PNGs (default /tmp/squeak-snapshots/) from
// fixture data and exits. It never creates a window, never activates the app and never takes focus: each view is an
// NSHostingView that is laid out and drawn into a bitmap, nothing more. The views are the real ones where they take plain
// data (the top bar, the tab row, the Duck gradient, Room rows, Task cards, chips); screens that read live singletons
// (the Dashboard page, the Room feed) are composed here from the same leaf views and fixture values.

@MainActor
enum SnapshotRunner {
    static var requested: Bool { CommandLine.arguments.contains("--snapshots") }

    /// Runs and exits the process.
    static func runAndExit() -> Never {
        NSApplication.shared.setActivationPolicy(.prohibited)
        let args = CommandLine.arguments
        let dir = args.firstIndex(of: "--snapshots").flatMap { i in args.indices.contains(i + 1) && !args[i + 1].hasPrefix("-") ? args[i + 1] : nil }
            ?? "/tmp/squeak-snapshots"
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        // `--group composer`: only that group's shots (the live composer card, ComposerSnapshots.swift); default: the UI shots.
        let group = args.firstIndex(of: "--group").flatMap { args.indices.contains($0 + 1) ? args[$0 + 1] : nil } ?? "ui"
        var written: [String] = []
        for shot in Fixtures.shots() + ComposerSnapshots.shots() where shot.group == group {
            let path = "\(dir)/\(shot.name).png"
            if render(shot, to: path) { written.append(path) }
        }
        print(written.joined(separator: "\n"))
        exit(0)
    }

    private static func render(_ shot: Shot, to path: String) -> Bool {
        let host = NSHostingView(rootView: shot.view.environment(\.colorScheme, shot.dark ? .dark : .light).environment(AppModel.shared))
        host.appearance = NSAppearance(named: shot.dark ? .darkAqua : .aqua)
        host.frame = NSRect(x: 0, y: 0, width: shot.width, height: shot.height)
        host.layoutSubtreeIfNeeded()
        host.displayIfNeeded()
        // Let state-driven first frames (onAppear, geometry) settle.
        RunLoop.current.run(until: Date().addingTimeInterval(0.4))
        host.layoutSubtreeIfNeeded()
        guard let rep = host.bitmapImageRepForCachingDisplay(in: host.bounds) else { return false }
        rep.size = host.bounds.size
        host.cacheDisplay(in: host.bounds, to: rep)
        guard let png = rep.representation(using: .png, properties: [:]) else { return false }
        return (try? png.write(to: URL(fileURLWithPath: path))) != nil
    }
}

struct Shot {
    let name: String
    let width: Double
    let height: Double
    var dark = false
    let view: AnyView
    var group = "ui"
}

@MainActor
private enum Fixtures {
    static let dhol = DuckRowAvatar(
        id: "dhol", name: "Dhol", colourSeed: "dhol", presence: .idle, presenceLine: "Idle \u{00B7} 45m ago", sessionId: "s1",
        title: "Greeting Conversation Starter", wearsName: true)
    static let pip = DuckRowAvatar(
        id: "pip", name: "Pip", colourSeed: "pip", presence: .working, presenceLine: "Working", sessionId: "s2", title: "Fix login redirect")

    static func tabs(withPip: Bool = false, duckling: Bool = false) -> [PondStripTab] {
        var out = [PondStripTab(item: .duck("dhol"), duck: dhol, closable: false, title: PondTabStatus.title(for: dhol),
                                status: PondTabStatus.fullLine(for: dhol))]
        if withPip {
            out.append(PondStripTab(item: .duck("pip"), duck: pip, closable: false, title: PondTabStatus.title(for: pip),
                                    status: PondTabStatus.fullLine(for: pip, activity: "editing auth.ts")))
        }
        if duckling {
            let tab = TabItem.duckling(session: "s1", task: "t1", parentDuck: "dhol")
            let record = Duckling(id: "t1", title: "Review the diff", status: .running, startedAt: Date().addingTimeInterval(-38))
            out += PondWorkspaceStrip(roster: RoomRoster.roster([PondDuck(id: "dhol", name: "Dhol", currentSessionId: "s1")]),
                                      place: .dashboard, items: [tab], current: nil)
                .tabs(ducklings: [tab: record]).filter { $0.item == tab }
        }
        out.append(PondStripTab(item: TabItem(.notebook, "nb"), duck: nil, closable: true, title: nil, status: nil))
        return out
    }

    static func tile(_ name: String, seed: PondSeed) -> some View {
        Text(String(name.prefix(1)).uppercased()).font(.system(size: 14, weight: .bold)).foregroundStyle(Theme.ink)
            .frame(width: 32, height: 32)
            .background(accent(seed: seed), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
    }

    /// The real top bar from fixture data. `selected` is what the centre shows.
    static func bar(width: Double, centre: PondCentre, progress: Double? = nil, withPip: Bool = false, duckling: Bool = false, name: String = "greenroom", seed: PondSeed = greenroom) -> some View {
        let tabs = tabs(withPip: withPip, duckling: duckling)
        return PondTopBar(
            name: name, subtitle: "2 people, 2 ducks on duty", leadingInset: 0,
            switchSelection: centre.switchSelection, switchProgress: progress, pick: { _ in }, hasTabs: true,
            tile: { tile(name, seed: seed) },
            tabs: {
                PondTabsRow(
                    tabs: tabs, selected: centre.selectedTab, label: { _ in PondItemLabel(title: "Notebook", symbol: "book.closed") },
                    overflow: .constant(PondStripOverflow(contentStart: 0, contentEnd: 0, viewport: 0)))
            },
            trailing: { if centre.showsPondMenu { Image(systemName: "ellipsis").foregroundStyle(Theme.muted).frame(width: 28, height: 28) } })
        .frame(width: width)
    }

    static func page(width: Double, height: Double, centre: PondCentre, seed: PondSeed = greenroom, dark: Bool = false, content: () -> some View) -> some View {
        VStack(spacing: 0) {
            bar(width: width, centre: centre, seed: seed)
            content().frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        .frame(width: width, height: height)
        .background(alignment: .top) { DuckPondGradient(colour: gradientColour(seed: seed, dark: dark)) }
        .background(Theme.bg)
    }

    /// The Ponds the snapshots draw: greenroom's own green, a bright yellow logo, a neon one and a deep navy.
    static let greenroom = PondSeed.colour(PondTint.RGB(hex: 0x34A85F))
    static let yellow = PondSeed.colour(PondTint.RGB(hex: 0xFFE600))
    static let neon = PondSeed.colour(PondTint.RGB(hex: 0x39FF14))
    static let navy = PondSeed.colour(PondTint.RGB(hex: 0x0A1F5C))

    /// The Pond's accent (the logo tile, a thin line).
    static func accent(seed: PondSeed) -> Color {
        let a = PondAccent.rgb(seed: seed, dark: false)
        return Color(red: a.r, green: a.g, blue: a.b)
    }

    /// The quiet tint behind the top area, as the app draws it.
    static func gradientColour(seed: PondSeed, dark: Bool) -> Color {
        let a = PondWash.quiet(.duckTop, seed: seed, dark: dark) ?? PondTint.RGB(hex: 0)
        return Color(red: a.r, green: a.g, blue: a.b, opacity: PondWash.opacity(.duckTop, accent: a, dark: dark))
    }

    static func duckPage(width: Double, seed: PondSeed, dark: Bool) -> some View {
        let chrome = DuckHeaderChrome.of(branch: "sibhimanyu/hi", isMain: false, membership: .git)
        return page(width: width, height: 640, centre: PondCentre(page: .room, duck: "dhol"), seed: seed, dark: dark) {
            VStack(spacing: 0) {
                HStack(spacing: Space.m) {
                    DuckBranchChip(chrome: chrome, ghost: true).fixedSize()
                    Spacer()
                    Text("Create PR").font(Typo.label).foregroundStyle(Theme.ink).padding(.horizontal, 12).frame(height: 26)
                    Image(systemName: "ellipsis").foregroundStyle(Theme.muted)
                }
                .padding(.horizontal, Space.xl).frame(height: DuckSubheader.height)
                VStack(alignment: .leading, spacing: Space.l) {
                    Text("hi there").padding(.horizontal, Space.m).padding(.vertical, Space.s)
                        .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .frame(maxWidth: .infinity, alignment: .trailing)
                    Text("Both would be separate branches off main, so the two pieces of work stay apart until you want them merged. Say the word and I will start on the first one.")
                        .foregroundStyle(Theme.ink).font(.system(size: 14)).frame(maxWidth: 560, alignment: .leading)
                    Text("Sure. I checked the login redirect and the greeting copy; neither touches the other.")
                        .foregroundStyle(Theme.ink).font(.system(size: 14)).frame(maxWidth: 560, alignment: .leading)
                }
                .padding(.horizontal, Space.xl).padding(.top, Space.xl)
                .frame(maxWidth: .infinity, alignment: .topLeading)
                // The chat starts below the subheader and fades in under a soft mask, as in the app.
                .modifier(ChatTopFade(active: true))
            }
        }
    }

    static func room(width: Double, dark: Bool = false) -> some View {
        let task = RoomTask(id: "t1", messageId: "m2", title: "Greeting copy for the sign-in screen", state: .working)
        let card = RoomTasks.card(for: task, among: [task])
        return page(width: width, height: 560, centre: PondCentre(page: .room), dark: dark) {
            VStack(alignment: .leading, spacing: 0) {
                RoomRow(first: true, avatar: { PersonAvatar(name: "Sibhi V", size: CGFloat(RoomRowPlan.avatar)) }, at: 1_700_000_000_000, own: true, ownAccent: accent(seed: greenroom), header: {
                    RoomNameLine(tag: nil, at: 1_700_000_000_000) { Text("Sibhi").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.ink) }
                }, content: { RoomRowBody(text: "Can someone write the greeting copy for the sign-in screen?") })
                RoomRow(first: false, avatar: { EmptyView() }, at: 1_700_000_060_000, own: true, ownAccent: accent(seed: greenroom), header: { EmptyView() },
                        content: { RoomRowBody(text: "Keep it short, one friendly line.") })
                RoomRow(first: true, avatar: { ThreadDuckView(id: "dhol", size: CGFloat(RoomRowPlan.avatar)) }, at: 1_700_000_120_000, header: {
                    RoomNameLine(tag: "Duck", at: 1_700_000_120_000) { Text("Dhol").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.ink) }
                }, content: { RoomRowBody(text: "On it. I will draft three options and put the best one in the screen.") })
                if let card {
                    RoomTaskCardView(card: card, at: 1_700_000_180_000, act: { _, _, _ in }, open: nil)
                }
            }
            .padding(.top, Space.l)
        }
    }

    static func dashboard(width: Double, dark: Bool = false) -> some View {
        page(width: width, height: 640, centre: PondCentre(page: .dashboard), dark: dark) {
            VStack(alignment: .leading, spacing: Space.l) {
                Text("Pond overview").font(Typo.heading).foregroundStyle(Theme.ink)
                Text("2 people \u{00B7} 2 ducks \u{00B7} 1 task running").font(Typo.footnote).foregroundStyle(Theme.muted)
                VStack(alignment: .leading, spacing: Space.s) {
                    Text("On duty").font(Typo.heading).foregroundStyle(Theme.ink)
                    ForEach([dhol, pip]) { d in
                        HStack(spacing: Space.s) {
                            ThreadDuckView(id: d.colourSeed, size: 24)
                            Text(d.name).foregroundStyle(Theme.ink)
                            Text(PondTabStatus.line(for: d)).foregroundStyle(Theme.muted).font(Typo.footnote)
                        }
                    }
                }
                .padding(Space.l).frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
                VStack(alignment: .leading, spacing: Space.xs) {
                    Text("Ducks").font(Typo.heading).foregroundStyle(Theme.ink)
                    Text("Ducks work across the whole Pond and choose which Streams to join.").font(Typo.footnote).foregroundStyle(Theme.muted)
                }
            }
            .padding(Space.xl).frame(maxWidth: 760, alignment: .leading)
        }
    }

    /// The New duck page reached from a Duck's chat: its own centre state, so no Duck subheader, no selected tab, neither page
    /// selected in the switch, and no place picker (ducks start Pond-wide).
    static func newDuckPage(width: Double, dark: Bool) -> some View {
        let state = NewThreadState()
        state.ducksModeOverride = true
        state.loading = false
        state.pond = PondThreadContext(pondId: "p", pondName: "greenroom", projectId: "proj", choice: .new, showsPicker: true)
        return page(width: width, height: 560, centre: PondCentre(page: .room, duck: "dhol", newDuck: true), dark: dark) {
            NewDuckCentred {
                VStack(alignment: .leading, spacing: Space.l) {
                    Text("New duck").font(.system(size: 26, weight: .semibold)).foregroundStyle(Theme.ink)
                    NewThreadComposer(state: state, onEscape: {}, onStarted: {})
                }
            }
        }
    }

    static func shots() -> [Shot] {
        var out: [Shot] = []
        func add(_ name: String, _ w: Double, _ h: Double, dark: Bool = false, _ v: some View) {
            out.append(Shot(name: name, width: w, height: h, dark: dark, view: AnyView(v)))
        }
        let ponds: [(name: String, seed: PondSeed)] = [("green", greenroom), ("yellow", yellow), ("neon", neon), ("navy", navy)]
        for (label, dark) in [("light", false), ("dark", true)] {
            for w in [1500.0, 1100.0] {
                let n = Int(w)
                add("dashboard-\(n)-\(label)", w, 640, dark: dark, dashboard(width: w, dark: dark))
                add("room-\(n)-\(label)", w, 560, dark: dark, room(width: w, dark: dark))
                add("new-duck-\(n)-\(label)", w, 560, dark: dark, newDuckPage(width: w, dark: dark))
                for pond in ponds {
                    add("duck-\(pond.name)-\(n)-\(label)", w, 640, dark: dark, duckPage(width: w, seed: pond.seed, dark: dark))
                }
                add("bar-duck-and-notebook-\(n)-\(label)", w, 56, dark: dark,
                    barOnSurface(width: w, centre: PondCentre(page: .room, duck: "dhol"), withPip: true, dark: dark))
                add("bar-duckling-tab-selected-\(n)-\(label)", w, 56, dark: dark,
                    barOnSurface(width: w, centre: PondCentre(page: .room, duck: "dhol", item: TabItem.duckling(session: "s1", task: "t1", parentDuck: "dhol")),
                                 duckling: true, dark: dark))
                add("bar-notebook-selected-\(n)-\(label)", w, 56, dark: dark,
                    barOnSurface(width: w, centre: PondCentre(page: .room, item: TabItem(.notebook, "nb")), dark: dark))
            }
        }
        // The Dashboard | Room switch mid-swipe: the pill at progress 0, 0.5 and 1.
        for (label, p) in [("0", 0.0), ("half", 0.5), ("1", 1.0)] {
            for dark in [false, true] {
                add("switch-progress-\(label)-\(dark ? "dark" : "light")", 640, 56, dark: dark,
                    barOnSurface(width: 640, centre: PondCentre(page: p >= 0.5 ? .room : .dashboard), progress: p, dark: dark))
            }
        }
        return out
    }

    /// The bar alone, on the top surface's tint (as it sits in the app).
    static func barOnSurface(width: Double, centre: PondCentre, progress: Double? = nil, withPip: Bool = false, duckling: Bool = false, seed: PondSeed = greenroom, dark: Bool) -> some View {
        bar(width: width, centre: centre, progress: progress, withPip: withPip, duckling: duckling, seed: seed)
            .frame(width: width, height: 56)
            .background(alignment: .top) { DuckPondGradient(colour: gradientColour(seed: seed, dark: dark)) }
            .background(Theme.bg)
    }
}
