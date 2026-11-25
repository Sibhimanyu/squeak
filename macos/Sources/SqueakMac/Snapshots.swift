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
        var written: [String] = []
        for shot in Fixtures.shots() {
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
}

@MainActor
private enum Fixtures {
    static let dhol = DuckRowAvatar(
        id: "dhol", name: "Dhol", colourSeed: "dhol", presence: .idle, presenceLine: "Idle \u{00B7} 45m ago", sessionId: "s1",
        title: "Greeting Conversation Starter", wearsName: true)
    static let pip = DuckRowAvatar(
        id: "pip", name: "Pip", colourSeed: "pip", presence: .working, presenceLine: "Working", sessionId: "s2", title: "Fix login redirect")

    static func tabs(withPip: Bool = false) -> [PondStripTab] {
        var out = [PondStripTab(item: .duck("dhol"), duck: dhol, closable: false, title: PondTabStatus.title(for: dhol),
                                status: PondTabStatus.fullLine(for: dhol))]
        if withPip {
            out.append(PondStripTab(item: .duck("pip"), duck: pip, closable: false, title: PondTabStatus.title(for: pip),
                                    status: PondTabStatus.fullLine(for: pip, activity: "editing auth.ts")))
        }
        out.append(PondStripTab(item: TabItem(.notebook, "nb"), duck: nil, closable: true, title: nil, status: nil))
        return out
    }

    static func tile(_ name: String, hue: Double) -> some View {
        Text(String(name.prefix(1)).uppercased()).font(.system(size: 14, weight: .bold)).foregroundStyle(Theme.ink)
            .frame(width: 32, height: 32)
            .background(Color(hue: hue / 360, saturation: 0.35, brightness: 0.85), in: RoundedRectangle(cornerRadius: 9, style: .continuous))
    }

    /// The real top bar from fixture data. `selected` is what the centre shows.
    static func bar(width: Double, centre: PondCentre, withPip: Bool = false, name: String = "greenroom", hue: Double = 140) -> some View {
        let tabs = tabs(withPip: withPip)
        return PondTopBar(
            name: name, subtitle: "2 people, 2 ducks on duty", leadingInset: 0,
            switchSelection: .constant(centre.switchSelection), hasTabs: true,
            tile: { tile(name, hue: hue) },
            tabs: {
                PondTabsRow(
                    tabs: tabs, selected: centre.selectedTab, label: { _ in PondItemLabel(title: "Notebook", symbol: "book.closed") },
                    overflow: .constant(PondStripOverflow(contentStart: 0, contentEnd: 0, viewport: 0)))
            },
            trailing: { Image(systemName: "ellipsis").foregroundStyle(Theme.muted).frame(width: 28, height: 28) })
        .frame(width: width).background(Theme.bg)
    }

    static func page(width: Double, height: Double, centre: PondCentre, hue: Double = 140, content: () -> some View) -> some View {
        VStack(spacing: 0) {
            bar(width: width, centre: centre, hue: hue)
            content().frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        }
        .frame(width: width, height: height).background(Theme.bg)
    }

    static func gradientColour(hue: Double, dark: Bool) -> Color {
        let a = PondWash.accent(hue: hue, dark: dark)
        return Color(red: a.r, green: a.g, blue: a.b, opacity: PondWash.opacity(.duckTop, accent: a, dark: dark))
    }

    static func duckPage(width: Double, hue: Double, dark: Bool) -> some View {
        let chrome = DuckHeaderChrome.of(branch: "sibhimanyu/hi", isMain: false, membership: .git)
        return page(width: width, height: 640, centre: PondCentre(page: .room, duck: "dhol")) {
            VStack(spacing: 0) {
                HStack(spacing: Space.m) {
                    DuckBranchChip(chrome: chrome).fixedSize()
                    Spacer()
                    Image(systemName: "ellipsis").foregroundStyle(Theme.muted)
                }
                .padding(.horizontal, Space.xl).frame(height: DuckSubheader.height)
                .overlay(alignment: .bottom) { Rectangle().fill(Theme.line).frame(height: 1) }
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
            }
            .background(alignment: .top) {
                DuckPondGradient(colour: gradientColour(hue: hue, dark: dark))
            }
        }
    }

    static func room(width: Double) -> some View {
        let task = RoomTask(id: "t1", messageId: "m2", title: "Greeting copy for the sign-in screen", state: .working)
        let card = RoomTasks.card(for: task, among: [task])
        return page(width: width, height: 560, centre: PondCentre(page: .room)) {
            VStack(alignment: .leading, spacing: 0) {
                RoomRow(first: true, avatar: { ThreadDuckView(id: "me", size: 28) }, at: 1_700_000_000_000, header: {
                    RoomNameLine(tag: nil, at: 1_700_000_000_000) { Text("You").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.ink) }
                }, content: { RoomRowBody(text: "Can someone write the greeting copy for the sign-in screen?") })
                RoomRow(first: false, avatar: { EmptyView() }, at: 1_700_000_060_000, header: { EmptyView() },
                        content: { RoomRowBody(text: "Keep it short, one friendly line.") })
                RoomRow(first: true, avatar: { ThreadDuckView(id: "dhol", size: 28) }, at: 1_700_000_120_000, header: {
                    RoomNameLine(tag: "Duck", at: 1_700_000_120_000) { Text("Dhol").font(.system(size: 13, weight: .semibold)).foregroundStyle(Theme.ink) }
                }, content: { RoomRowBody(text: "On it. I will draft three options and put the best one in the screen.") })
                if let card {
                    RoomTaskCardView(card: card, at: 1_700_000_180_000, act: { _, _, _ in }, open: nil)
                        .padding(.horizontal, 12).padding(.leading, CGFloat(RoomRowPlan.avatar) + CGFloat(RoomRowPlan.gutterGap))
                }
            }
            .padding(.top, Space.l)
        }
    }

    static func dashboard(width: Double) -> some View {
        page(width: width, height: 640, centre: PondCentre(page: .dashboard)) {
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

    static func shots() -> [Shot] {
        var out: [Shot] = []
        func add(_ name: String, _ w: Double, _ h: Double, dark: Bool = false, _ v: some View) {
            out.append(Shot(name: name, width: w, height: h, dark: dark, view: AnyView(v)))
        }
        for (label, dark) in [("light", false), ("dark", true)] {
            add("dashboard-\(label)", 1500, 640, dark: dark, dashboard(width: 1500))
            add("room-\(label)", 1500, 560, dark: dark, room(width: 1500))
            add("duck-green-\(label)", 1500, 640, dark: dark, duckPage(width: 1500, hue: 140, dark: dark))
            add("duck-violet-\(label)", 1500, 640, dark: dark, duckPage(width: 1500, hue: 285, dark: dark))
            for w in [1500.0, 1000.0] {
                let n = Int(w)
                add("bar-duck-and-notebook-\(n)-\(label)", w, 56, dark: dark,
                    bar(width: w, centre: PondCentre(page: .room, duck: "dhol"), withPip: true))
                add("bar-room-selected-\(n)-\(label)", w, 56, dark: dark, bar(width: w, centre: PondCentre(page: .room)))
                add("bar-notebook-selected-\(n)-\(label)", w, 56, dark: dark,
                    bar(width: w, centre: PondCentre(page: .room, item: TabItem(.notebook, "nb"))))
            }
        }
        return out
    }
}
