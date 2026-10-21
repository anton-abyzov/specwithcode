import Foundation
import Testing
import SWCWire
@testable import SWCSync

@MainActor @Suite struct IncrementProgressTests {
  let base = LiveEngineTests()
  let target = ChatTarget.thread(ThreadRef(environmentId: "env-1", threadId: "thr_1"))

  @Test func readsActualProjectAndThreadWithoutMutation() async throws {
    let h = try await base.harness()
    defer { h.engine.setActive(false) }
    #expect(await base.loaded(h))
    let project = try #require(h.engine.machines["env-1"]?.thread("thr_1")?.projectId)
    h.machine.answer("projects.threadIncrementProgressRead", with: "{\"projectId\":\"\(project)\",\"threads\":[]}")
    #expect(try await h.engine.incrementProgress(for: target) == .unbound)
    #expect(h.machine.payloads("projects.threadIncrementProgressRead") == [.object(["projectId": .string(project), "threadIds": .array([.string("thr_1")])])])
    #expect(h.machine.requests("projects.coordinatorStart").isEmpty)
    #expect(h.machine.requests("projects.threadIncrementLink").isEmpty)
  }

  @Test func linkedUnreadableLedgerIsNotAnEmptyPlan() async throws {
    let h = try await base.harness()
    defer { h.engine.setActive(false) }
    #expect(await base.loaded(h))
    let project = try #require(h.engine.machines["env-1"]?.thread("thr_1")?.projectId)
    let entry = FixtureEngine.sampleIncrement.replacingOccurrences(of: "t-release", with: "thr_1")
      .replacingOccurrences(of: "\"readable\":true", with: "\"readable\":false")
    h.machine.answer("projects.threadIncrementProgressRead", with: "{\"projectId\":\"\(project)\",\"threads\":[\(entry)]}")
    guard case let .bound(progress) = try await h.engine.incrementProgress(for: target) else { Issue.record("Lost binding"); return }
    #expect(!progress.readable)
    #expect(progress.boundTaskId == "T-05")
    #expect(progress.verify?.ok == false)
  }

  @Test func coordinatorReadUsesExistingThreadWithoutStartingOne() async throws {
    let h = try await base.harness()
    defer { h.engine.setActive(false) }
    #expect(await base.loaded(h))
    let entry = try #require(h.engine.machines["env-1"])
    let project = try #require(h.model.projects.first?.ref)
    let coordinator = ChatTarget.project(project)
    guard let threadId = h.engine.threadId(for: coordinator, entry: entry) else {
      guard case .unavailable = try await h.engine.incrementProgress(for: coordinator) else { Issue.record("Missing coordinator must remain unavailable"); return }
      #expect(h.machine.requests("projects.coordinatorStart").isEmpty)
      return
    }
    h.machine.answer("projects.threadIncrementProgressRead", with: "{\"projectId\":\"\(project.projectId)\",\"threads\":[]}")
    _ = try await h.engine.incrementProgress(for: coordinator)
    #expect(h.machine.payloads("projects.threadIncrementProgressRead").last?["threadIds"] == .array([.string(threadId)]))
    #expect(h.machine.requests("projects.coordinatorStart").isEmpty)
  }

  @Test func deniedReadDoesNotBecomeUnbound() async throws {
    let h = try await base.harness()
    defer { h.engine.setActive(false) }
    #expect(await base.loaded(h))
    h.machine.fail("projects.threadIncrementProgressRead", with: #"{"_tag":"Error","message":"Project access denied"}"#)
    await #expect(throws: (any Error).self) { try await h.engine.incrementProgress(for: target) }
  }

  @Test func threadLinksKeepExplicitMachineIdentityAndAllowEncodedIDs() throws {
    let model = AppModel(engine: FixtureEngine(scenario: .readability))
    let known = try #require(model.recentThreads.first)
    let origin = known.ref.environmentId
    #expect(try model.threadLink(threadId: known.ref.threadId, environmentId: nil, from: origin) == known.ref)
    let remote = "paired-remote"
    model.machines.append(MachineSummary(id: remote, label: "Remote", status: .connected))
    var copy = known
    let slashRef = ThreadRef(environmentId: remote, threadId: "thread:delegated-task:branch/name")
    copy = ThreadSummary(ref: slashRef, title: "Remote thread", activity: .idle, updatedAt: Date(), machineLabel: "Remote", machineOnline: true)
    model.recentThreads.append(copy)
    #expect(try model.threadLink(threadId: slashRef.threadId, environmentId: remote, from: origin) == slashRef)
    #expect(throws: (any Error).self) { try model.threadLink(threadId: slashRef.threadId, environmentId: nil, from: origin) }
    #expect(throws: (any Error).self) { try model.threadLink(threadId: known.ref.threadId, environmentId: remote, from: origin) }
    #expect(throws: (any Error).self) { try model.threadLink(threadId: slashRef.threadId, environmentId: "unpaired", from: origin) }
    #expect(throws: (any Error).self) { try model.threadLink(threadId: "unknown", environmentId: remote, from: origin) }
  }

  @Test func ledgerAndProviderChecklistRemainDistinct() async throws {
    let engine = FixtureEngine(scenario: .readability)
    let model = AppModel(engine: engine)
    let aide = try #require(model.aide)
    #expect(try await engine.incrementProgress(for: .aide(aide.ref)) == .unbound)
    let release = try #require(model.recentThreads.first { $0.ref.threadId == "t-release" })
    guard case let .bound(progress) = try await engine.incrementProgress(for: .thread(release.ref)) else { Issue.record("Missing sample increment"); return }
    #expect(progress.verify?.ok == false)
    #expect(progress.tasks.last?.status == "blocked")
    #expect(progress.criteria.last?.met == false)
  }
}
