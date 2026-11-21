import Foundation
import Observation
import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

/// Pure decision for the shared glyph clock: it runs only while some glyph is on screen and the app is visible.
public struct TideClockPolicy: Sendable, Equatable {
    public private(set) var subscribers = 0
    public var occluded = false
    public var hidden = false
    public init() {}
    public mutating func subscribe() { subscribers += 1 }
    public mutating func unsubscribe() { subscribers = max(0, subscribers - 1) }
    public var shouldRun: Bool { subscribers > 0 && !occluded && !hidden }
    /// The shared frame rate: a pixel glyph needs no more.
    public static let interval: TimeInterval = 1.0 / 15.0
}

/// One clock for every working glyph (was one display-rate `TimelineView` each). A single 15 fps timer ticks while at least one
/// glyph is subscribed and the app has a visible window; a glyph that disappears unsubscribes, and static states never subscribe.
@MainActor @Observable
public final class TideClock {
    public static let shared = TideClock()
    /// Seconds on the glyph clock; changes every tick, so only views that read it redraw.
    public private(set) var time: Double = TideMotion.clock(Date())
    @ObservationIgnored private var policy = TideClockPolicy()
    @ObservationIgnored private var timer: Timer?
    @ObservationIgnored private var observers: [NSObjectProtocol] = []

    private init() {
        let nc = NotificationCenter.default
        #if os(macOS)
        observers.append(nc.addObserver(forName: NSApplication.didChangeOcclusionStateNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.refreshVisibility() }
        })
        observers.append(nc.addObserver(forName: NSApplication.didHideNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.refreshVisibility() }
        })
        observers.append(nc.addObserver(forName: NSApplication.didUnhideNotification, object: nil, queue: .main) { [weak self] _ in
            MainActor.assumeIsolated { self?.refreshVisibility() }
        })
        #else
        for name in [UIApplication.didEnterBackgroundNotification, UIApplication.willEnterForegroundNotification] {
            observers.append(nc.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                MainActor.assumeIsolated { self?.refreshVisibility() }
            })
        }
        #endif
    }

    public func subscribe() { policy.subscribe(); refreshVisibility() }
    public func unsubscribe() { policy.unsubscribe(); update() }

    private func refreshVisibility() {
        #if os(macOS)
        policy.hidden = NSApp?.isHidden ?? false
        policy.occluded = !(NSApp?.occlusionState.contains(.visible) ?? true)
        #else
        policy.hidden = UIApplication.shared.applicationState == .background
        #endif
        update()
    }

    private func update() {
        if policy.shouldRun {
            guard timer == nil else { return }
            time = TideMotion.clock(Date())
            let t = Timer(timeInterval: TideClockPolicy.interval, repeats: true) { [weak self] _ in
                MainActor.assumeIsolated { self?.time = TideMotion.clock(Date()) }
            }
            t.tolerance = 0.005
            RunLoop.main.add(t, forMode: .common)
            timer = t
        } else {
            timer?.invalidate(); timer = nil
        }
    }
}
