import Foundation
import Testing
import SWCWire
import SWCTransport
@testable import SWCSync

@MainActor @Suite struct PhoneHandoffTests {
  let base = LiveEngineTests()
  let ref = ThreadRef(environmentId: "env-1", threadId: "thr_1")
  let destination = HandoffDestination(id: "env-2", name: "Minis", usesReplica: false)

  func addDestination(_ h: LiveEngineTests.Harness) async throws -> FakeMachine {
    let source = try #require(h.engine.machines["env-1"])
    let machine = FakeMachine()
    let socket = RpcSocket(connection: ScriptedConnection(responder: machine.respond))
    await socket.start()
    let entry = MachineEntry(record: MachineRecord(environmentId: "env-2", label: "Minis", routes: []), connection: source.connection)
    entry.socket = socket
    entry.status = .init(state: .connected)
    entry.permissions = ["orchestration:read", "orchestration:operate"]
    h.engine.machines["env-2"] = entry
    return machine
  }

  @Test func preflightFailureNeverMoves() async throws {
    let h = try await base.harness()
    defer { h.engine.setActive(false) }
    #expect(await base.loaded(h))
    _ = try await addDestination(h)
    h.machine.answer("handoffMode.preflight", with: #"[{"threadId":"thr_1","ok":false,"failures":[{"message":"Minis: missing project grant"}],"resume":false}]"#)
    let check = try await h.engine.checkHandoff(ref, destination: destination)
    #expect(!check.allowed)
    #expect(check.messages == ["Minis: missing project grant"])
    await #expect(throws: (any Error).self) { try await h.engine.continueThread(ref, destination: destination) }
    #expect(h.machine.requests("handoffMode.handOff").isEmpty)
  }

  @Test func successfulMoveUsesExactContractAndReturnedThread() async throws {
    let h = try await base.harness()
    defer { h.engine.setActive(false) }
    #expect(await base.loaded(h))
    _ = try await addDestination(h)
    h.machine.answer("handoffMode.preflight", with: #"[{"threadId":"thr_1","ok":true,"failures":[],"resume":true}]"#)
    h.machine.answer("handoffMode.handOff", with: #"{"environmentId":"env-2","threadId":"continued"}"#)
    h.machine.answer("handoffMode.snapshot", with: #"{"threads":[{"threadId":"thr_1","continuedOn":{"environmentId":"env-2","threadId":"continued"}}],"incoming":[]}"#)
    let next = try await h.engine.continueThread(ref, destination: destination)
    #expect(next.threadId == "continued")
    #expect(h.machine.payloads("handoffMode.handOff") == [.object(["threadId": .string("thr_1"), "destinationEnvironmentId": .string("env-2")])])
    #expect(h.machine.requests("handoffMode.preflight").count == 1)
  }

  @Test func savedReplicaUsesDestinationAndPreservesLeaseRefusal() async throws {
    let h = try await base.harness()
    defer { h.engine.setActive(false) }
    #expect(await base.loaded(h))
    let remote = try await addDestination(h)
    h.engine.machines["env-1"]?.status = .init(state: .offline)
    remote.answer("handoffMode.snapshot", with: #"{"threads":[],"incoming":[{"sourceEnvironmentId":"env-1","sourceThreadId":"thr_1","continuedThreadId":null}]}"#)
    remote.fail("handoffMode.continueHere", with: #"{"_tag":"HandoffModeError","code":"busy","message":"Source lease is still fresh."}"#)
    let offline = ref
    let options = try await h.engine.handoffOptions(for: offline)
    #expect(options.destinations.map(\.id) == ["env-2"])
    #expect(options.destinations.first?.usesReplica == true)
    let target = HandoffDestination(id: "env-2", name: "Minis", usesReplica: true)
    do {
      _ = try await h.engine.continueThread(offline, destination: target)
      Issue.record("A fresh source lease must prevent continuation")
    } catch { #expect(error.localizedDescription.contains("Source lease is still fresh.")) }
    #expect(remote.payloads("handoffMode.continueHere") == [.object(["sourceEnvironmentId": .string("env-1"), "sourceThreadId": .string("thr_1")])])
    #expect(h.machine.requests("handoffMode.handOff").isEmpty)
    #expect(remote.requests("handoffMode.continueHere").count == 1)
  }

  @Test func fencedCopyBlocksComposerAndDispatch() async throws {
    let h = try await base.harness()
    defer { h.engine.setActive(false) }
    #expect(await base.loaded(h))
    let entry = try #require(h.engine.machines[ref.environmentId])
    entry.snapshot?.threads[0].executionState = .fenced
    let session = h.model.session(for: .thread(ref))
    h.engine.open(session)
    #expect(session.sendBlockedReason?.contains("not confirmed") == true)
    await #expect(throws: (any Error).self) { try await h.engine.send("do not send", to: .thread(ref)) }
    #expect(h.machine.payloads("orchestration.dispatchCommand").allSatisfy { $0["type"] != .string("message.dispatch") })
  }

  @Test func openingHandoffOnlyReadsSnapshot() async throws {
    let h = try await base.harness()
    defer { h.engine.setActive(false) }
    #expect(await base.loaded(h))
    h.machine.answer("handoffMode.snapshot", with: #"{"threads":[{"threadId":"thr_1","badge":"ready"}],"incoming":[]}"#)
    let options = try await h.engine.handoffOptions(for: ref)
    #expect(options.badge == "ready")
    #expect(h.machine.requests("handoffMode.preflight").isEmpty)
    #expect(h.machine.requests("handoffMode.handOff").isEmpty)
    #expect(h.machine.requests("handoffMode.continueHere").isEmpty)
  }
  @Test func unlinkedAndOfflineMachinesExplainUnavailableChoices() async throws {
    let h = try await base.harness()
    defer { h.engine.setActive(false) }
    #expect(await base.loaded(h))
    _ = try await addDestination(h)
    h.machine.answer("handoffMode.snapshot", with: #"{"threads":[],"incoming":[]}"#)
    let unlinked = try await h.engine.handoffOptions(for: ref)
    #expect(unlinked.destinations.isEmpty)
    #expect(unlinked.notices.contains { $0.contains("not linked") })
    h.engine.machines["env-2"]?.status = .init(state: .offline)
    let offline = try await h.engine.handoffOptions(for: ref)
    #expect(offline.notices.contains { $0.contains("offline or unreachable") })
    #expect(h.machine.requests("handoffMode.preflight").isEmpty)
  }

  @Test func completedTurnPreflightSaysMoveWithoutRestart() async throws {
    let h = try await base.harness()
    defer { h.engine.setActive(false) }
    #expect(await base.loaded(h))
    _ = try await addDestination(h)
    h.machine.answer("handoffMode.preflight", with: #"[{"threadId":"thr_1","ok":true,"failures":[],"resume":false}]"#)
    let check = try await h.engine.checkHandoff(ref, destination: destination)
    #expect(check.allowed)
    #expect(check.messages.first?.contains("without starting a new turn") == true)
  }

  @Test func fixtureContinuationExistsAndSourceCannotSend() async throws {
    let engine = FixtureEngine(scenario: .fleet)
    engine.latency = .zero
    let model = AppModel(engine: engine)
    engine.start(model: model)
    let source = ThreadRef(environmentId: "env-m4", threadId: "f-phone")
    let session = model.session(for: .thread(source))
    engine.open(session)
    let sourceRows = session.rows.count
    let target = try #require(try await engine.handoffOptions(for: source).destinations.first)
    let next = try await engine.continueThread(source, destination: target)
    #expect(next.threadId != source.threadId)
    #expect(model.thread(next)?.machineLabel == "Minis")
    let continued = model.session(for: .thread(next))
    engine.open(continued)
    #expect(continued.rows.count == sourceRows + 1)
    #expect(continued.machineLabel == "Minis")
    #expect(continued.rows.allSatisfy { if case .approval = $0.kind { return false }; return true })
    #expect(session.sendBlockedReason?.contains("handed off") == true)
    await #expect(throws: (any Error).self) { try await engine.send("must not run", to: .thread(source)) }
    #expect(try await engine.continueThread(source, destination: target) == next)
  }

  @Test func unreachableMoveRemainsInDoubtAndRefreshNeverRetries() async throws {
    let h = try await base.harness()
    defer { h.engine.setActive(false) }
    #expect(await base.loaded(h))
    _ = try await addDestination(h)
    h.machine.answer("handoffMode.preflight", with: #"[{"threadId":"thr_1","ok":true,"failures":[],"resume":false}]"#)
    h.machine.fail("handoffMode.handOff", with: #"{"_tag":"HandoffModeError","code":"unreachable","message":"Minis did not answer…"}"#)
    do {
      _ = try await h.engine.continueThread(ref, destination: destination)
      Issue.record("An unreachable transfer must not report completion")
    } catch {
      #expect(error is HandoffUncertain)
      #expect(error.localizedDescription.contains("Minis did not answer…"))
    }
    h.machine.answer("handoffMode.snapshot", with: #"{"threads":[{"threadId":"thr_1","badge":"handing-off","lastError":"Minis did not answer…"}],"incoming":[]}"#)
    let status = try await h.engine.handoffOptions(for: ref)
    #expect(status.badge == "handing-off")
    #expect(status.destinations.isEmpty)
    #expect(status.notices.contains("Minis did not answer…"))
    h.engine.machines["env-1"]?.status = .init(state: .offline)
    let reopened = try await h.engine.handoffOptions(for: ref)
    #expect(reopened.destinations.isEmpty)
    await #expect(throws: HandoffUncertain.self) { try await h.engine.continueThread(ref, destination: destination) }
    #expect(h.machine.requests("handoffMode.handOff").count == 1)
  }

  @Test func returnedDestinationWithoutSourceConfirmationIsNotSuccess() async throws {
    let h = try await base.harness()
    defer { h.engine.setActive(false) }
    #expect(await base.loaded(h))
    _ = try await addDestination(h)
    h.machine.answer("handoffMode.preflight", with: #"[{"threadId":"thr_1","ok":true,"failures":[],"resume":false}]"#)
    h.machine.answer("handoffMode.handOff", with: #"{"environmentId":"env-2","threadId":"continued"}"#)
    h.machine.answer("handoffMode.snapshot", with: #"{"threads":[{"threadId":"thr_1","badge":"handing-off"}],"incoming":[]}"#)
    await #expect(throws: HandoffUncertain.self) { try await h.engine.continueThread(ref, destination: destination) }
    #expect(h.machine.requests("handoffMode.handOff").count == 1)
  }

  @Test func uncertaintySurvivesJournalRecreation() throws {
    let suite = "handoff-test-" + UUID().uuidString
    let defaults = try #require(UserDefaults(suiteName: suite))
    defer { defaults.removePersistentDomain(forName: suite) }
    let first = HandoffJournal(defaults: defaults)
    first[ref] = "Minis did not answer…"
    let reopened = HandoffJournal(defaults: defaults)
    #expect(reopened[ref] == "Minis did not answer…")
    reopened[ref] = nil
    #expect(HandoffJournal(defaults: defaults)[ref] == nil)
  }

}
