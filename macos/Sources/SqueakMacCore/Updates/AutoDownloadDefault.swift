import Foundation

/// "Download automatically" is off unless the person turns it on. Older builds wrote `true` themselves when the key
/// was unset, so once (guarded by a marker) that app-written value is reset; a choice made afterwards is kept.
public enum AutoDownloadDefault {
    public static let markerKey = "SqueakUpdatesDownloadDefaultV2"

    /// The value to store, or nil to leave the stored value alone.
    public static func migratedValue(stored: Bool?, markerSet: Bool) -> Bool? {
        guard !markerSet else { return nil }
        return stored == true ? false : nil
    }
}
