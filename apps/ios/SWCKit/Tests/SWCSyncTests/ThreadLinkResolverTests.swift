import Foundation
import Testing
@testable import SWCSync
import Weave

@Suite struct ThreadLinkResolverTests {
  let m4 = "4d73e481-1b03-4ee8-b4c1-87a448431538"
  let ministorm = "dd2fc230-5af3-44e7-9599-b4b8471cf23c"
  let unpaired = "2cd57c57-eecc-4be4-8e94-b783c2ca0d5c"
  let worker = "thread:delegated-task:command%3Amcp%3Aabc"

  var machines: [ThreadLinkResolver.Machine] {
    [
      .init(environmentId: m4, threads: [
        .init(id: worker, title: "Live Worker", isDeleted: false),
        .init(id: "t-gone", title: "Gone", isDeleted: true),
        .init(id: "t-ci", title: "CI/CD", isDeleted: false),
        .init(id: "t-dup-1", title: "Same", isDeleted: false),
        .init(id: "t-dup-2", title: "Same", isDeleted: false),
      ]),
      .init(environmentId: ministorm, threads: [
        .init(id: "t-remote", title: "Remote Worker", isDeleted: false),
        .init(id: "t-both", title: "Both", isDeleted: false),
      ]),
    ]
  }

  func resolve(_ candidates: [String], env: String? = nil, titles: [String] = [], machines: [ThreadLinkResolver.Machine]? = nil) -> ThreadLinkResolver.Resolution {
    ThreadLinkResolver.resolve(candidates: candidates, environmentId: env, titles: titles, origin: m4, machines: machines ?? self.machines)
  }

  @Test func bareLinkOpensAWorkerTheDrawerHides() {
    #expect(resolve([worker]) == .thread(ThreadRef(environmentId: m4, threadId: worker)))
  }

  @Test func theIdAsWrittenStillMatches() {
    #expect(resolve(["thread:delegated-task:command:mcp:abc", worker]) == .thread(ThreadRef(environmentId: m4, threadId: worker)))
  }

  @Test func namedMachineOpensThere() {
    #expect(resolve(["t-remote"], env: ministorm) == .thread(ThreadRef(environmentId: ministorm, threadId: "t-remote")))
  }

  @Test func namedMachineIsNeverLeft() {
    #expect(resolve([worker], env: ministorm) == .missing)
  }

  @Test func bareLinkFindsAWorkerOnAnotherMachine() {
    #expect(resolve(["t-remote"]) == .thread(ThreadRef(environmentId: ministorm, threadId: "t-remote")))
  }

  @Test func aUniqueTitleOpens() {
    #expect(resolve(["Live Worker"], titles: ["Live Worker"]) == .thread(ThreadRef(environmentId: m4, threadId: worker)))
    #expect(resolve(["Remote Worker"], titles: ["Remote Worker"]) == .thread(ThreadRef(environmentId: ministorm, threadId: "t-remote")))
  }

  @Test func aTitleTwoThreadsShareDoesNot() {
    #expect(resolve(["Same"], titles: ["Same"]) == .missing)
  }

  @Test func aTitleWithASlashIsNotAMachine() {
    #expect(resolve(["CD"], env: "CI", titles: ["CI/CD"]) == .thread(ThreadRef(environmentId: m4, threadId: "t-ci")))
  }

  @Test func deletedAndUnpairedSaySo() {
    #expect(resolve(["t-gone"], titles: ["t-gone"]) == .deleted)
    #expect(resolve(["t-remote"], env: unpaired) == .unpairedMachine)
    #expect(resolve(["nothing"], titles: ["nothing"]) == .missing)
  }

  @Test func anExactRemoteTombstoneOutranksALocalTitle() {
    let lists: [ThreadLinkResolver.Machine] = [
      .init(environmentId: m4, threads: [.init(id: "unrelated", title: "Gone", isDeleted: false)]),
      .init(environmentId: ministorm, threads: [.init(id: "t-gone", title: "Gone", isDeleted: true)]),
    ]
    #expect(resolve(["t-gone"], titles: ["Gone"], machines: lists) == .deleted)
  }

  @Test func aMachineThatHasNotAnsweredOpensTheChatInstead() {
    let loading = [ThreadLinkResolver.Machine(environmentId: m4, threads: nil)]
    #expect(resolve(["t-any"], machines: loading) == .thread(ThreadRef(environmentId: m4, threadId: "t-any")))
    #expect(resolve(["t-any"], env: m4, machines: loading) == .thread(ThreadRef(environmentId: m4, threadId: "t-any")))
  }

  @Test func aSlashTitleNeverFallsBackToItsLastSegment() {
    var lists = machines
    lists[0] = .init(environmentId: m4, threads: [.init(id: "t-cd", title: "CD", isDeleted: false)])
    #expect(resolve(["CD"], env: "CI", titles: ["CI/CD", "CD"], machines: lists) == .missing)
  }

  @Test func aBareLinkWaitsForEveryMachine() {
    let lists: [ThreadLinkResolver.Machine] = [.init(environmentId: m4, threads: []), .init(environmentId: ministorm, threads: nil)]
    #expect(resolve(["t-remote"], machines: lists) == .stillLoading)
  }

  @Test func archivedThreadsOpenAfterTheSecondRead() {
    let live: [ThreadLinkResolver.Machine] = [.init(environmentId: m4, threads: []), .init(environmentId: ministorm, threads: [])]
    #expect(resolve(["t-old"], machines: live) == .missing)
    let merged = ThreadLinkResolver.merging([.init(environmentId: ministorm, threads: [.init(id: "t-old", title: "Old", isDeleted: false)])], into: live)
    #expect(resolve(["t-old"], machines: merged) == .thread(ThreadRef(environmentId: ministorm, threadId: "t-old")))
  }

  @Test func firstLookupWaitsForAnArchiveWhenTheBareOriginIsUnloaded() {
    let live: [ThreadLinkResolver.Machine] = [
      .init(environmentId: m4, threads: nil),
      .init(environmentId: ministorm, threads: [.init(id: "unrelated", title: "t-old", isDeleted: false)]),
    ]
    #expect(ThreadLinkResolver.resolve(candidates: ["t-old"], environmentId: nil, titles: [], origin: m4, machines: live, openUnloadedOrigin: false) == .stillLoading)
    let archived: [ThreadLinkResolver.Machine] = [
      .init(environmentId: ministorm, threads: [.init(id: "t-old", title: "Old", isDeleted: false)]),
    ]
    #expect(resolve(["t-old"], titles: ["t-old"], machines: ThreadLinkResolver.merging(archived, into: live)) == .thread(ThreadRef(environmentId: ministorm, threadId: "t-old")))
  }

  @MainActor @Test func anArchivedExactIdOutranksALiveTitleInAppModel() async throws {
    let tests = LiveEngineTests()
    let harness = try await tests.harness()
    defer { harness.engine.setActive(false) }
    #expect(await tests.loaded(harness))
    let archived = FixtureJSON.threadShell
      .replacingOccurrences(of: "thr_1", with: "Fix login")
      .replacingOccurrences(of: #""title": "Fix login""#, with: #""title": "Archived thread""#)
    harness.machine.answer("orchestration.getArchivedShellSnapshot", with: "{\"threads\":[\(archived)]}")
    let link = try await harness.model.openThreadLink(threadId: "Fix login", environmentId: nil, from: tests.env)
    #expect(link == ThreadRef(environmentId: tests.env, threadId: "Fix login"))
  }

  @Test func aLabelTitleIsTheLastResort() throws {
    let url = try #require(URL(string: "studio://thread/badId"))
    #expect(MarkdownThreadLink.label(of: url, in: "See [Live Worker](studio://thread/badId) now") == "Live Worker")
    #expect(MarkdownThreadLink.label(of: url, in: "No link here") == nil)
    #expect(resolve(["badId"], titles: ["badId", "Live Worker"]) == .thread(ThreadRef(environmentId: m4, threadId: worker)))
  }

  @Test func anArchivedThreadOnAHealthyMachineOutranksAMachineStillLoading() {
    let lists: [ThreadLinkResolver.Machine] = [.init(environmentId: m4, threads: []), .init(environmentId: unpaired, threads: nil)]
    #expect(resolve(["t-old"], machines: lists) == .stillLoading)
    let merged = ThreadLinkResolver.merging([.init(environmentId: m4, threads: [.init(id: "t-old", title: "Old", isDeleted: false)])], into: lists)
    #expect(resolve(["t-old"], machines: merged) == .thread(ThreadRef(environmentId: m4, threadId: "t-old")))
  }
}
