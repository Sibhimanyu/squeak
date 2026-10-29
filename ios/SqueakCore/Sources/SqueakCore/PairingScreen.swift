import Foundation

/// Why a pairing did not happen. The words are fixed sentences, never a server body.
public enum PairingFailure: String, Hashable, Sendable {
    /// The Mac pressed "Not now".
    case refused
    /// The text or code was not a Squeak pairing code.
    case notACode
    /// Squeak's server could not be reached.
    case unreachable
    /// The Mac never answered.
    case expired

    public var title: String {
        switch self {
        case .refused: return "Your Mac said no"
        case .notACode: return "That isn't a Squeak code"
        case .unreachable: return "Couldn't reach Squeak"
        case .expired: return "Your Mac didn't answer"
        }
    }

    public var detail: String {
        switch self {
        case .refused: return "Pair again if that was a mistake."
        case .notACode: return "Open Squeak on your Mac, choose iPhone, and scan the code it shows."
        case .unreachable: return "Check the connection, then try again."
        case .expired: return "The request timed out. Make sure Squeak is open on your Mac, then try again."
        }
    }
}

/// The duck's mood on the unpaired screens (DESIGN.md §6.3). Raw values are the sprite names.
public enum PairingMood: String, Equatable, Sendable {
    case idle, working, celebrating, needsYou = "needs_you"
}

/// What the unpaired iPhone shows, decided here so it is tested and the views only draw.
public enum PairingScreen: Hashable, Sendable {
    /// Nothing started: one job, scan the code on the Mac.
    case ready
    /// Asked; waiting for the Mac's person to approve.
    case waiting(mac: String, code: String)
    /// The Mac said yes; the app opens in a moment.
    case approved(mac: String)
    case failed(PairingFailure)

    /// A pairing waits this long for the Mac before it counts as expired.
    public static let waitLimit: TimeInterval = 600
    /// How long the celebration shows before the app opens.
    public static let celebrationTime: TimeInterval = 1.4
    /// Where Squeak for Mac is downloaded.
    public static let downloadURL = "https://sibhimanyu.github.io/squeak/"

    public static func resolve(
        awaiting: (mac: String, code: String)?, approvedMac: String?, failure: PairingFailure?,
        waited: TimeInterval = 0
    ) -> PairingScreen {
        if let approvedMac { return .approved(mac: approvedMac) }
        if let awaiting {
            return waited >= waitLimit ? .failed(.expired) : .waiting(mac: awaiting.mac, code: awaiting.code)
        }
        if let failure { return .failed(failure) }
        return .ready
    }

    public var mood: PairingMood {
        switch self {
        case .ready: return .idle
        case .waiting: return .working
        case .approved: return .celebrating
        case .failed: return .needsYou
        }
    }

    public var title: String {
        switch self {
        case .ready: return "Scan the code on your Mac"
        case let .waiting(mac, _): return "Approve on \(mac)"
        case .approved: return "You're paired"
        case let .failed(failure): return failure.title
        }
    }

    public var detail: String {
        switch self {
        case .ready: return "On your Mac: Squeak \u{203A} Settings \u{203A} iPhone, or the setup's \u{201C}Away from this Mac\u{201D} step."
        case .waiting: return "Your Mac is showing this phone's request. Approve only if the code matches."
        case let .approved(mac): return "\(mac) is connected. Opening your sessions."
        case let .failed(failure): return failure.detail
        }
    }

    /// Said once, next to Scan, before the camera is asked for.
    public static let cameraReason = "Squeak uses the camera only to read the code. Nothing is saved."
    public static let pasteLabel = "Paste a pairing link"
    public static let noMacLabel = "Don't have Squeak on your Mac yet?"
    public static let tryAgain = "Try again"
    /// What the person will see on the Mac, in the waiting state.
    public static let macPromptTitle = "Pair this iPhone?"
    public static let macPromptLine = "Approve only if the code matches your iPhone."
}
