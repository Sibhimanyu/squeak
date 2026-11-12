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
        .animation(Motion.standard, value: mood)
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
        if let img = BrandAssets.moodImage(mood.spriteFile) {
            Image(nsImage: img).resizable().interpolation(.high).scaledToFit()
        } else {
            DuckMark(width: width * 0.8)
        }
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
            Capsule().fill(on ? Theme.success : Theme.lineStrong).frame(width: 34, height: 20)
                .overlay(alignment: on ? .trailing : .leading) { Circle().fill(Color.white).frame(width: 16, height: 16).padding(2) }
                .animation(Motion.quick, value: on)
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

