// swift-tools-version: 6.0
import Foundation
import PackageDescription

// ADD-ONS. `Addons/Conductor` ships in every build (the Conductor add-on, inert until it is added in Settings › Add-ons);
// to leave it out, delete Addons/Conductor/ (Package.swift notices; the app then has no add-ons).
// ---- add-on block: begin ----
let withConductor = FileManager.default.fileExists(atPath: Context.packageDirectory + "/Addons/Conductor/Sources/Conductor")
let addonTargets: [Target] = (withConductor ? [
    .target(name: "Conductor", dependencies: ["SqueakMacCore"], path: "Addons/Conductor/Sources/Conductor"),
    .testTarget(
        name: "ConductorTests", dependencies: ["Conductor", "SqueakMacCore"],
        path: "Addons/Conductor/Tests/ConductorTests"),
] : [])
// SqueakMacAddons registers what is built in: the Conductor add-on, or nothing when Addons/Conductor/ is gone.
let addonsRegistrar: Target = .target(
    name: "SqueakMacAddons",
    dependencies: ["SqueakMacCore"] + (withConductor ? ["Conductor"] : []),
    path: withConductor ? "Sources/SqueakMacAddons" : "Sources/SqueakMacAddonsNone")
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
        .package(url: "https://github.com/Sibhimanyu/heresay-swift", from: "0.2.48"),
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
            resources: [.copy("Fixtures/native"), .copy("Fixtures/ponds")]),
    ] + addonTargets,
    swiftLanguageModes: [.v6]
)
