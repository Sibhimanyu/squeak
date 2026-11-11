import Foundation

/// Back and forward's places: a chat, or the New pond page (`nil` in `NavHistory` is still the Dashboard).
public enum WorkbenchPlace: Equatable, Sendable {
    case chat(SessionKey)
    case create
}
