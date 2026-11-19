import Foundation
import Testing
import SWCWire
@testable import SWCSync

@Suite struct MachineIdentityTests {
  private func entry(_ name: String, color: String? = nil, icon: String? = nil) -> MachineNicknameEntry {
    MachineNicknameEntry(name: name, updatedAt: "2026-11-01T00:00:00.000Z", color: color, icon: icon)
  }

  @Test func paletteKeepsTheSharedOrder() {
    #expect(MachineColor.allCases.map(\.rawValue) == ["violet", "teal", "amber", "rose", "blue", "green", "orange", "slate"])
  }

  /// Values from the shared `hashMachineId` (FNV-1a over UTF-16 units).
  @Test func hashMatchesTheSharedFunction() {
    #expect(MachineIdentities.hash("") == 0x811c_9dc5)
    #expect(MachineIdentities.hash("a") == 0xe40c_292c)
    #expect(MachineIdentities.hash("foobar") == 0xbf9c_f968)
  }

  /// Expected values come from running the shared `assignMachineColors` on the same input.
  @Test func colorsMatchTheWebRule() {
    let mixed = MachineIdentities.assignColors(
      ["env-m4", "env-minis", "env-linux-mini", "env-m1", "Env-B", "env-é"],
      entries: ["env-m1": entry("M1", color: "teal"), "env-studio": entry("Studio")]
    )
    #expect(mixed.mapValues(\.rawValue) == ["env-m1": "teal", "env-studio": "amber", "Env-B": "rose", "env-linux-mini": "green", "env-m4": "blue", "env-minis": "orange", "env-é": "slate"])
    let many = MachineIdentities.assignColors((0..<10).map { "m\($0)" }, entries: [:])
    #expect(many.mapValues(\.rawValue) == ["m0": "violet", "m1": "rose", "m2": "orange", "m3": "teal", "m4": "blue", "m5": "slate", "m6": "amber", "m7": "green", "m8": "violet", "m9": "rose"])
  }

  @Test func defaultColorFollowsTheId() {
    let palette = MachineColor.allCases
    for id in ["env-m4", "env-minis", "3f0c2f0e-6c1b-4d5c-9a51-0d2f6f0b8a11"] {
      let expected = palette[Int(MachineIdentities.hash(id) % 8)]
      #expect(MachineIdentities.assignColors([id], entries: [:]) == [id: expected])
    }
  }

  @Test func chosenColorWinsAndIsNeverSharedByADefault() {
    // "a" defaults to the same slot as its own hash; a machine that chose that color keeps it.
    let palette = MachineColor.allCases
    let start = Int(MachineIdentities.hash("a") % 8)
    let colors = MachineIdentities.assignColors(["a"], entries: ["z": entry("Z", color: palette[start].rawValue)])
    #expect(colors["z"] == palette[start])
    #expect(colors["a"] == palette[(start + 1) % 8])
  }

  @Test func namedMachinesSettleBeforeTheDevicesOwn() {
    // Two devices that know different other machines agree on the named one.
    let entries = ["named": entry("M4")]
    let alone = MachineIdentities.assignColors([], entries: entries)["named"]
    let crowded = MachineIdentities.assignColors(["a", "b", "c", "d", "e"], entries: entries)["named"]
    #expect(alone == crowded)
  }

  @Test func noTwoMachinesShareAColorWhileSomeAreLeft() {
    let ids = (0..<8).map { "machine-\($0)" }
    let colors = MachineIdentities.assignColors(ids, entries: [:])
    #expect(Set(colors.values).count == 8)
    // A ninth machine reuses one instead of failing.
    #expect(MachineIdentities.assignColors(ids + ["machine-8"], entries: [:]).count == 9)
  }

  @Test func unknownColorIdFallsBackToTheDefault() {
    let colors = MachineIdentities.assignColors([], entries: ["m": entry("M", color: "magenta")])
    #expect(colors["m"] == MachineColor.allCases[Int(MachineIdentities.hash("m") % 8)])
  }

  @Test func machineFirstSeenHereStillGetsAColor() {
    let identities = MachineIdentities(known: ["a"], entries: [:])
    #expect(identities.colors["stranger"] == nil)
    #expect(identities.color("stranger") == MachineIdentities.assignColors(["a", "stranger"], entries: [:])["stranger"])
    #expect(identities.color("stranger") != identities.color("a"))
  }

  @Test func chosenIconReadsKnownKindsOnly() {
    let identities = MachineIdentities(known: [], entries: ["a": entry("A", icon: "mac-mini"), "b": entry("B", icon: "hologram")])
    #expect(identities.chosenIcon("a") == .macMini)
    #expect(identities.chosenIcon("b") == nil)
    #expect(identities.chosenIcon("c") == nil)
  }

  @Test func mergeKeepsTheNewestEntrysColor() {
    let old = MachineNicknameEntry(name: "M4", updatedAt: "2026-11-01T00:00:00.000Z", color: "teal")
    let new = MachineNicknameEntry(name: "Max", updatedAt: "2026-11-02T00:00:00.000Z", color: "rose", icon: "laptop", short: "MX")
    let merged = MachineNickname.mergeEntries([["m": old], ["m": new]])
    #expect(merged["m"] == new)
    #expect(MachineNickname.merge([["m": new], ["m": old]]) == ["m": "Max"])
  }

  @Test func activityLineSaysUnknownInsteadOfZero() {
    #expect(MachineActivity.line(counted: false, working: 0, projects: 0) == "Chats and projects not counted")
    #expect(MachineActivity.line(counted: true, working: 0, projects: 0) == "Nothing running · 0 projects")
    #expect(MachineActivity.line(counted: true, working: 2, projects: 1) == "2 working · 1 project")
    #expect(MachineActivity.unreachable == "Can’t reach it · retrying")
  }
}
