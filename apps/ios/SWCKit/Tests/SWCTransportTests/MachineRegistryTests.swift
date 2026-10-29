import Foundation
import Testing
@testable import SWCTransport

@Suite struct MachineRegistryRecoveryTests {
  @Test func automaticDiscoveryAndPairingPreserveDisconnect() async throws {
    let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
    defer { try? FileManager.default.removeItem(at: directory) }
    let registry = MachineRegistry(fileURL: directory.appendingPathComponent("machines.json"))
    let direct = try #require(MachineRoute(httpBase: "https://mac.example.com"))
    let tunnel = try #require(MachineRoute(httpBase: "https://tunnel.example.com"))
    _ = try await registry.recordPairing(environmentId: "m", label: "Mac", route: direct)
    // Automatic work may have already read the old enabled record before the pause.
    let old = try #require(await registry.machine("m"))
    try await registry.setEnabled(false, for: "m")
    _ = try await registry.recordConnect(environmentId: old.environmentId, label: "Account Mac", route: tunnel)
    #expect(await registry.machine("m")?.enabled == false)
    _ = try await registry.recordPairing(environmentId: "m", label: "Mac", route: direct, resumeConnection: false)
    #expect(await registry.machine("m")?.enabled == false)
    let reloaded = MachineRegistry(fileURL: directory.appendingPathComponent("machines.json"))
    #expect(await reloaded.machine("m")?.enabled == false)
    // Only an explicitly requested new pairing resumes it.
    _ = try await registry.recordPairing(environmentId: "m", label: "Mac", route: direct)
    #expect(await registry.machine("m")?.enabled == true)
  }
}
