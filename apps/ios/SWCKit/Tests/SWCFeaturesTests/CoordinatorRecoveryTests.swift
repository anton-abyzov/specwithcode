import Foundation
import Testing
@testable import SWCFeatures
import SWCSync
import SWCWire

@MainActor
@Suite struct CoordinatorRecoveryTests {
  @Test func theContinueBannerReplacesOnlyTheSameMachinesUnreachableLine() {
    let project = ProjectRef(environmentId: "m4", projectId: "p")
    let state = LinkedProjectState(project: project)
    let copy = LinkedProjectResolver.Copy(ref: project, machineLabel: "M4", machineOnline: false,
                                          binding: CoordinatorBinding(epoch: 1, state: .active))
    #expect(state.unreachableLine([copy]) != nil)
    #expect(state.unreachableLine([copy], coveredMachine: "m4") == nil)
    #expect(state.unreachableLine([copy], coveredMachine: "other") != nil)
  }

  @Test func settingsKeepTheProviderIdentityAndRestoreOriginalOptions() {
    let first = ModelChoice(instanceId: "a", provider: "A", slug: "model", name: "Model")
    let other = ModelChoice(instanceId: "b", provider: "B", slug: "model", name: "Model")
    var draft = ProjectSettingsDraft(title: "App", goal: "", instructions: "", paused: false, archived: false, coordinatorModel: "Model", revision: 5)
    draft.savedCoordinatorSelection = first.selection
    draft.coordinatorChoices = [first, other]
    draft.pickCoordinatorModel(other)
    #expect(draft.pickedCoordinatorSelection == other.selection)
    #expect(draft.selectedChoice?.id == other.id)
    draft.pickCoordinatorModel(first)
    #expect(draft.pickedCoordinatorSelection == nil)
  }

  @Test func quotaUsesStructuredResetOrTheLegacyMessage() throws {
    let reset = "2026-11-28T13:59:59.000Z"
    let legacy = "This native subscription profile has no remaining permitted usage. Next observed reset: \(reset). Select an eligible profile for a new session."
    let zone = try #require(TimeZone(identifier: "America/New_York"))
    let locale = Locale(identifier: "en_US")
    let message = CoordinatorRecovery.limitMessage(legacy, limited: false, resetAt: nil, timeZone: zone, locale: locale)
    #expect(message?.contains("8:59") == true)
    #expect(message == CoordinatorRecovery.limitMessage("Exhausted", limited: true, resetAt: reset, timeZone: zone, locale: locale))
    #expect(CoordinatorRecovery.limitMessage("Disconnected", limited: false, resetAt: nil) == nil)
  }

  @Test func continuePreservesBothDraftsAndReportsLastContactOnlyWhenKnown() {
    let router = AppRouter()
    let source = ChatTarget.project(ProjectRef(environmentId: "m1", projectId: "p"))
    let destination = ChatTarget.project(ProjectRef(environmentId: "linux", projectId: "q"))
    router.drafts = [source: "Continue here", destination: "Existing note"]
    router.carryDraft(from: source, to: destination)
    #expect(router.drafts[destination] == "Existing note\n\nContinue here")
    #expect(router.drafts[source] == nil)
    #expect(CoordinatorRecovery.asleep("M1", lastSeen: .now).contains("Last seen"))
    #expect(!CoordinatorRecovery.asleep("M1", lastSeen: nil).contains("Last seen"))
  }
}
