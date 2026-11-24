import Foundation
import Testing
@testable import SWCSync
import SWCWire

/// The phone's model picker: what comes first, and what a search finds.
@Suite struct ModelPickerTests {
  static func choice(_ instance: String, _ provider: String, _ slug: String, _ name: String, descriptors: [ProviderOptionDescriptor] = []) -> ModelChoice {
    ModelChoice(instanceId: instance, provider: provider, slug: slug, name: name, descriptors: descriptors)
  }

  static let catalog: [ModelChoice] = [
    choice("codex", "Codex", "gpt-6.2-sol", "GPT-6.2 Sol"),
    choice("codex", "Codex", "gpt-6-astra", "GPT-6 Astra"),
    choice("claudeAgent", "Claude Code", "claude-opus-5-5", "Opus 5.5", descriptors: [ProviderOptionDescriptor(id: "fastMode", label: "Fast Mode", kind: .boolean)]),
    choice("claudeAgent", "Claude Code", "claude-haiku-5-5", "Haiku 5.5"),
    choice("cursor", "Cursor", "claude-opus-5-5", "Claude Opus 5.5"),
    choice("copilot", "Copilot Enterprise (abycrash)", "claude-opus-5", "Claude Opus 5"),
    choice("copilot", "Copilot Enterprise (abycrash)", "gpt-6.2-sol", "GPT-6.2 Sol"),
    choice("muse", "Muse Code", "muse-wonder-full-1.0", "Wonder Full 1.0"),
    choice("muse", "Muse Code", "muse-wonder-1.0", "Wonder 1.0"),
    choice("grok", "Grok", "grok-4.7-fast", "Grok 4.7 Fast"),
  ]

  @Test func aModelsFamilyIgnoresVendorVersionAndVariantWords() {
    let family = { (name: String) in ModelPicker.identity(of: Self.choice("x", "X", "slug", name)).family }
    #expect(family("Claude Opus 5.5") == "opus")
    #expect(family("Opus 5.5") == "opus")
    #expect(family("Wonder Full 1.0") == "wonder")
    #expect(family("Wonder 1.0") == "wonder")
    // Sol and Astra are separate lines, not variants of one.
    #expect(family("GPT-6.2 Sol") == "gpt sol")
    #expect(family("GPT-6 Astra") == "gpt astra")
    #expect(family("Claude") == "claude")
    #expect(ModelPicker.identity(of: Self.choice("x", "X", "slug", "GPT-6.2 Sol")).version == [6, 2])
  }

  @Test func thePickedModelsFamilyComesFirstThenItsProvider() {
    let layout = ModelPicker.layout(Self.catalog, selectedId: "muse/muse-wonder-1.0")
    #expect(layout.familyTitle == "Wonder")
    #expect(layout.family.map(\.name) == ["Wonder 1.0", "Wonder Full 1.0"])
    #expect(layout.providers.first?.provider == "Muse Code")
    #expect(layout.providers.dropFirst().map(\.provider) == ["Codex", "Claude Code", "Cursor", "Copilot Enterprise (abycrash)", "Grok"])
  }

  @Test func aFamilySpansProvidersNewestFirst() {
    let layout = ModelPicker.layout(Self.catalog, selectedId: "claudeAgent/claude-opus-5-5")
    #expect(layout.familyTitle == "Opus")
    #expect(layout.family.map(\.id) == ["claudeAgent/claude-opus-5-5", "cursor/claude-opus-5-5", "copilot/claude-opus-5"])
  }

  @Test func aLargeFamilyLeadsWithAFewAndKeepsTheRestUnderProviders() {
    let many = (1...8).map { Self.choice("p\($0)", "Provider \($0)", "claude-opus-5-5", "Claude Opus 5.5") }
    let layout = ModelPicker.layout(many, selectedId: "p3/claude-opus-5-5")
    #expect(layout.family.count == ModelPicker.familyLimit)
    #expect(layout.family.first?.id == "p3/claude-opus-5-5")
    #expect(layout.providers.count == 8)
  }

  @Test func aModelAloneInItsFamilyIsJustTheCurrentModel() {
    let layout = ModelPicker.layout(Self.catalog, selectedId: "codex/gpt-6-astra")
    #expect(layout.familyTitle == nil)
    #expect(layout.family.map(\.name) == ["GPT-6 Astra"])
    let none = ModelPicker.layout(Self.catalog, selectedId: nil)
    #expect(none.family.isEmpty)
    #expect(none.providers.first?.provider == "Codex")
  }

  @Test func recentPicksSkipTheFamilyAndUnknownModels() {
    let recents = ["muse/muse-wonder-full-1.0", "gone/model", "grok/grok-4.7-fast", "codex/gpt-6-astra", "cursor/claude-opus-5-5", "codex/gpt-6.2-sol"]
    let layout = ModelPicker.layout(Self.catalog, selectedId: "muse/muse-wonder-1.0", recentIds: recents)
    #expect(layout.recent.map(\.id) == ["grok/grok-4.7-fast", "codex/gpt-6-astra", "cursor/claude-opus-5-5"])
    #expect(ModelPicker.remembering("b", in: ["a", "b", "c"]) == ["b", "a", "c"])
    #expect(ModelPicker.remembering("z", in: ["a", "b", "c", "d", "e", "f"]).count == 6)
  }

  @Test func searchFindsNamesSlugsProvidersAndVendors() {
    let found = { (query: String) in ModelPicker.search(query, in: Self.catalog).matches.map(\.id) }
    #expect(found("opus") == ["claudeAgent/claude-opus-5-5", "cursor/claude-opus-5-5", "copilot/claude-opus-5"])
    #expect(found("sol copilot") == ["copilot/gpt-6.2-sol"])
    #expect(found("wonder") == ["muse/muse-wonder-full-1.0", "muse/muse-wonder-1.0"])
    #expect(found("anthropic").count == 4)
    #expect(found("github") == ["copilot/claude-opus-5", "copilot/gpt-6.2-sol"])
    // A provider is found from the start of a word, never from letters scattered inside it.
    #expect(found("cur") == ["cursor/claude-opus-5-5"])
    #expect(ModelPicker.search("ursor", in: Self.catalog).isClosest)
    #expect(found("rso").isEmpty)
    #expect(found("").isEmpty)
  }

  @Test func searchPutsThePickedModelsProviderFirstAmongEquals() {
    let found = ModelPicker.search("opus", in: Self.catalog, selectedId: "cursor/claude-opus-5-5")
    #expect(found.matches.first?.id == "cursor/claude-opus-5-5")
    #expect(!found.isClosest)
  }

  @Test func capabilityWordsFilterInsteadOfMatchingText() {
    let fast = ModelPicker.search("fast", in: Self.catalog)
    #expect(fast.filters == ["Fast"])
    #expect(fast.words.isEmpty)
    // Fast Mode, a small model, and a model named Fast.
    #expect(fast.matches.map(\.id) == ["claudeAgent/claude-opus-5-5", "claudeAgent/claude-haiku-5-5", "grok/grok-4.7-fast"])
    #expect(ModelPicker.search("cheap", in: Self.catalog).matches.map(\.name) == ["Haiku 5.5"])
    // The newest Opus only: Copilot's Opus 5 is an older release.
    #expect(ModelPicker.search("smart opus", in: Self.catalog).matches.map(\.id) == ["claudeAgent/claude-opus-5-5", "cursor/claude-opus-5-5"])
    #expect(ModelPicker.search("latest sol", in: Self.catalog).matches.count == 2)
  }

  @Test func aTypoFallsBackToLabelledClosestMatches() {
    let found = ModelPicker.search("wnder", in: Self.catalog)
    #expect(found.isClosest)
    #expect(found.matches.map(\.name) == ["Wonder Full 1.0", "Wonder 1.0"])
    let nothing = ModelPicker.search("zzzzzz", in: Self.catalog)
    #expect(nothing.matches.isEmpty)
    #expect(!nothing.isClosest)
    // Versions and short words are never guessed at.
    #expect(ModelPicker.search("9.9", in: Self.catalog).matches.isEmpty)
  }

  @Test func highlightsCoverEveryMatchedPart() {
    let text = "Claude Opus 5.5"
    let ranges = ModelPicker.highlights(in: text, words: ["opus", "5.5"])
    #expect(ranges.map { String(text[$0]) } == ["Opus", "5.5"])
    #expect(ModelPicker.highlights(in: text, words: []).isEmpty)
  }

  @Test func oddNamesNeverCrashAndAVersionWithATrailingZeroIsTheSameRelease() {
    let odd = [
      Self.choice("a", "A", "five", "5.5"),
      Self.choice("a", "A", "empty", ""),
      Self.choice("a", "A", "modèle", "Modèle Été 2"),
      Self.choice("a", "A", "opus-5", "Opus 5"),
      Self.choice("b", "B", "opus-5.0", "Opus 5.0"),
      Self.choice("c", "C", "opus-4.8", "Opus 4.8"),
    ]
    // A name with no words falls back to its slug.
    #expect(ModelPicker.identity(of: odd[0]).family == "five")
    #expect(ModelPicker.identity(of: odd[1]).family == "empty")
    #expect(ModelPicker.identity(of: odd[3]).version == ModelPicker.identity(of: odd[4]).version)
    #expect(ModelPicker.search("latest opus", in: odd).matches.map(\.id) == ["a/opus-5", "b/opus-5.0"])
    #expect(ModelPicker.search("été", in: odd).matches.map(\.slug) == ["modèle"])
    let layout = ModelPicker.layout(odd, selectedId: "c/opus-4.8")
    #expect(layout.family.map(\.id) == ["c/opus-4.8", "a/opus-5", "b/opus-5.0"])
    #expect(ModelPicker.layout(odd, selectedId: "a/empty").family.count == 1)
    #expect(ModelPicker.highlights(in: "Modèle Été 2", words: ["été"]).count == 1)
  }

  @Test func editDistanceCountsATranspositionOnce() {
    #expect(ModelPicker.boundedEditDistance("", "", max: 1) == 0)
    #expect(ModelPicker.boundedEditDistance("", "ab", max: 1) == nil)
    #expect(ModelPicker.boundedEditDistance("sonnte", "sonnet", max: 2) == 1)
    #expect(ModelPicker.boundedEditDistance("sonet", "sonnets", max: 2) == 2)
    #expect(ModelPicker.boundedEditDistance("abcdef", "uvwxyz", max: 2) == nil)
    #expect(ModelPicker.boundedEditDistance("opsu", "opus", max: 1) == 1)
    #expect(ModelPicker.boundedEditDistance("opus", "opus", max: 1) == 0)
    #expect(ModelPicker.boundedEditDistance("opus", "sonnet", max: 2) == nil)
  }

  /// A harness drops its own maker from a name, so one model reads
  /// "4 Carbon" on Gemini CLI and "Gemini 4 Carbon" on Copilot.
  @Test func familyHoldsAcrossHowProvidersNameAModel() {
    let providers = [
      ServerProviderSummary(instanceId: "gemini", driver: "gemini", models: [
        ServerProviderModel(slug: "gemini-4-carbon", name: "Gemini 4 Carbon"),
      ]),
      ServerProviderSummary(instanceId: "copilot", driver: "copilot", models: [
        ServerProviderModel(slug: "gemini-3-carbon", name: "Gemini 3 Carbon"),
        ServerProviderModel(slug: "gemini-4-carbon", name: "Gemini 4 Carbon"),
        ServerProviderModel(slug: "grok-4.7-fast", name: "Grok 4.7 Fast"),
      ]),
      ServerProviderSummary(instanceId: "grok", driver: "grok", models: [
        ServerProviderModel(slug: "grok-4.7-fast", name: "Grok 4.7 Fast"),
      ]),
    ]
    let choices = ModelChoice.available(providers: providers, current: ModelSelection(instanceId: "gemini", model: "gemini-4-carbon"))
    #expect(choices.map(\.name) == ["4 Carbon", "Gemini 3 Carbon", "Gemini 4 Carbon", "Grok 4.7 Fast", "4.7 Fast"])
    let layout = ModelPicker.layout(choices, selectedId: "gemini/gemini-4-carbon")
    #expect(layout.family.map(\.id) == ["gemini/gemini-4-carbon", "copilot/gemini-4-carbon", "copilot/gemini-3-carbon"])
    #expect(layout.familyTitle == "Carbon")
    #expect(ModelPicker.search("latest carbon", in: choices).matches.map(\.id) == ["gemini/gemini-4-carbon", "copilot/gemini-4-carbon"])
    #expect(ModelPicker.identity(of: choices[3]) == ModelPicker.identity(of: choices[4]))
  }

  @Test func aTypoInTheStartOfANameStillFindsIt() {
    #expect(ModelPicker.closestWordDistance("wnd", ["wonder"]) == 1)
    #expect(ModelPicker.closestWordDistance("woxn", ["wonder"]) == 1)
    #expect(ModelPicker.closestWordDistance("snnet", ["sonnet"]) == 1)
    #expect(ModelPicker.closestWordDistance("xyz", ["wonder"]) == nil)
  }

  @Test func anotherMakersModelOfTheSameNameIsAnotherFamily() {
    let choices = [
      Self.choice("gemini", "Gemini CLI", "gemini-3-flash", "3 Flash"),
      Self.choice("copilot", "GitHub Copilot", "gemini-3-flash", "Gemini 3 Flash"),
      Self.choice("opencode", "OpenCode", "flash-9", "Flash 9"),
    ]
    #expect(ModelPicker.layout(choices, selectedId: "gemini/gemini-3-flash").family.map(\.id) == ["gemini/gemini-3-flash", "copilot/gemini-3-flash"])
    #expect(ModelPicker.search("latest gemini flash", in: choices).matches.map(\.id) == ["gemini/gemini-3-flash", "copilot/gemini-3-flash"])
    #expect(ModelPicker.layout(choices, selectedId: "opencode/flash-9").family.map(\.id) == ["opencode/flash-9"])
  }

  @Test func unlistedRowsNameWhatSendUsesAndWhatDroppingThePickGoesBackTo() {
    let opus = ModelSelection(instanceId: "claudeAgent", model: "claude-opus-5-5")
    let codex = ModelSelection(instanceId: "work-codex", model: "gpt-5.5")
    let gemini = Self.choice("gemini", "Gemini CLI", "gemini-3-flash", "3 Flash")
    let thread = ThreadIdentity(provider: "Claude Code", model: "Opus 5.5", providerBrand: "claude")
    let picked = ModelChoice(instanceId: "work-codex", provider: "Work Codex", brand: "openai", slug: "gpt-5.5", name: "GPT-5.5")
    func rows(pick: ModelSelection?, base: ModelSelection?, sent: Bool, choices: [ModelChoice]) -> [ModelPicker.Unlisted] {
      ModelPicker.unlisted(pick: pick, base: base, baseIsThreads: !sent, thread: thread, remembered: picked, in: choices)
    }
    let claude = Self.choice("claudeAgent", "Claude Code", "claude-opus-5-5", "Opus 5.5")
    // Everything listed: nothing to show.
    #expect(rows(pick: gemini.selection, base: opus, sent: false, choices: [claude, gemini]).isEmpty)
    // The thread's own model left the catalog.
    #expect(rows(pick: nil, base: opus, sent: false, choices: [gemini]).map(\.name) == ["Opus 5.5"])
    #expect(rows(pick: nil, base: opus, sent: false, choices: [gemini]).first?.isPicked == true)
    // A queued Codex switch left the catalog under a Gemini pick: dropping the pick goes back to Codex, not Opus.
    let underPick = rows(pick: gemini.selection, base: codex, sent: true, choices: [claude, gemini])
    #expect(underPick.map(\.name) == ["GPT-5.5"])
    #expect(underPick.map(\.provider) == ["Work Codex"])
    #expect(underPick.map(\.brand) == ["openai"])
    #expect(underPick.map(\.isPicked) == [false])
    // The pick and the thread's model both left: the pick is checked, the thread's is the way back.
    let both = rows(pick: codex, base: opus, sent: false, choices: [gemini])
    #expect(both.map(\.id) == [.pick, .base])
    #expect(both.map(\.name) == ["GPT-5.5", "Opus 5.5"])
    #expect(both.map(\.isPicked) == [true, false])
    // An empty catalog still names the pick.
    #expect(rows(pick: codex, base: opus, sent: false, choices: []).first?.provider == "Work Codex")
  }
}
