// swift-tools-version: 6.0
import Foundation
import PackageDescription

// ADD-ONS (not distributed; see Addons/<Name>/README.md). An add-on is built in only when its folder exists AND the
// environment asks for it: `SQUEAK_ADDONS=conductor-relay swift build` (`SQUEAK_CONDUCTOR_RELAY=1` also works). The release
// build sets neither. To remove the Conductor relay: delete Addons/ConductorRelay/ and this block (nothing else refers to it).
// ---- add-on block: begin ----
let askedFor = (Context.environment["SQUEAK_ADDONS"] ?? "").split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }
let withRelay = (askedFor.contains("conductor-relay") || Context.environment["SQUEAK_CONDUCTOR_RELAY"] == "1")
    && FileManager.default.fileExists(atPath: Context.packageDirectory + "/Addons/ConductorRelay/Sources/ConductorRelay")
let addonTargets: [Target] = withRelay ? [
    .target(name: "ConductorRelay", dependencies: ["SqueakMacCore"], path: "Addons/ConductorRelay/Sources/ConductorRelay"),
    .testTarget(
        name: "ConductorRelayTests", dependencies: ["ConductorRelay", "SqueakMacCore"],
        path: "Addons/ConductorRelay/Tests/ConductorRelayTests", resources: [.copy("Fixtures/relay-vectors.json")]),
] : []
// SqueakMacAddons registers what is built in: an empty stub, or (with the add-on) the add-on's own file of the same name.
let addonsRegistrar: Target = .target(
    name: "SqueakMacAddons", dependencies: ["SqueakMacCore"] + (withRelay ? ["ConductorRelay"] : []),
    path: withRelay ? "Addons/ConductorRelay/Sources/SqueakMacAddons" : "Sources/SqueakMacAddons")
// ---- add-on block: end ----

let package = Package(
    name: "SqueakMac",
    platforms: [.macOS(.v14)],
    products: [
        .library(name: "SqueakMacCore", targets: ["SqueakMacCore"]),
        .executable(name: "SqueakMac", targets: ["SqueakMac"]),
    ],
    dependencies: [
        .package(url: "https://github.com/sparkle-project/Sparkle", from: "2.6.0"),
        .package(url: "https://github.com/Sibhimanyu/heresay-swift", from: "0.2.0"),
        .package(url: "https://github.com/migueldeicaza/SwiftTerm", exact: "1.99.3"),
        .package(path: "../icons"),
        .package(path: "../markup"),
    ],
    targets: [
        .target(name: "SqueakMacCore"),
        addonsRegistrar,
        .executableTarget(
            name: "SqueakMac",
            dependencies: [
                "SqueakMacCore",
                "SqueakMacAddons",
                .product(name: "Sparkle", package: "Sparkle"),
                .product(name: "Heresay", package: "heresay-swift"),
                .product(name: "SwiftTerm", package: "SwiftTerm"),
                .product(name: "SqueakIcons", package: "icons"),
                .product(name: "SqueakMarkup", package: "markup"),
            ]),
        .testTarget(
            name: "SqueakMacCoreTests", dependencies: ["SqueakMacCore"],
            resources: [.copy("Fixtures/native")]),
    ] + addonTargets,
    swiftLanguageModes: [.v6]
)
