#if os(iOS)
import Combine
import SqueakCore
import SwiftUI

/// Where a link asks Squeak to go. The app hands links to it; the
/// session list opens the session once it is in the snapshot — which, right
/// after a cold launch, can take a few seconds to arrive.
@MainActor
public final class SqueakRouter: ObservableObject {
    public static let shared = SqueakRouter()

    /// A Conductor session id waiting to be opened.
    @Published public private(set) var pendingSessionId: String?

    /// A `squeak://pair?d=…` link, from the Camera app scanning the Mac's QR code, waiting for the app to pair with.
    @Published public private(set) var pendingPairing: String?

    public func open(sessionId: String) { pendingSessionId = sessionId }

    /// Returns true and forgets the request when `url` was a Squeak link.
    @discardableResult
    public func handle(_ url: URL) -> Bool {
        if url.scheme?.lowercased() == "squeak", url.host == "pair" {
            pendingPairing = url.absoluteString
            return true
        }
        guard let id = SqueakLink.sessionId(from: url) else { return false }
        open(sessionId: id)
        return true
    }

    func consume() { pendingSessionId = nil }

    func consumePairing() { pendingPairing = nil }
}
#endif
