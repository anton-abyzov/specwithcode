import Foundation
import Testing
import SWCWire
@testable import SWCSync

@Suite struct TeamRulesInfoTests {
  private let limited = TeamRulesInfo(TeamRulesSummary(owner: "Acme", ceiling: .autoAcceptEdits))

  @Test func aCeilingNarrowsThePicker() {
    #expect(limited.allowedModes == [.approvalRequired, .autoAcceptEdits])
    #expect(limited.clamped(.fullAccess) == .autoAcceptEdits)
    #expect(limited.clamped(.approvalRequired) == .approvalRequired)
    #expect(limited.limitsModes)
    #expect(limited.setByLabel == "Set by Acme")
  }

  @Test func fullAccessAsACeilingLimitsNothing() {
    let open = TeamRulesInfo(TeamRulesSummary(owner: "Acme", ceiling: .fullAccess))
    #expect(!open.limitsModes)
    #expect(open.allowedModes == RuntimeModeChoice.allCases)
  }

  @Test func anUnknownModeFromANewerServerLocksNothingHere() {
    let future = TeamRulesInfo(TeamRulesSummary(ceiling: RuntimeMode(rawValue: "brand-new")))
    #expect(future.ceiling == nil)
    #expect(future.allowedModes == RuntimeModeChoice.allCases)
    #expect(future.setByLabel == "Set by your team")
  }

  @Test func rowsListOnlyWhatTheRulesLimit() {
    let info = TeamRulesInfo(TeamRulesSummary(
      owner: "Acme",
      ceiling: .auto,
      providers: [],
      reach: .init(phones: false, connect: true, machines: "same-rules"),
      tools: .init(chrome: false, google: true)
    ))
    #expect(info.rows.map(\.title) == ["Broadest permission", "Approved providers", "Phones", "Other machines", "Agent use of Chrome"])
    #expect(info.rows.map(\.value) == ["Auto", "None", "Off", "Same rules only", "Off"])
  }

  @Test func aHoldNamesNoLimits() {
    let hold = TeamRulesInfo(TeamRulesSummary(status: "hold", ceiling: .auto, issues: ["bad"]))
    #expect(hold.isHold)
    #expect(hold.ceiling == nil)
    #expect(hold.rows.isEmpty)
  }

  private let ref = ThreadRef(environmentId: "e", threadId: "t")

  @Test func noRulesNoNotice() {
    #expect(ChatTeamRulesNotice.make(rules: nil, carried: nil, mode: .fullAccess, thread: ref) == nil)
  }

  @Test func withinTheLimitNoNotice() {
    #expect(ChatTeamRulesNotice.make(rules: limited, carried: nil, mode: .autoAcceptEdits, thread: ref) == nil)
  }

  @Test func aboveTheLimitOffersTheWayDown() throws {
    let notice = try #require(ChatTeamRulesNotice.make(rules: limited, carried: nil, mode: .fullAccess, thread: ref))
    #expect(notice.message == "Set by Acme. This thread uses Full access.")
    #expect(notice.switchTo == .autoAcceptEdits)
    #expect(notice.switchTitle == "Switch to Accept edits")
    #expect(notice.thread == ref)
  }

  @Test func aCarriedCeilingAppliesWithNoRulesHere() throws {
    let carried = TeamRulesCarried(ceiling: .approvalRequired, owner: "Globex")
    let notice = try #require(ChatTeamRulesNotice.make(rules: nil, carried: carried, mode: .auto, thread: ref))
    #expect(notice.message == "Set by Globex, on the machine this work came from. This thread uses Auto.")
    #expect(notice.switchTo == .approvalRequired)
    #expect(ChatTeamRulesNotice.make(rules: nil, carried: carried, mode: .approvalRequired, thread: ref) == nil)
  }

  @Test func theStricterOfOwnAndCarriedWins() throws {
    let loose = TeamRulesCarried(ceiling: .auto, owner: "Globex")
    let own = try #require(ChatTeamRulesNotice.make(rules: limited, carried: loose, mode: .fullAccess, thread: ref))
    #expect(own.switchTo == .autoAcceptEdits)
    #expect(own.message.hasPrefix("Set by Acme."))

    let strict = TeamRulesCarried(ceiling: .approvalRequired, owner: "Globex")
    let brought = try #require(ChatTeamRulesNotice.make(rules: limited, carried: strict, mode: .fullAccess, thread: ref))
    #expect(brought.switchTo == .approvalRequired)
    #expect(brought.message.hasPrefix("Set by Globex"))
  }

  @Test func aHoldSaysWhyAndOffersNoSwitch() throws {
    let hold = TeamRulesInfo(TeamRulesSummary(status: "hold", contact: "it@acme.example", issues: ["agents.ceiling is wrong."]))
    let notice = try #require(ChatTeamRulesNotice.make(rules: hold, carried: nil, mode: .fullAccess, thread: ref))
    #expect(notice.message == "agents.ceiling is wrong. Fixing the file resumes agents without a restart. See it@acme.example.")
    #expect(notice.switchTo == nil)
  }

  @Test func aPhoneWaitingForItsCodeSaysWhereToTypeIt() {
    var machine = MachineSummary(id: "e", label: "m4", status: .reconnecting)
    machine.deviceApprovalCode = "K7QX2M"
    #expect(machine.recoveryTitle == "Waiting for approval on m4")
    #expect(machine.recoveryMessage.hasPrefix("Open SpecWithCode on m4 and type this code: K7QX2M."))
    #expect(machine.canRetryConnection)
  }

  /// The chat's waiting view, composer and banner all say the same thing (1408).
  @Test func theApprovalWaitSaysOneThingEverywhere() {
    var machine = MachineSummary(id: "e", label: "m1", status: .offline)
    machine.deviceApprovalCode = "6X9SF6"
    #expect(machine.approvalTitle == "Allow this phone on m1")
    #expect(machine.approvalInstruction == "Open SpecWithCode on m1 and type this code:")
    #expect(machine.approvalProgress == "Connects on its own once m1 allows it.")
    #expect(machine.approvalComposerLine == "Waiting for m1 to allow this phone. Your draft is kept.")
    #expect(machine.approvalBanner(code: "6X9SF6") == "Waiting for approval. Type 6X9SF6 on m1.")
    for line in [machine.approvalTitle, machine.approvalProgress, machine.approvalComposerLine] {
      #expect(!line.contains("unavailable") && !line.contains("offline"))
    }
  }

  @Test func aRefusalReadsAsRulesNotAnExpiredPairing() {
    var machine = MachineSummary(id: "e", label: "Mac", status: .reconnecting)
    machine.teamRulesRefusal = "Acme's rules turn off phones on this machine."
    #expect(machine.recoveryTitle == "Turned off by team rules")
    #expect(machine.recoveryMessage.hasPrefix("Acme's rules turn off phones on this machine."))
    #expect(machine.canRetryConnection)
  }
}
