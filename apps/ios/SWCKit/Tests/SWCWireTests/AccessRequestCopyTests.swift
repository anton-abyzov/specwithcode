import Foundation
import Testing
import SWCWire

/// The Swift port of `packages/client-runtime/src/accessRequest.ts` says what the desktop says.
@Suite("Access request copy")
struct AccessRequestCopyTests {
  typealias Name = AccessRequestCopy.SubjectName
  static let app = Name(kind: "app", label: "Notes")
  static let notes = Name(kind: "app", label: "Notes")
  static let maps = Name(kind: "app", label: "Maps")
  static let iphone = Name(kind: "device", label: "iPhone 17 Pro")
  static let pixel = Name(kind: "device", label: "Pixel 9")
  static let folder = Name(kind: "folder", label: "src")
  static let machine = Name(kind: "machine", label: "M1")

  @Test func headlineNamesTheAgentAndWhatItUses() {
    #expect(AccessRequestCopy.headline(agentLabel: "Claude", subjects: [Self.app]) == "Claude wants to use Notes")
    #expect(AccessRequestCopy.headline(agentLabel: "Codex", subjects: [Self.iphone]) == "Codex wants to control iPhone 17 Pro")
    #expect(AccessRequestCopy.headline(agentLabel: "Claude", subjects: [Self.app, Self.notes, Self.maps]) == "Claude wants to use Notes, Notes and Maps")
    #expect(AccessRequestCopy.headline(agentLabel: "Claude", subjects: [Self.notes, Self.iphone, Self.pixel]) == "Claude wants to use Notes and control iPhone 17 Pro and Pixel 9")
  }

  @Test func headlineFallsBackWithoutAnAgentOrSubjects() {
    #expect(AccessRequestCopy.headline(agentLabel: nil, subjects: [Self.app]) == "The agent wants to use Notes")
    #expect(AccessRequestCopy.headline(agentLabel: "  ", subjects: [Self.app]) == "The agent wants to use Notes")
    #expect(AccessRequestCopy.headline(agentLabel: " Claude ", subjects: []) == "Claude wants to use something on your computer")
  }

  @Test func tagIsAll() {
    #expect(AccessRequestCopy.subjectTag(Self.app) == "All")
    #expect(AccessRequestCopy.subjectTag(Self.iphone) == "All")
  }

  @Test func noteSaysWhatAllowLetsTheAgentDo() {
    #expect(AccessRequestCopy.note([Self.app]) == "The agent can see your screen and click and type in these apps while it works.")
    #expect(AccessRequestCopy.note([Self.app, Self.iphone]) == "The agent can see your screen, click and type in these apps, and drive the device.")
    #expect(AccessRequestCopy.note([Self.iphone]) == "The agent can see the device's screen, tap, type and install apps on it.")
    #expect(AccessRequestCopy.note([Self.folder]) == "The agent can read and change files in this folder.")
    #expect(AccessRequestCopy.note([Self.machine]) == "The agent can run work on that machine.")
    #expect(AccessRequestCopy.note([]) == "The agent can see your screen and click and type in these apps while it works.")
  }

  @Test func waitingSubtitleByKind() {
    #expect(AccessRequestCopy.waitingSubtitle([Self.app]) == "Asking to use apps on your computer")
    #expect(AccessRequestCopy.waitingSubtitle([]) == "Asking to use apps on your computer")
    #expect(AccessRequestCopy.waitingSubtitle([Self.iphone]) == "Asking to control a device")
    #expect(AccessRequestCopy.waitingSubtitle([Self.iphone, Self.pixel]) == "Asking to control devices")
    #expect(AccessRequestCopy.waitingSubtitle([Self.folder]) == "Asking to use a folder")
    #expect(AccessRequestCopy.waitingSubtitle([Self.machine]) == "Asking to work on another machine")
    #expect(AccessRequestCopy.waitingSubtitle([Self.app, Self.iphone]) == "Asking to use apps on your computer")
  }

  @Test func waitingSentenceTrimsThePurpose() {
    #expect(AccessRequestCopy.waitingSentence(machineLabel: "M4", reason: "To find what keeps the Mac awake.") == "is waiting for you to allow access to M4, so it can find what keeps the Mac awake.")
    #expect(AccessRequestCopy.waitingSentence(machineLabel: "M4", reason: "in order to Capture screenshots!!") == "is waiting for you to allow access to M4, so it can capture screenshots.")
    #expect(AccessRequestCopy.waitingSentence(machineLabel: "M4", reason: "  ") == "is waiting for you to allow access to M4.")
  }

  @Test func pendingAccessSummaryIsOptional() throws {
    let bare = try decodeJSON(PendingRuntimeRequestSummary.self, #"{"id":"turn-item:access-request:t:k","kind":"permission","createdAt":"2026-11-04T12:00:00.000Z"}"#)
    #expect(bare.access == nil)
    #expect(bare.isAccessRequest)

    let full = try decodeJSON(PendingRuntimeRequestSummary.self, #"""
      {"id":"turn-item:access-request:t:k","kind":"permission","createdAt":"2026-11-04T12:00:00.000Z",
       "access":{"accessTitle":"Use iPhone 17 Pro","reason":"Check the fix","subjects":[{"kind":"device","label":"iPhone 17 Pro","hostLabel":"M1"}]}}
      """#)
    #expect(full.access?.accessTitle == "Use iPhone 17 Pro")
    #expect(full.access?.subjects.first?.hostLabel == "M1")
    #expect(AccessRequestCopy.waitingSubtitle(full.access?.subjects.map(\.copyName) ?? []) == "Asking to control a device")
  }

  @Test func aMalformedAccessSummaryKeepsTheRequest() throws {
    let broken = try decodeJSON(PendingRuntimeRequestSummary.self, #"{"id":"turn-item:access-request:t:k","kind":"permission","createdAt":"2026-11-04T12:00:00.000Z","access":{"subjects":"nope"}}"#)
    #expect(broken.access == nil)
    #expect(broken.isAccessRequest)
  }

  @Test func otherPermissionRequestsAreNotAccessRequests() throws {
    let other = try decodeJSON(PendingRuntimeRequestSummary.self, #"{"id":"req_1","kind":"permission","createdAt":"2026-11-04T12:00:00.000Z"}"#)
    #expect(!other.isAccessRequest)
    let command = PendingRuntimeRequestSummary(id: "turn-item:access-request:x", kind: .command, createdAt: Date())
    #expect(!command.isAccessRequest)
  }
}
