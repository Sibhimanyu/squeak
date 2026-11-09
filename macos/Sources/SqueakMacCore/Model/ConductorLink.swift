/// Whether this build carries the Conductor relay's setup (Settings › Conductor, its setup step, its code). The
/// relay redirects Conductor's own Remote Control host to a local server and adds a paired device to Conductor's
/// Keychain item, so the release is built without it: compile with `SQUEAK_CONDUCTOR_RELAY=1` in the environment
/// (Package.swift turns it into the `SQUEAK_CONDUCTOR_RELAY` define). Replies to Conductor chats go through
/// Conductor's window or the background route either way, and never need it.
public enum ConductorLink {
    #if SQUEAK_CONDUCTOR_RELAY
    public static let isBuiltIn = true
    #else
    public static let isBuiltIn = false
    #endif
}
