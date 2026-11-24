import Foundation

/// How many turns of a Squeak chat's log are read at a time. Every loaded turn is laid out in one stack (a lazy stack
/// of tall rows estimates heights and can leave the end blank), so the size of a page is the size of the layout hitch
/// when a chat opens and each time the reader reaches the top. Measured on real long messages, a first layout costs
/// about 5 ms a row while one appended row costs about 2.5 ms in all: the cost is in what is laid out at once, so a page
/// is small and the top keeps asking for the next one while it is still in view (`SessionDetailView.pageUp`).
public enum TimelinePaging {
    /// Turns read when a chat opens (the newest).
    public static let firstPage = 12
    /// Turns read each time the reader reaches the top.
    public static let olderPage = 12
}

extension TimelinePaging {
    /// Whether the top, still in view with no page in flight, should ask for the next older page by itself: after a page
    /// landed (a short page leaves the top in view), and once the anchor that held the reader's place has been released.
    public static func wantsNextPage(topVisible: Bool, paging: EarlierPaging, holdingAnchor: Bool) -> Bool {
        topVisible && !holdingAnchor && !paging.loading && paging.error == nil
    }
}
