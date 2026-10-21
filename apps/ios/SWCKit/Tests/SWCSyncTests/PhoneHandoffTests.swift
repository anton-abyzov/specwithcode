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
    #expect(session.sendBlockedReason?.contains("handed off") == true)
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
}
