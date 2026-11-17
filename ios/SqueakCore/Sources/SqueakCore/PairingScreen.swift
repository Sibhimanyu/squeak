import Foundation

/// The duck's mood on the signed-out and "Your Macs" screens (DESIGN.md §6.3). Raw values are the sprite names.
public enum PairingMood: String, Equatable, Sendable {
    case idle, working, celebrating, needsYou = "needs_you"
}
