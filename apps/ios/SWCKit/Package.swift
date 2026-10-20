// swift-tools-version: 6.2
import PackageDescription

// SWCKit holds everything except the app entry point, so the protocol, sync and
// design layers can be tested with `swift test` without a simulator.
//
// Dependency direction: SWCWire <- SWCTransport <- SWCSync <- SWCFeatures, and
// Weave (design system) depends on nothing. No third-party packages.
let mainActorUI: [SwiftSetting] = [
  .defaultIsolation(MainActor.self),
  .enableUpcomingFeature("NonisolatedNonsendingByDefault"),
]

let package = Package(
  name: "SWCKit",
  platforms: [.iOS(.v26), .macOS(.v15)],
  products: [
    .library(name: "SWCFeatures", targets: ["SWCFeatures"]),
    .library(name: "Weave", targets: ["Weave"]),
    .library(name: "SWCSync", targets: ["SWCSync"]),
    .library(name: "SWCTransport", targets: ["SWCTransport"]),
  ],
  targets: [
    .target(name: "SWCWire"),
    .target(name: "SWCTransport", dependencies: ["SWCWire"]),
    .target(name: "SWCSync", dependencies: ["SWCWire", "SWCTransport"]),
    .target(name: "Weave", resources: [.process("Resources")], swiftSettings: mainActorUI),
    .target(name: "SWCFeatures", dependencies: ["SWCSync", "Weave"], swiftSettings: mainActorUI),
    .testTarget(name: "SWCWireTests", dependencies: ["SWCWire"], resources: [.copy("Fixtures")]),
    .testTarget(name: "SWCTransportTests", dependencies: ["SWCTransport"]),
    .testTarget(name: "SWCSyncTests", dependencies: ["SWCSync"]),
    .testTarget(name: "SWCFeaturesTests", dependencies: ["SWCFeatures", "SWCSync"]),
  ]
)
