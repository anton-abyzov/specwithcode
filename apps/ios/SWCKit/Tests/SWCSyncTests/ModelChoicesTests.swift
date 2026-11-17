import Foundation
import Testing
@testable import SWCSync
import SWCWire

/// The composer's model list: which models a thread can switch to, and what
/// a pick sends.
@Suite struct ModelChoicesTests {
  static func providers() throws -> [ServerProviderSummary] {
    let opus = try JSONDecoder().decode(ServerProviderModel.self, from: Data(ModelTraitsTests.modelJSON.utf8))
    return [
      ServerProviderSummary(instanceId: "grok", driver: "grok", models: [
        ServerProviderModel(slug: "grok-4.7", name: "Grok 4.7", aliases: ["grok-latest"]),
      ]),
      ServerProviderSummary(instanceId: "claudeAgent", driver: "claudeAgent", models: [
        opus,
        ServerProviderModel(slug: "claude-sonnet-5-5", name: "Claude Sonnet 5.5"),
      ]),
      ServerProviderSummary(instanceId: "codex", driver: "codex", enabled: false, models: [
        ServerProviderModel(slug: "gpt-5.5", name: "GPT-5.5"),
      ]),
      ServerProviderSummary(instanceId: "cursor", driver: "cursor", status: "error", models: [
        ServerProviderModel(slug: "composer-2", name: "Composer 2"),
      ]),
    ]
  }

  @Test func listsEveryReadyProvidersModelsAcrossProviders() throws {
    let current = ModelSelection(instanceId: "grok", model: "grok-4.7")
    let choices = ModelChoice.available(providers: try Self.providers(), current: current)
    #expect(choices.map(\.id) == ["grok/grok-4.7", "claudeAgent/claude-opus-5-5", "claudeAgent/claude-sonnet-5-5"])
    #expect(choices.map(\.provider) == ["Grok", "Claude Code", "Claude Code"])
    #expect(ModelChoice.grouped(choices).map(\.provider) == ["Grok", "Claude Code"])
  }

  @Test func keepsTheThreadsOwnModelWhenItsProviderIsNotReady() throws {
    let current = ModelSelection(instanceId: "cursor", model: "composer-2")
    let choices = ModelChoice.available(providers: try Self.providers(), current: current)
    #expect(choices.contains { $0.id == "cursor/composer-2" })
    #expect(!choices.contains { $0.instanceId == "codex" })
  }

  @Test func matchesByAlias() throws {
    let choices = ModelChoice.available(providers: try Self.providers(), current: ModelSelection(instanceId: "grok", model: "grok-latest"))
    #expect(choices.first { $0.matches(ModelSelection(instanceId: "grok", model: "grok-latest")) }?.slug == "grok-4.7")
  }

  /// A pick never carries the old model's options: Grok's effort must not reach Claude.
  @Test func aPickStartsFromThatModelsOwnOptions() throws {
    let choices = ModelChoice.available(providers: try Self.providers(), current: ModelSelection(instanceId: "grok", model: "grok-4.7"))
    let opus = try #require(choices.first { $0.slug == "claude-opus-5-5" })
    #expect(opus.selection == ModelSelection(instanceId: "claudeAgent", model: "claude-opus-5-5", options: nil))
    let traits = try #require(opus.traits(for: opus.selection))
    #expect(traits.controls.map(\.id).contains("ultracode"))
    let sonnet = try #require(choices.first { $0.slug == "claude-sonnet-5-5" })
    #expect(sonnet.traits(for: sonnet.selection) == nil)
  }

  @Test func threadSummaryCarriesItsChoicesAndModel() throws {
    var thread = try TestData.thread()
    thread.modelSelection = ModelSelection(instanceId: "grok", model: "grok-4.7")
    let summary = ShellSummaries.threadSummary(thread, environmentId: "env", projectTitle: "Percy", machineLabel: "M1", machineOnline: true, providers: try Self.providers())
    #expect(summary.modelChoices.count == 3)
    #expect(summary.modelSelection == thread.modelSelection)
    #expect(summary.traits == nil)
  }
}
