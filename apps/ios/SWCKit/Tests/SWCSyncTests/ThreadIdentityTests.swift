import Foundation
import Testing
import SWCWire
@testable import SWCSync

@Suite struct ThreadIdentityTests {
  @Test func catalogNamesAndCrossVendorModel() {
    let provider = ServerProviderSummary(instanceId: "copilot", driver: "githubCopilot", displayName: "GitHub Copilot", models: [.init(slug: "claude-opus-5-5", name: "Opus 5.5")])
    let identity = ThreadIdentity(selection: .init(instanceId: "copilot", model: "claude-opus-5-5"), providers: [provider])
    #expect(identity.label == "GitHub Copilot · Opus 5.5")
    #expect(identity.providerBrand == "copilot")
    #expect(identity.modelBrand == "claude")
  }
  @Test func uncataloguedAndCustomIdsRemainVisible() {
    #expect(ThreadIdentity(selection: .init(instanceId: "claudeAgent", model: "claude-opus-5-5"), providers: []).label == "Claude Code · Opus 5.5")
    let custom = ThreadIdentity(selection: .init(instanceId: "private-lab", model: "team/model-v2"), providers: [])
    #expect(custom.label == "private-lab · team/model-v2")
    #expect(custom.providerBrand == nil)
    #expect(custom.modelBrand == nil)
  }
  @Test func registryMarksRequireOfficialIdentity() {
    let official = ServerProviderSummary(instanceId: "custom-instance", driver: "acpRegistry", displayName: "My Copilot", iconUrl: "https://cdn.agentclientprotocol.com/registry/v1/latest/github-copilot-cli.svg")
    let identity = ThreadIdentity(selection: .init(instanceId: "custom-instance", model: "claude-opus-5-5"), providers: [official])
    #expect(identity.providerBrand == "copilot")
    var droid = official
    droid.iconUrl = "https://cdn.agentclientprotocol.com/registry/v1/latest/factory-droid.svg"
    #expect(ThreadIdentity(selection: .init(instanceId: "custom-instance", model: "auto"), providers: [droid]).providerBrand == "factory")
    var forged = official
    forged.iconUrl = "https://example.com/registry/v1/latest/github-copilot-cli.svg"
    #expect(ThreadIdentity(selection: .init(instanceId: "custom-instance", model: "auto"), providers: [forged]).providerBrand == nil)
    forged.iconUrl = nil
    #expect(ThreadIdentity(selection: .init(instanceId: "custom-instance", model: "auto"), providers: [forged]).providerBrand == nil)
  }
  @Test func authoritativeCurrentSelectionWins() throws {
    var thread = try TestData.thread()
    thread.modelIdentity = try WireCoding.decoder.decode(ThreadModelIdentity.self, from: Data(#"{"current":{"instanceId":"codex","model":"gpt-6.1-sol"},"preferred":null,"kind":"running"}"#.utf8))
    let summary = ShellSummaries.threadSummary(thread, environmentId: "m", projectTitle: nil, machineLabel: "M", machineOnline: true)
    #expect(summary.identity.label == "Codex · GPT-6.1-sol")
    thread.latestUserMessageAt = thread.createdAt.addingTimeInterval(100)
    thread.updatedAt = thread.createdAt.addingTimeInterval(1000)
    let active = ShellSummaries.threadSummary(thread, environmentId: "m", projectTitle: nil, machineLabel: "M", machineOnline: true)
    #expect(active.activityAt == [thread.createdAt, thread.latestUserMessageAt!, thread.latestRunRequestedAt ?? .distantPast].max())
  }
}
