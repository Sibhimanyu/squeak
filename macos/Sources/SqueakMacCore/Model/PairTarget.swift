import Foundation

/// What a pairing QR code opens: Squeak for iPhone (`squeak://pair?d=…`, which the iPhone app owns, scanned in the app or
/// with the Camera) or Squeak for Web (`https://squeak-mac.web.app/#pair=…`, which a phone's or a computer's browser opens).
/// The daemon writes the `squeak://` link; the web link carries the same payload behind `#pair=`.
public enum PairTarget: String, CaseIterable, Sendable, Identifiable {
    case app, web

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .app: "iPhone app"
        case .web: "Web"
        }
    }

    /// The text the QR code carries. Nil when the daemon's link is not a pairing link (web only).
    public func qrText(pairingURL: String) -> String? {
        switch self {
        case .app: pairingURL.hasPrefix("squeak://pair?") ? pairingURL : nil
        case .web: WebPairLink.url(fromPairingURL: pairingURL)
        }
    }

    /// What "Copy" puts on the clipboard: the same text as the QR, so a pasted link does what a scan does.
    public func copyText(pairingURL: String) -> String? { qrText(pairingURL: pairingURL) }

    public var copyLabel: String {
        switch self {
        case .app: "Copy pairing code"
        case .web: "Copy web link"
        }
    }

    public var steps: [String] {
        switch self {
        case .app: [
            "1. Open Squeak on your iPhone.",
            "2. Choose Pair with a Mac, then scan this code. Scanning with the Camera app opens Squeak too.",
            "3. Check the code on the phone matches the one here, then approve.",
        ]
        case .web: [
            "1. Point your phone's camera at this code. It opens Squeak for Web.",
            "2. Check the code in the browser matches the one here, then approve.",
        ]
        }
    }
}
