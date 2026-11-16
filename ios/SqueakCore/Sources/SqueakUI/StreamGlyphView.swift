#if os(iOS)
import SqueakCore
import SqueakIcons
import SwiftUI

/// A stream's state as one mark (DESIGN.md §8.1): working is the tide glyph in `working` (still while the Mac is not
/// answering), needs you an amber dot (never a count), error the circle-x in `negative`, idle nothing. The slot keeps
/// its size in every state, so a row never moves. The state is the Mac's rollup (`StatusRollup`); this only draws it.
struct StreamStateMark: View {
    let activity: StatusRollup.Activity
    var slotWidth: CGFloat = 24
    @Environment(AppModel.self) private var model

    var body: some View {
        ZStack {
            switch activity {
            case .working:
                TideGlyph(color: model.macIsLive ? Theme.working : Theme.subtle,
                          height: TideGlyph.Grid.mini.height(fittingWidth: slotWidth), still: !model.macIsLive)
            case .needsYou: StatusMark(kind: .waiting(count: nil), color: Theme.warning, size: 16)
            case .error: StatusMark(kind: .failed, color: Theme.negative, size: 16)
            case .idle: Color.clear
            }
        }
        .frame(width: slotWidth, height: 20)
        .accessibilityHidden(true)
    }
}

/// A pond row's trailing mark, in one fixed 34 x 20 slot so the row never changes size; idle draws nothing. How many
/// threads wait on you is in the row's own label, not on the mark.
struct PondStatusMark: View {
    let rollup: StatusRollup

    var body: some View {
        StreamStateMark(activity: rollup.activity, slotWidth: 34)
            .frame(width: 34, height: 20, alignment: .trailing)
    }
}
#endif
