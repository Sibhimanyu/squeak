import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

// MARK: Duck

/// One mood sprite from `brand/mood-sprites/`, moving as its mood does (DESIGN.md §6.3). Reduced motion keeps
/// the sprite still and swaps by fade.
struct DuckSprite: View {
    let mood: SetupDuckMood
    var width: CGFloat = 112
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        ZStack {
            sprite.id(mood).transition(.opacity)
        }
        .frame(width: width, height: width)
        .animation(.easeOut(duration: SetupMotion.standard), value: mood)
        .accessibilityHidden(true)
    }

    @ViewBuilder private var sprite: some View {
        if reduceMotion || mood.motion == .still || mood.period == 0 {
            image
        } else {
            TimelineView(.animation) { ctx in
                let phase = ctx.date.timeIntervalSinceReferenceDate / mood.period
                switch mood.motion {
                case .bob: image.offset(y: -4 * sin(2 * .pi * phase))
                case .hop: image.offset(y: -12 * abs(sin(.pi * phase)))
                case .wobble: image.rotationEffect(.degrees(7 * sin(2 * .pi * phase)), anchor: .bottom)
                case .still: image
                }
            }
        }
    }

    @ViewBuilder private var image: some View {
        if let url = BrandAssets.moodURL(mood.spriteFile), let img = NSImage(contentsOf: url) {
            Image(nsImage: img).resizable().interpolation(.high).scaledToFit()
        } else {
            DuckMark(width: width * 0.8)
        }
    }
}

// MARK: Track

/// The five phases as a track that fills as you go.
struct SetupTrack: View {
    let current: SetupStage?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(spacing: 6) {
            ForEach(SetupStage.allCases) { s in
                VStack(alignment: .leading, spacing: 4) {
                    Capsule()
                        .fill(current.map { SetupDirector.isReached(s, current: $0) } == true ? Theme.duck : Theme.lineStrong)
                        .frame(height: 3)
                    Text(s.title).font(.system(size: 10, weight: s == current ? .semibold : .regular))
                        .foregroundStyle(s == current ? Theme.ink : Theme.muted).lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .animation(reduceMotion ? nil : .easeOut(duration: SetupMotion.standard), value: current)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Step \((current.flatMap { SetupStage.allCases.firstIndex(of: $0) } ?? 0) + 1) of \(SetupStage.allCases.count)")
    }
}

// MARK: Small parts

struct PulsingDot: View {
    let color: Color
    /// Seconds per pulse; nil is a still dot.
    var period: Double?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var on = false

    var body: some View {
        Circle().fill(color).frame(width: 8, height: 8)
            .opacity(on ? 0.35 : 1)
            .onAppear {
                guard let period, !reduceMotion else { return }
                withAnimation(.easeInOut(duration: period / 2).repeatForever(autoreverses: true)) { on = true }
            }
            .accessibilityHidden(true)
    }
}

private struct MiniRow: View {
    let dot: Color
    var pulse: Double?
    let title: String
    var meta: String?

    var body: some View {
        HStack(spacing: Space.s) {
            PulsingDot(color: dot, period: pulse)
            Text(title).font(Typo.body).foregroundStyle(Theme.ink).lineLimit(1)
            Spacer(minLength: 0)
            if let meta { Text(meta).font(Typo.meta).foregroundStyle(Theme.muted) }
        }
        .padding(.horizontal, Space.m).padding(.vertical, 7)
    }
}

/// A macOS banner, as it would arrive, with the real session title.
struct BannerPreview: View {
    let title: String
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown = false

    var body: some View {
        HStack(spacing: Space.s) {
            if let icon = NSApp?.applicationIconImage {
                Image(nsImage: icon).resizable().frame(width: 30, height: 30).accessibilityHidden(true)
            }
            VStack(alignment: .leading, spacing: 1) {
                Text("Squeak").font(Typo.label).foregroundStyle(Theme.ink)
                Text("\(title) needs you").font(Typo.meta).foregroundStyle(Theme.muted).lineLimit(1)
            }
            Spacer(minLength: 0)
            Text("now").font(Typo.meta).foregroundStyle(Theme.muted)
        }
        .padding(Space.s)
        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.card))
        .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Theme.line))
        .frame(maxWidth: 320)
        .opacity(shown ? 1 : 0)
        .offset(y: shown || reduceMotion ? 0 : -14)
        .onAppear { withAnimation(.timingCurve(0.2, 0.9, 0.3, 1.2, duration: SetupMotion.emphasis)) { shown = true } }
        .accessibilityLabel("Preview of a banner: \(title) needs you")
    }
}

/// An animated sketch of System Settings' own row: the app's name and icon, with a toggle that turns on.
struct SettingsRowSketch: View {
    let kind: PermissionKind
    let granted: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var demoOn = false

    var body: some View {
        HStack(spacing: Space.s) {
            icon.frame(width: 26, height: 26)
            Text(kind.appInList).font(Typo.body).foregroundStyle(Theme.ink)
            Spacer(minLength: 0)
            Capsule().fill(on ? Theme.working : Theme.lineStrong).frame(width: 34, height: 20)
                .overlay(alignment: on ? .trailing : .leading) { Circle().fill(Color.white).frame(width: 16, height: 16).padding(2) }
                .animation(.easeOut(duration: SetupMotion.quick), value: on)
        }
        .padding(Space.s)
        .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: Radius.control))
        .overlay(RoundedRectangle(cornerRadius: Radius.control).strokeBorder(Theme.line))
        .task {
            // Shows where to click: the toggle turns on, rests, and turns off again until the grant is real.
            guard !reduceMotion else { return }
            while !Task.isCancelled, !granted {
                try? await Task.sleep(for: .seconds(1.2)); demoOn = true
                try? await Task.sleep(for: .seconds(1.4)); demoOn = false
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("System Settings lists \(kind.appInList). Turn it on.")
    }

    private var on: Bool { granted || demoOn }

    @ViewBuilder private var icon: some View {
        if kind.listedAppIsHelper {
            Image(systemName: "hand.point.up.left.fill").font(.system(size: 13)).foregroundStyle(Theme.ink)
                .frame(width: 26, height: 26)
                .background(Theme.selected, in: RoundedRectangle(cornerRadius: 6))
        } else if let icon = NSApp?.applicationIconImage {
            Image(nsImage: icon).resizable()
        }
    }
}

// MARK: Hero

/// The top of every setup screen: the duck in its mood beside a live scene made from Squeak's own parts.
struct SetupHero: View {
    let plan: SetupScenePlan
    let rows: [ConnectRow]
    let doneStages: [SetupStage]
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(alignment: .center, spacing: Space.l) {
            DuckSprite(mood: plan.mood)
            ZStack(alignment: .leading) {
                scene.id(plan.scene).transition(sceneTransition)
            }
            .frame(maxWidth: .infinity, minHeight: 132, alignment: .leading)
        }
        .padding(Space.m)
        .frame(maxWidth: .infinity)
        .background(Theme.surface.opacity(0.6), in: RoundedRectangle(cornerRadius: Radius.card))
        .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Theme.line))
        .animation(reduceMotion ? .easeOut(duration: SetupMotion.quick) : .easeOut(duration: SetupMotion.standard), value: plan.scene)
        .animation(reduceMotion ? nil : .easeOut(duration: SetupMotion.standard), value: rows)
    }

    private var sceneTransition: AnyTransition {
        reduceMotion ? .opacity : .opacity.combined(with: .offset(x: 10))
    }

    @ViewBuilder private var scene: some View {
        switch plan.scene {
        case .welcome: welcome
        case .connect: connect
        case .menuBar(let title): MenuBarScene(sessionTitle: title)
        case .awayChoose: phone { MiniRow(dot: Theme.needsYou, pulse: 1.0, title: "Fix login", meta: "needs you") }
        case .iphone: phone { MiniRow(dot: Theme.needsYou, pulse: 1.0, title: "Fix login", meta: "needs you") }
        case .web: WebPhoneScene()
        case .telegram: TelegramScene()
        case .done: done
        }
    }

    private var welcome: some View {
        VStack(spacing: 0) {
            MiniRow(dot: Theme.needsYou, pulse: 1.0, title: "Needs you", meta: "an approval")
            Hairline()
            MiniRow(dot: Theme.working, pulse: 1.6, title: "Working", meta: "2 sessions")
            Hairline()
            MiniRow(dot: Theme.muted, title: "Finished", meta: "1 session")
        }
        .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
        .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Theme.line))
        .frame(maxWidth: 300)
        .accessibilityHidden(true)
    }

    private var connect: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            ForEach(rows) { row in
                HStack(spacing: Space.s) {
                    Group {
                        switch row.state {
                        case .done: Lucide(.check, size: 14, color: Theme.working)
                        case .failed: Lucide(.circleAlert, size: 14, color: Theme.needsYou)
                        case .working: PulsingDot(color: Theme.working, period: 1.6)
                        case .pending: Circle().strokeBorder(Theme.lineStrong, lineWidth: 1.5).frame(width: 9, height: 9)
                        }
                    }
                    .frame(width: 16, height: 16)
                    Text(row.title).font(Typo.label).foregroundStyle(Theme.ink)
                    if let d = row.detail { Text(d).font(Typo.body).foregroundStyle(Theme.muted) }
                }
                .transition(reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .bottom)))
            }
        }
        .accessibilityElement(children: .contain)
    }

    private var done: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            ForEach(doneStages) { s in
                HStack(spacing: Space.s) {
                    Lucide(.check, size: 14, color: Theme.working)
                    Text(s.title).font(Typo.body).foregroundStyle(Theme.ink)
                }
            }
        }
    }

    private func phone<C: View>(@ViewBuilder _ content: () -> C) -> some View {
        VStack(spacing: Space.s) {
            Capsule().fill(Theme.lineStrong).frame(width: 36, height: 4)
            content().background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.control))
            Spacer(minLength: 0)
        }
        .padding(Space.s)
        .frame(width: 190, height: 126)
        .background(Theme.bg, in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Theme.lineStrong, lineWidth: 2))
        .accessibilityHidden(true)
    }
}

/// A mock menu bar, the real template mark highlighted, a soft pointer, and the first session sliding in.
private struct MenuBarScene: View {
    let sessionTitle: String?
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var nudge = false

    var body: some View {
        VStack(alignment: .trailing, spacing: Space.s) {
            HStack(spacing: Space.m) {
                Text("Squeak").font(.system(size: 11, weight: .semibold)).foregroundStyle(Theme.muted)
                Spacer()
                Image(nsImage: MenuBarIcon.image(for: .normal)).renderingMode(.template).foregroundStyle(Theme.ink)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(Theme.duck.opacity(0.28), in: RoundedRectangle(cornerRadius: 5))
                Image(systemName: "wifi").foregroundStyle(Theme.muted)
                Image(systemName: "battery.100").foregroundStyle(Theme.muted)
            }
            .padding(.horizontal, Space.m).padding(.vertical, 6)
            .background(Theme.surfaceRaised, in: RoundedRectangle(cornerRadius: 8))
            if let sessionTitle {
                MiniRow(dot: Theme.working, pulse: 1.6, title: sessionTitle, meta: "working")
                    .background(Theme.surface, in: RoundedRectangle(cornerRadius: Radius.card))
                    .overlay(RoundedRectangle(cornerRadius: Radius.card).strokeBorder(Theme.line))
                    .transition(reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .top)))
            } else {
                HStack(spacing: 4) {
                    Image(systemName: "arrow.up").offset(y: nudge ? -3 : 1)
                    Text("Your agents show up here")
                }
                .font(Typo.meta).foregroundStyle(Theme.muted)
                .padding(.trailing, 6)
                .transition(.opacity)
            }
        }
        .frame(maxWidth: 320)
        .animation(reduceMotion ? nil : .easeOut(duration: SetupMotion.standard), value: sessionTitle)
        .onAppear {
            guard !reduceMotion else { return }
            withAnimation(.easeInOut(duration: 0.9).repeatForever(autoreverses: true)) { nudge = true }
        }
        .accessibilityElement(children: .combine)
    }
}

private struct WebPhoneScene: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var appeared = false

    var body: some View {
        VStack(spacing: Space.s) {
            Capsule().fill(Theme.lineStrong).frame(width: 36, height: 4)
            LazyVGrid(columns: Array(repeating: GridItem(.fixed(34), spacing: 10), count: 4), spacing: 10) {
                ForEach(0..<7, id: \.self) { _ in RoundedRectangle(cornerRadius: 8).fill(Theme.surfaceRaised).frame(width: 34, height: 34) }
                RoundedRectangle(cornerRadius: 8).fill(Theme.ink).frame(width: 34, height: 34)
                    .overlay {
                        if let img = BrandAssets.image(BrandAssets.duckFile(width: 24)) {
                            Image(nsImage: img).resizable().aspectRatio(contentMode: .fit).frame(width: 24)
                        }
                    }
                    .scaleEffect(appeared || reduceMotion ? 1 : 0.4).opacity(appeared ? 1 : 0)
            }
            Spacer(minLength: 0)
        }
        .padding(Space.s)
        .frame(width: 190, height: 126)
        .background(Theme.bg, in: RoundedRectangle(cornerRadius: 18))
        .overlay(RoundedRectangle(cornerRadius: 18).strokeBorder(Theme.lineStrong, lineWidth: 2))
        .onAppear { withAnimation(.easeOut(duration: SetupMotion.emphasis).delay(0.3)) { appeared = true } }
        .accessibilityHidden(true)
    }
}

private struct TelegramScene: View {
    var body: some View {
        VStack(alignment: .leading, spacing: Space.s) {
            Text("Fix login needs you").font(Typo.label).foregroundStyle(Theme.ink)
            Text("Allow edit to auth.ts?").font(Typo.body).foregroundStyle(Theme.muted)
            HStack(spacing: Space.s) {
                Text("Allow").font(Typo.meta).foregroundStyle(Theme.ink)
                    .padding(.horizontal, 12).padding(.vertical, 5).background(Theme.surfaceRaised, in: Capsule())
                Text("Reply").font(Typo.meta).foregroundStyle(Theme.ink)
                    .padding(.horizontal, 12).padding(.vertical, 5).background(Theme.surfaceRaised, in: Capsule())
            }
        }
        .padding(Space.m)
        .background(Theme.surface, in: UnevenRoundedRectangle(topLeadingRadius: 14, bottomLeadingRadius: 4, bottomTrailingRadius: 14, topTrailingRadius: 14))
        .overlay(UnevenRoundedRectangle(topLeadingRadius: 14, bottomLeadingRadius: 4, bottomTrailingRadius: 14, topTrailingRadius: 14).strokeBorder(Theme.line))
        .frame(maxWidth: 260)
        .accessibilityHidden(true)
    }
}
