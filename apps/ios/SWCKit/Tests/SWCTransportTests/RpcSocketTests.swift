import Foundation
import SWCWire
import Testing
@testable import SWCTransport

@Suite struct RpcSocketTests {
  func makeSocket(_ connection: ScriptedConnection, _ configuration: RpcSocket.Configuration = .init()) async -> RpcSocket {
    let socket = RpcSocket(connection: connection, configuration: configuration)
    await socket.start()
    return socket
  }

  func requestIds(_ connection: ScriptedConnection) -> [Int] {
    connection.sentFrames(tag: "Request").compactMap { $0["id"]?.intValue }
  }

  @Test func idsCountFromOneAndAnswersFindTheirCall() async throws {
    let connection = ScriptedConnection(responder: ScriptedConnection.pongs)
    let socket = await makeSocket(connection)
    async let first = socket.call(tag: "server.probe")
    async let second = socket.call(tag: "server.getConfig", payload: .object(["x": .number(1)]))
    #expect(await eventually { requestIds(connection).count == 2 })
    #expect(Set(requestIds(connection)) == [1, 2])

    let frames = connection.sentFrames(tag: "Request")
    let probe = try #require(frames.first { $0["tag"]?.stringValue == "server.probe" })
    let probeId = try #require(probe["id"]?.intValue)
    #expect(probe == .object(["_tag": .string("Request"), "id": .number(Double(probeId)), "tag": .string("server.probe"), "payload": .object([:]), "headers": .array([])]))
    let configId = 3 - probeId

    connection.push(#"{"_tag":"Exit","requestId":\#(configId),"exit":{"_tag":"Success","value":{"config":true}}}"#)
    connection.push(#"{"_tag":"Exit","requestId":"\#(probeId)","exit":{"_tag":"Success","value":{}}}"#)
    #expect(try await first == .object([:]))
    #expect(try await second == .object(["config": .bool(true)]))

    async let third = socket.call(tag: "server.probe")
    #expect(await eventually { requestIds(connection).contains(3) })
    connection.push(#"{"_tag":"Exit","requestId":3,"exit":{"_tag":"Success","value":null}}"#)
    #expect(try await third == .null)
    await socket.close()
  }

  @Test func ackGoesOutOnlyWhenTheConsumerAcks() async throws {
    let connection = ScriptedConnection(responder: ScriptedConnection.pongs)
    let socket = await makeSocket(connection)
    let stream = await socket.stream(tag: "orchestration.subscribeShell", payload: .object(["requestCompletionMarker": .bool(true)]))
    #expect(await eventually { requestIds(connection) == [1] })
    #expect(connection.sentFrames(tag: "Request").first?["payload"] == .object(["requestCompletionMarker": .bool(true)]))

    connection.push(#"{"_tag":"Chunk","requestId":1,"values":[{"kind":"snapshot","snapshot":{"schemaVersion":2,"snapshotSequence":0,"threads":[],"archivedThreads":[],"projects":[]}}]}"#)
    var iterator = stream.makeAsyncIterator()
    let chunk = try #require(try await iterator.next())
    #expect(chunk.requestId == 1)
    #expect(chunk.values.first?["kind"] == .string("snapshot"))

    try await Task.sleep(for: .milliseconds(100))
    #expect(connection.sentFrames(tag: "Ack").isEmpty)

    chunk.ack()
    chunk.ack()
    #expect(await eventually { connection.sentFrames(tag: "Ack").count == 1 })
    #expect(connection.sentFrames(tag: "Ack") == [.object(["_tag": .string("Ack"), "requestId": .number(1)])])

    connection.push(#"{"_tag":"Chunk","requestId":1,"values":[{"kind":"synchronized"}]}"#)
    let second = try #require(try await iterator.next())
    #expect(second.values == [.object(["kind": .string("synchronized")])])
    try await Task.sleep(for: .milliseconds(50))
    #expect(connection.sentFrames(tag: "Ack").count == 1)
    second.ack()
    #expect(await eventually { connection.sentFrames(tag: "Ack").count == 2 })

    connection.push(#"{"_tag":"Exit","requestId":1,"exit":{"_tag":"Success","value":null}}"#)
    #expect(try await iterator.next() == nil)
    #expect(connection.sentFrames(tag: "Interrupt").isEmpty)
    await socket.close()
  }

  @Test func cancellingACallSendsInterrupt() async throws {
    let connection = ScriptedConnection(responder: ScriptedConnection.pongs)
    let socket = await makeSocket(connection)
    let task = Task { try await socket.call(tag: "orchestration.dispatchCommand") }
    #expect(await eventually { requestIds(connection) == [1] })
    task.cancel()
    await #expect(throws: CancellationError.self) { try await task.value }
    #expect(await eventually { connection.sentFrames(tag: "Interrupt") == [.object(["_tag": .string("Interrupt"), "requestId": .number(1)])] })

    // The server's interrupt exit arrives later and is ignored.
    connection.push(#"{"_tag":"Exit","requestId":1,"exit":{"_tag":"Failure","cause":[{"_tag":"Interrupt","fiberId":7471}]}}"#)
    #expect(await socket.isClosed == false)
    await socket.close()
  }

  @Test func endingAStreamEarlySendsInterrupt() async throws {
    let connection = ScriptedConnection(responder: ScriptedConnection.pongs)
    let socket = await makeSocket(connection)
    let stream = await socket.stream(tag: "orchestration.subscribeThread", payload: .object(["threadId": .string("t1")]))
    let consumer = Task {
      var count = 0
      for try await chunk in stream {
        count += 1
        chunk.ack()
      }
      return count
    }
    connection.push(#"{"_tag":"Chunk","requestId":1,"values":[{"kind":"synchronized"}]}"#)
    #expect(await eventually { connection.sentFrames(tag: "Ack").count == 1 })
    consumer.cancel()
    #expect(await eventually { connection.sentFrames(tag: "Interrupt").count == 1 })
    #expect(connection.sentFrames(tag: "Interrupt").first?["requestId"] == .number(1))
    _ = try? await consumer.value
    await socket.close()
  }

  @Test func streamFailsWithTypedError() async throws {
    let connection = ScriptedConnection(responder: ScriptedConnection.pongs)
    let socket = await makeSocket(connection)
    let stream = await socket.stream(tag: "orchestration.subscribeShell")
    // Captured with a token narrowed to terminal:read.
    connection.push(#"{"_tag":"Exit","requestId":1,"exit":{"_tag":"Failure","cause":[{"_tag":"Fail","error":{"_tag":"EnvironmentAuthorizationError","message":"The authenticated token is missing required scope: orchestration:read.","requiredScope":"orchestration:read","requiredPermission":"orchestration:read"}}]}}"#)
    do {
      for try await _ in stream {}
      Issue.record("Expected a failure")
    } catch let error as ServerError {
      #expect(error.kind == .authorization(requiredScope: "orchestration:read"))
      #expect(error.message == "The authenticated token is missing required scope: orchestration:read.")
    }
    await socket.close()
  }

  @Test func typedFailuresDecode() async throws {
    let connection = ScriptedConnection(responder: ScriptedConnection.pongs)
    let socket = await makeSocket(connection)

    async let workspace = socket.call(tag: "projects.coordinatorSend")
    #expect(await eventually { requestIds(connection).count == 1 })
    connection.push(#"{"_tag":"Exit","requestId":1,"exit":{"_tag":"Failure","cause":[{"_tag":"Fail","error":{"_tag":"ProjectWorkspaceError","code":"busy"}}]}}"#)
    do {
      _ = try await workspace
      Issue.record("Expected ProjectWorkspaceError")
    } catch let error as ServerError {
      #expect(error.kind == .projectWorkspace(code: "busy"))
      #expect(error.message == "The coordinator is busy. Try again in a moment.")
    }

    async let dispatch = socket.call(tag: "orchestration.dispatchCommand")
    #expect(await eventually { requestIds(connection).count == 2 })
    connection.push(#"{"_tag":"Exit","requestId":2,"exit":{"_tag":"Failure","cause":[{"_tag":"Fail","error":{"_tag":"OrchestrationV2DispatchCommandError","commandId":"c1","commandType":"message.dispatch","message":"Thread is archived."}}]}}"#)
    do {
      _ = try await dispatch
      Issue.record("Expected a dispatch error")
    } catch let error as ServerError {
      #expect(error.kind == .dispatch(commandType: "message.dispatch"))
      #expect(error.message == "Thread is archived.")
    }

    async let unknown = socket.call(tag: "no.such.method")
    #expect(await eventually { requestIds(connection).count == 3 })
    connection.push(#"{"_tag":"Exit","requestId":3,"exit":{"_tag":"Failure","cause":[{"_tag":"Die","defect":"Unknown request tag: no.such.method"}]}}"#)
    do {
      _ = try await unknown
      Issue.record("Expected a defect")
    } catch let error as ServerError {
      #expect(error.kind == .defect)
      #expect(error.message == "Unknown request tag: no.such.method")
    }
    await socket.close()
  }

  @Test func missedPongsCloseTheSocket() async throws {
    let connection = ScriptedConnection()
    let socket = await makeSocket(connection, .init(pingInterval: .milliseconds(20), maxMissedPongs: 3))
    let pendingCall = Task { try await socket.call(tag: "server.probe") }
    let reason = await socket.waitUntilClosed()
    #expect(reason == .pingTimeout)
    #expect(connection.isClosed)
    #expect(connection.sentFrames(tag: "Ping").count == 3)
    await #expect(throws: TransportError.closed) { try await pendingCall.value }
  }

  @Test func pongsKeepTheSocketOpen() async throws {
    let connection = ScriptedConnection(responder: ScriptedConnection.pongs)
    let socket = await makeSocket(connection, .init(pingInterval: .milliseconds(25), maxMissedPongs: 3))
    try await Task.sleep(for: .milliseconds(400))
    #expect(await socket.isClosed == false)
    #expect(connection.sentFrames(tag: "Ping").count >= 4)
    #expect(connection.sentFrames(tag: "Ping").first == .object(["_tag": .string("Ping")]))
    await socket.close()
  }

  @Test func defectsAndUnknownFramesKeepTheSocket() async throws {
    let connection = ScriptedConnection(responder: ScriptedConnection.pongs)
    let socket = await makeSocket(connection)
    connection.push(#"{"_tag":"Defect","defect":{"name":"SyntaxError","message":"Expected property name or '}' in JSON at position 1 (line 1 column 2)"}}"#)
    connection.push(#"{"_tag":"Defect","defect":"Invalid request id: null"}"#)
    connection.push(#"{"_tag":"Bogus"}"#)
    connection.push("{not json")
    connection.push(#"{"_tag":"Chunk","requestId":99,"values":[1]}"#)
    #expect(await eventually { await socket.defectCount == 2 })

    async let probe = socket.call(tag: "server.probe")
    #expect(await eventually { requestIds(connection) == [1] })
    connection.push(#"[{"_tag":"Pong"},{"_tag":"Exit","requestId":1,"exit":{"_tag":"Success","value":{}}}]"#)
    #expect(try await probe == .object([:]))
    #expect(await socket.isClosed == false)
    await socket.close()
  }

  @Test func closeFailsPendingWork() async throws {
    let connection = ScriptedConnection(responder: ScriptedConnection.pongs)
    let socket = await makeSocket(connection)
    let call = Task { try await socket.call(tag: "server.getConfig") }
    let stream = await socket.stream(tag: "orchestration.subscribeShell")
    #expect(await eventually { requestIds(connection).count == 2 })
    await socket.close()
    await #expect(throws: TransportError.closed) { try await call.value }
    await #expect(throws: TransportError.closed) { for try await _ in stream {} }
    #expect(connection.isClosed)
    #expect(await socket.waitUntilClosed() == .requested)
    await #expect(throws: TransportError.closed) { try await socket.call(tag: "server.probe") }
    await #expect(throws: TransportError.closed) { for try await _ in await socket.stream(tag: "x") {} }
  }

  @Test func droppedConnectionClosesTheSocket() async throws {
    let connection = ScriptedConnection(responder: ScriptedConnection.pongs)
    let socket = await makeSocket(connection)
    let call = Task { try await socket.call(tag: "server.getConfig") }
    #expect(await eventually { requestIds(connection).count == 1 })
    connection.close()
    let reason = await socket.waitUntilClosed()
    guard case .connectionLost = reason else {
      Issue.record("Expected connectionLost, got \(String(describing: reason))")
      return
    }
    await #expect(throws: TransportError.closed) { try await call.value }
  }

  @Test func unansweredCallTimesOut() async throws {
    let connection = ScriptedConnection(responder: ScriptedConnection.pongs)
    let socket = await makeSocket(connection, .init(callTimeout: .milliseconds(50)))
    await #expect(throws: TransportError.timedOut) { try await socket.call(tag: "orchestration.dispatchCommand") }
    #expect(await eventually { connection.sentFrames(tag: "Interrupt").count == 1 })
    #expect(await socket.isClosed == false)
    await socket.close()
  }

  @Test func waitingForCloseCanBeCancelled() async throws {
    let connection = ScriptedConnection(responder: ScriptedConnection.pongs)
    let socket = await makeSocket(connection)
    let waiter = Task { await socket.waitUntilClosed() }
    try await Task.sleep(for: .milliseconds(20))
    waiter.cancel()
    #expect(await waiter.value == nil)
    #expect(await socket.isClosed == false)
    await socket.close()
  }
}
