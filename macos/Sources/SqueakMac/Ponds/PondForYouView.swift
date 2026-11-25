import SqueakIcons
import SqueakMacCore
import SwiftUI

// DESIGN.md 8.12, "For you": the first card on a Pond's Dashboard, and the same list the sidebar's yellow badge counts.

extension AppModel {
    /// What waits on the person in a Pond. One function for the sidebar badge and the Dashboard card (`PondForYou`).
    func forYou(pond key: String) -> PondForYou {
        let chats = pondProject(key).workspaces.flatMap(\.chats)
        var ducks: [RosterDuck] = []
        if let native = PondsModel.shared.native(key: key) {
            let threads = PondRoomStore.shared.model(for: native.id).feed.threads
            ducks = RoomRoster.roster(RoomRosterStore.shared.model(for: native.id).list, threads: threads).onDuty
        }
        func sid(_ s: HostSession) -> String { NativeAdapter.nativeId(s) ?? s.key.hostSessionId }
        func duck(for s: HostSession) -> RosterDuck? { ducks.first { $0.sessionId == sid(s) || (s.duckId != nil && $0.id == s.duckId) } }
        var input: [ForYouChat] = ducks.filter { $0.presence == .waiting && $0.sessionId != nil }.map {
            ForYouChat(sessionId: $0.sessionId!, duckName: $0.name, title: "", unread: false, waiting: true)
        }
        // Only a chat that is a listed Duck can be for you: a chat the roster does not list is not a Duck of this Pond.
        input += chats.sorted { ($0.lastActivityAt ?? .distantPast) > ($1.lastActivityAt ?? .distantPast) }.compactMap { s in
            guard let d = duck(for: s) else { return nil }
            return ForYouChat(sessionId: sid(s), duckName: d.name, title: s.title, unread: isUnread(s), waiting: d.presence == .waiting)
        }
        return PondForYou.build(input)
    }
}

extension AppModel {
    /// The Duck's name for a chat, from the host's roster; nil when the chat has no Duck identity (callers then fall back).
    func duckName(of s: HostSession) -> String? {
        guard let key = PondsModel.shared.key(of: s), let native = PondsModel.shared.native(key: key) else { return nil }
        let threads = PondRoomStore.shared.model(for: native.id).feed.threads
        let roster = RoomRosterStore.shared.model(for: native.id).list
        let sid = NativeAdapter.nativeId(s) ?? s.key.hostSessionId
        let d = RoomRoster.roster(roster, threads: threads)
        return (d.onDuty + d.offDuty).first { $0.sessionId == sid || (s.duckId != nil && $0.id == s.duckId) }?.name
    }
}

struct PondForYouCard: View {
    let key: String
    @Environment(AppModel.self) private var model

    var body: some View {
        let list = model.forYou(pond: key)
        if !list.isEmpty {
            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("For you").font(Typo.heading).foregroundStyle(Theme.ink).accessibilityAddTraits(.isHeader)
                    Spacer(minLength: 0)
                    Text("\(list.count)").font(.system(size: 12, weight: .bold)).monospacedDigit()
                        .foregroundStyle(Color(nsColor: NSColor(hex: Tokens.duckOutline)))
                        .padding(.horizontal, 6).frame(minWidth: 18, minHeight: 18).background(Theme.duck, in: Capsule())
                }
                ForEach(list.items) { item in
                    HStack(spacing: 10) {
                        if item.reason == .waiting { Lucide(.triangleAlert, size: 13, color: Theme.warning) }
                        Text(verbatim: item.line).font(.system(size: 13)).foregroundStyle(Theme.ink).lineLimit(1)
                        Spacer(minLength: 8)
                        Button("Open") { _ = model.openFromPond(.duck(item.sessionId), pond: key, page: .dashboard) }
                            .buttonStyle(PondPrimaryButtonStyle()).accessibilityLabel("Open \(item.name)")
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            .padding(16).frame(maxWidth: .infinity, alignment: .leading)
            .background(Theme.surface, in: RoundedRectangle(cornerRadius: 12))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.duck.opacity(0.5)))
        }
    }
}
