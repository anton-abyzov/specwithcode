import Testing
@testable import SWCFeatures
import SWCSync

@MainActor
@Suite("Message picture viewer")
struct AttachmentViewerTests {
  @Test func zoomStaysInRange() {
    #expect(ImageZoom.clamped(0.2) == 1)
    #expect(ImageZoom.clamped(3) == 3)
    #expect(ImageZoom.clamped(40) == 5)
  }

  @Test func doubleTapZoomsInThenBackOut() {
    #expect(ImageZoom.afterDoubleTap(from: 1) == 2.5)
    #expect(ImageZoom.afterDoubleTap(from: 2.5) == 1)
    #expect(ImageZoom.afterDoubleTap(from: 4) == 1)
  }
}

@MainActor
@Suite("Thread subtitle")
struct ThreadSubtitleTests {
  @Test func aideThreadNamesItsMachine() {
    #expect(ChatSession.threadSubtitle("Aide", machine: "m1", isPersonal: true) == "Aide · m1")
  }

  @Test func aideThreadWithoutAKnownMachineStaysPlain() {
    #expect(ChatSession.threadSubtitle("Aide", machine: "", isPersonal: true) == "Aide")
  }

  @Test func projectThreadIsUnchanged() {
    #expect(ChatSession.threadSubtitle("SpecWeave", machine: "m1", isPersonal: false) == "SpecWeave")
  }
}
