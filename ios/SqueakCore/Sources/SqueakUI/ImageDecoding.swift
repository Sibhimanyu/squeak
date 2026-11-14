#if os(iOS)
import SwiftUI
import SqueakCore
import UIKit

/// Decoding pictures off the main actor: `UIImage(data:)` is lazy, so the first draw would otherwise pay for the
/// decode on the main thread, mid-scroll. These do the read, the decode and `byPreparingForDisplay` on a background
/// task and hand back a bitmap that draws at once.
enum ImageDecoding {
    static func decode(_ data: Data) async -> UIImage? {
        await Task.detached(priority: .userInitiated) { () -> UIImage? in
            guard let image = UIImage(data: data) else { return nil }
            return await image.byPreparingForDisplay() ?? image
        }.value
    }

    static func decode(contentsOf url: URL) async -> UIImage? {
        await Task.detached(priority: .userInitiated) { () -> UIImage? in
            guard let data = try? Data(contentsOf: url), let image = UIImage(data: data) else { return nil }
            return await image.byPreparingForDisplay() ?? image
        }.value
    }
}

/// The account photo's bytes kept in Caches (not backed up, file-protected), so the next launch shows it before the
/// network answers. Removed on sign-out.
enum AvatarDisk {
    private static var url: URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?.appendingPathComponent("squeak-account-avatar.jpg")
    }

    static func save(_ data: Data) {
        guard let url else { return }
        try? data.write(to: url, options: [.atomic, .completeFileProtection])
    }

    static func load() async -> UIImage? {
        guard let url else { return nil }
        return await ImageDecoding.decode(contentsOf: url)
    }

    static func clear() { if let url { try? FileManager.default.removeItem(at: url) } }
}

/// The account's Mac list (names, online/asleep/offline, last seen) as the relay last said it, kept in Caches so the
/// list, and the choice of a Mac, draws before the relay answers; the answer replaces it. Removed on sign-out.
enum AccountMacsDisk {
    private static var url: URL? {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask).first?.appendingPathComponent("squeak-account-macs.json")
    }

    static func load() -> [AccountMac] {
        guard let url, let data = try? Data(contentsOf: url) else { return [] }
        return (try? JSONDecoder().decode([AccountMac].self, from: data)) ?? []
    }

    static func save(_ macs: [AccountMac]) {
        guard let url, let data = try? JSONEncoder().encode(macs) else { return }
        try? data.write(to: url, options: [.atomic, .completeFileProtection])
    }

    static func clear() { if let url { try? FileManager.default.removeItem(at: url) } }
}
#endif
