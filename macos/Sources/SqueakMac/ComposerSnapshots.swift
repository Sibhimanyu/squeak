import AppKit
import SqueakIcons
import SqueakMacCore
import SwiftUI

// `SqueakMac --snapshots <dir> --group composer`: the live composer card (`ChatComposerBox`, `RoomComposer`, the ducklings'
// `DucklingStatusLine`, inline chips) and a sent message with inline pictures, from fixture data, light and dark. The views
// are the real ones; only the model menu in the toolbar is a fixture label (the real `NativeModelMenu` reads a live chat).

@MainActor
enum ComposerSnapshots {
    static let now = Date(timeIntervalSince1970: 1_800_000_000)
    static let width = Metrics.readingColumn + 2 * Metrics.readingInset

    static let several: [Duckling] = [
        Duckling(id: "d1", title: "YouTube: shared Google sign-in + Studio fallback", model: "Opus 5.5", status: .running,
                 startedAt: now.addingTimeInterval(-372)),
        Duckling(id: "d2", title: "Sign in with Zoom: core flow and token refresh", model: "Sonnet 5.5", status: .running,
                 startedAt: now.addingTimeInterval(-131)),
        Duckling(id: "d3", title: "Review the diff", model: "Haiku 5", status: .done,
                 startedAt: now.addingTimeInterval(-240), endedAt: now.addingTimeInterval(-10)),
    ]

    static let longText = """
        Two things before you ship this. First, the Google sign-in sheet still flashes white in dark mode for a frame before \
        the web view paints; give the container our bg colour so it never shows. Second, the Studio fallback should only kick \
        in when the YouTube scope is denied, not when the person cancels.

        Also:
        - keep the token refresh on the same queue as the sign-in, so two refreshes never race
        - log the scope we asked for and the one we got, without the token itself
        - the "Try again" button needs the same height as "Continue"
        - check the Zoom path still works when both accounts are signed in at once
        - and add a regression test for the cancel case, beside the sign-in tests

        When that is done, write a short note in the PR about what changed for people who already signed in.
        """

    /// The model menu as the toolbar shows it (`NativeModelMenu`'s label).
    struct ModelLabel: View {
        var body: some View {
            HStack(spacing: 6) {
                Text(verbatim: "Opus 5.5 1M").font(.system(size: 13, weight: .medium)).foregroundStyle(Theme.ink)
                Text(verbatim: "Medium").font(.system(size: 13)).foregroundStyle(Theme.muted)
                Lucide(.chevronDown, size: 11, color: Theme.muted)
            }
            .padding(.horizontal, 8)
        }
    }

    static func chat(text: String, working: Bool = false, canStop: Bool = false, status: DucklingSet? = nil, readyLine: String? = nil,
                     tray: ImageTray = ImageTray(), folder: String? = nil) -> some View {
        let has = !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        return ChatComposerBox(
            text: .constant(text), placeholder: working ? "Add a follow-up. Claude reads it after this turn" : "Message Pickle",
            editable: true, chatID: "snapshot", tray: tray, canSend: has, working: working, agent: "Claude", sendHelp: "Send (↵)",
            onSend: { _ in }, phase: working ? .working : .idle, canStop: canStop,
            mode: .skipApprovals, onMode: { _ in },
            contextText: "38% of the context used", contextUsed: 38,
            status: status.map { AnyView(DucklingStatusLine(parentId: "pickle", set: $0, readyLine: readyLine, now: now)) },
            folder: folder
        ) { ModelLabel() }
    }

    /// The composer at the bottom of a chat, at the reading column's width, with the end of an answer faded above it.
    static func scene(_ composer: some View, height: Double = 460) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Text("I moved the sign-in into one shared sheet, so Google and Zoom open the same way and dark mode no longer flashes. Two ducklings are still checking the edge cases.")
                .font(.system(size: 14)).foregroundStyle(Theme.ink).lineSpacing(5)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.top, 20)
                .mask(LinearGradient(colors: [.clear, .black], startPoint: .top, endPoint: .bottom))
            Spacer(minLength: 16)
            composer
        }
        .padding(.horizontal, Metrics.readingInset).padding(.bottom, 20)
        .frame(width: width, height: height)
        .background(Theme.bg)
    }

    /// Two small pictures, as a paste would bring them.
    static func picture(_ a: NSColor, _ b: NSColor) -> Data {
        let image = NSImage(size: NSSize(width: 96, height: 64))
        image.lockFocus()
        NSGradient(starting: a, ending: b)?.draw(in: NSRect(x: 0, y: 0, width: 96, height: 64), angle: 35)
        NSColor.white.withAlphaComponent(0.85).setFill()
        NSBezierPath(ovalIn: NSRect(x: 30, y: 16, width: 30, height: 30)).fill()
        image.unlockFocus()
        let rep = NSBitmapImageRep(data: image.tiffRepresentation!)!
        return rep.representation(using: .png, properties: [:])!
    }

    static let pictures = [picture(.systemTeal, .systemIndigo), picture(.systemOrange, .systemPink)]

    /// A tray holding two pasted pictures, and the tokens the composer inserted for them.
    static func trayWithPictures() -> (ImageTray, [String]) {
        let tray = ImageTray()
        var tokens: [String] = []
        tray.onInsert = { tokens.append($0) }
        tray.add(pictures.map(ImageSource.data))
        let deadline = Date().addingTimeInterval(3)
        while tray.preparing > 0, Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.05)) }
        tray.onInsert = nil
        return (tray, tokens)
    }

    /// The same two pictures saved in a chat's folder, as a sent message names them.
    static func savedFolder() -> (folder: String, tokens: [String]) {
        let folder = FileManager.default.temporaryDirectory.appendingPathComponent("squeak-snapshot-chat").path
        let prepared = pictures.compactMap(ImageAttachments.prepare)
        try? FileManager.default.removeItem(atPath: folder + "/.context")
        try? FileManager.default.createDirectory(atPath: folder, withIntermediateDirectories: true)
        let refs = (try? ImageAttachments.save(prepared, into: folder, makeID: { "c39f865b" })) ?? []
        let names = ["login-dark.png", "login-light.png"]
        return (folder, zip(names, refs).map { InlineAttachments.token(name: $0, path: $1) })
    }

    static func sent(_ text: String, folder: String) -> some View {
        HStack {
            Spacer(minLength: 0)
            InlineMessageText(text: text, folder: folder)
                .padding(.horizontal, 14).padding(.vertical, 10)
                .background(Theme.surface, in: UserBubbleShape())
                .overlay(UserBubbleShape().strokeBorder(Theme.line))
                .frame(maxWidth: width * 0.62, alignment: .trailing)
        }
        .padding(.horizontal, Metrics.readingInset).padding(.vertical, 24)
        .frame(width: width, height: 200, alignment: .top)
        .background(Theme.bg)
    }

    static func room(draft: String, picture: Bool = false) -> some View {
        let room = PondRoomModel(projectId: "squeak-snapshot-room")
        room.draft = draft
        if picture { room.tray.addImages([.data(pictures[0])]) }
        return RoomComposer(room: room, pondName: "greenroom", send: { _, _, _ in nil })
    }

    static func shots() -> [Shot] {
        var out: [Shot] = []
        let working = DucklingSet(running: 2, items: several)
        let (tray, tokens) = trayWithPictures()
        let saved = savedFolder()
        let inline = tokens.count == 2
            ? "Compare \(tokens[0]) with \(tokens[1]) and tell me which one reads better on a small screen."
            : "Compare the two pictures"
        let sentText = saved.tokens.count == 2
            ? "The dark one \(saved.tokens[0]) still flashes; the light one \(saved.tokens[1]) is fine. Can you match them?"
            : "The pictures"
        for (label, dark) in [("light", false), ("dark", true)] {
            func add(_ name: String, height: Double = 460, _ v: some View) {
                out.append(Shot(name: "\(name)-\(label)", width: width, height: height, dark: dark, view: AnyView(v), group: "composer"))
            }
            add("chat-idle", scene(chat(text: "")))
            add("chat-ducklings", scene(chat(text: "", status: working, readyLine: DucklingWords.readyLine(running: 2))))
            add("chat-working", scene(chat(text: "Use the shared sheet for Zoom too", working: true, canStop: true, status: working)))
            add("chat-working-empty", scene(chat(text: "", working: true, canStop: true)))
            add("chat-longtext", scene(chat(text: longText, status: working, readyLine: DucklingWords.readyLine(running: 2))))
            add("chat-inline-images", scene(chat(text: inline, tray: tray)))
            add("sent-inline-images", height: 200, sent(sentText, folder: saved.folder))
            add("room-idle", scene(room(draft: "")))
            add("room-longtext", scene(room(draft: longText)))
            add("room-picture", scene(room(draft: "Here is the new sign-in screen", picture: true)))
        }
        return out
    }
}
