import Testing
@testable import Weave

/// A project without an icon must look the same on the phone as on the desktop.
struct ProjectIdentityTests {
  @Test(arguments: [
    ("Nebula", "NA"), ("Silver Orchard", "SO"), ("Quiet Lantern Workshop", "QW"),
    ("m7forge", "M7"), ("M7 Forge", "M7"), ("X", "XX"), ("---", "PR"),
    ("1164 handoff move check", "HC"), ("1164 handoff", "HF"), ("2048", "20"),
  ])
  func initialsMatchTheDesktop(name: String, expected: String) {
    #expect(ProjectAvatar.identityMonogram(name) == expected)
  }

  @Test(arguments: [
    ("Nebula", "red"), ("Silver Orchard", "sky"), ("specweave", "fuchsia"),
    ("EasyChamp", "violet"), ("sketchmate", "amber"), ("文書", "violet"), ("", "fuchsia"),
  ])
  func colorsMatchTheDesktop(name: String, expected: String) {
    #expect(ProjectAvatar.tintName(for: name) == expected)
  }

  @Test func colorIgnoresCaseAndSurroundingSpace() {
    #expect(ProjectAvatar.tintName(for: "  NEBULA  ") == ProjectAvatar.tintName(for: "Nebula"))
  }

  @Test func initialsNeverExceedTheServerLimit() {
    for name in ["sketchmate-studio", "A very long project name", "文書"] {
      #expect(ProjectAvatar.identityMonogram(name).count <= 2)
    }
  }
}
