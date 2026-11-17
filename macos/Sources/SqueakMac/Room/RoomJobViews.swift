import SqueakIcons
import SqueakMacCore
import SwiftUI

// Room jobs (CONTRACT-jobs.md): the buttons of a duck's offer or claim and of Squeak's one quiet line. Nothing is taken or
// started until the person presses Go or Allow.

struct SmallButtonStyle: ButtonStyle {
    let role: RoomJobButton.Role
    @Environment(\.isEnabled) private var isEnabled
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 12, weight: role == .primary ? .semibold : .regular))
            .foregroundStyle(role == .primary ? Theme.primaryText : (role == .quiet ? Theme.muted : Theme.ink))
            .padding(.horizontal, 10).frame(minHeight: 24)
            .background {
                switch role {
                case .primary: RoundedRectangle(cornerRadius: Radius.control, style: .continuous).fill(configuration.isPressed ? Theme.primaryPressed : Theme.primaryFill)
                case .secondary: RoundedRectangle(cornerRadius: Radius.control, style: .continuous).fill(Theme.surfaceRaised.opacity(configuration.isPressed ? 0.7 : 1))
                case .quiet: Color.clear
                }
            }
            .overlay { if role == .secondary { RoundedRectangle(cornerRadius: Radius.control, style: .continuous).strokeBorder(Theme.line) } }
            .opacity(isEnabled ? 1 : 0.5)
    }
}
