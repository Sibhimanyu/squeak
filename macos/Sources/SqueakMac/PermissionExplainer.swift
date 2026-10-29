import AppKit
import CoreGraphics
import Observation
import SqueakIcons
import SqueakMacCore
import SwiftUI

/// Reads and asks for one macOS permission. `PermissionFlow` (SqueakMacCore) decides every label and line;
/// this gathers the reading and presses the button.
@MainActor @Observable
final class PermissionExplainerModel {
    let kind: PermissionKind
    private(set) var flow: PermissionFlow
    @ObservationIgnored private let demo: Bool
    /// Asks the daemon what Squeak Hands holds (nil: daemon unreachable or too old).
    @ObservationIgnored private let handsReader: (() async -> HandsGrants?)?

    init(kind: PermissionKind, demo: Bool = false, handsReader: (() async -> HandsGrants?)? = nil) {
        self.kind = kind
        self.demo = demo
        self.handsReader = handsReader
        flow = PermissionFlow(kind: kind, grant: kind.isReadable ? .notGranted : .unreadable)
    }

    /// One reading. Squeak Hands holds Accessibility, Automation and Location itself; the daemon asks it
    /// (`GET /control/hands/grants`). Only when that gives nothing (an old daemon or Hands) do they stay
    /// `unreadable` until the person says they are on.
    func refresh() async {
        guard !demo else { return }
        switch kind {
        case .notifications:
            switch await Notifier.shared.access() {
            case .authorized: flow = flow.reading(await Notifier.shared.bannersShown() == false ? .denied : .granted)
            case .denied: flow = flow.reading(.denied)
            case .notDetermined, .unknown: flow = flow.reading(.notGranted)
            }
        case .inputMonitoring:
            flow = flow.reading(CGPreflightListenEventAccess() ? .granted : .notGranted)
        case .accessibility, .automation, .location:
            guard let handsReader else { break }
            flow = flow.readingHands(await handsReader())
        }
    }

    /// The one button: macOS's own prompt where there is one, else the exact System Settings pane.
    func press() {
        switch kind {
        case .notifications:
            if flow.opensPane { GeneralSettings.openNotificationSettings() } else { Notifier.shared.requestAuthorization() }
        case .inputMonitoring:
            HotKeyCenter.shared.requestInputMonitoring()
        case .accessibility, .automation, .location:
            if let url = URL(string: kind.paneURL) { NSWorkspace.shared.open(url) }
        }
        flow = flow.pressed()
    }

    func confirm() { flow = flow.confirmedByPerson() }
    func relaunch() { HotKeyCenter.shared.relaunch() }
}

private extension PermissionKind {
    var isReadable: Bool { self == .notifications || self == .inputMonitoring }
    /// Held by Squeak Hands, read through the daemon every 2 s.
    var holdsInHands: Bool { !isReadable }
}

/// "What it is for, what Squeak never does, which app to find, one button", ticking by itself once macOS says yes.
struct PermissionExplainer: View {
    @State private var model: PermissionExplainerModel
    /// Called once when the grant is seen (or confirmed), so a screen can move on.
    var onGranted: (() -> Void)?
    @State private var announced = false

    init(kind: PermissionKind, handsReader: (() async -> HandsGrants?)? = nil, onGranted: (() -> Void)? = nil) {
        _model = State(initialValue: PermissionExplainerModel(kind: kind, handsReader: handsReader))
        self.onGranted = onGranted
    }

    var body: some View {
        let f = model.flow
        Card {
            VStack(alignment: .leading, spacing: Space.s) {
                HStack(spacing: Space.s) {
                    if f.isGranted {
                        Lucide(.check, size: 14, color: Theme.working)
                    } else {
                        Circle().fill(Theme.muted).frame(width: 8, height: 8).accessibilityHidden(true)
                    }
                    Text(f.isGranted ? "\(f.kind.title) is on" : f.kind.title).font(Typo.label).foregroundStyle(Theme.ink)
                    Spacer(minLength: 0)
                }
                SettingsRowSketch(kind: f.kind, granted: f.isGranted)
                if !f.isGranted {
                    Text(f.kind.purpose).font(Typo.body).foregroundStyle(Theme.ink).fixedSize(horizontal: false, vertical: true)
                    Text(f.kind.never).font(Typo.body).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                    if f.opensPane || !f.kind.hasSystemPrompt {
                        Text(f.findLine).font(Typo.meta).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                    }
                    HStack(spacing: Space.s) {
                        Button(f.buttonTitle) { model.press() }.buttonStyle(PrimaryButtonStyle())
                        if f.offersConfirm { Button("It's on") { model.confirm() }.buttonStyle(SecondaryButtonStyle()) }
                        if f.offersRelaunch { Button("Relaunch Squeak") { model.relaunch() }.buttonStyle(SecondaryButtonStyle()) }
                    }
                    if let line = f.outdatedLine {
                        Text(line).font(Typo.meta).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                    }
                    if let line = f.denialLine {
                        Text(line).font(Typo.meta).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                    }
                    if f.offersRelaunch {
                        Text("macOS applies this to a new copy of Squeak. If you just turned it on, relaunch.")
                            .font(Typo.meta).foregroundStyle(Theme.muted).fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
        .accessibilityElement(children: .contain)
        .task {
            while !Task.isCancelled {
                await model.refresh()
                try? await Task.sleep(for: .seconds(model.kind.holdsInHands ? 2 : 1))
            }
        }
        .onChange(of: model.flow.isGranted) { _, granted in
            guard granted, !announced else { return }
            announced = true
            onGranted?()
        }
    }
}
