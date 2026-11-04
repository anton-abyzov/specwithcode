import Foundation
import Testing
import SWCWire

@Suite("AccessRequest wire")
struct AccessRequestWireTests {
  func accessItem() throws -> TurnItem {
    let items = try Fixture.decode([TurnItem].self, "turnItems.json")
    return try #require(items.first { $0.id == "ti_access" })
  }

  @Test func accessRequestDecodesFromTheFixture() throws {
    let item = try accessItem()
    #expect(item.type == "access_request")
    #expect(!item.isUnknown)
    guard case let .accessRequest(request) = item.content else {
      Issue.record("Expected an access request, got \(item.type)")
      return
    }
    #expect(request.accessTitle == "Use Activity Monitor and iPhone 17 Pro")
    #expect(request.reason.hasPrefix("To see what keeps"))
    #expect(request.accessStatus == .pending)
    #expect(request.isPending)
    #expect(request.accessScope == nil)
    #expect(request.subjects.count == 2)

    let app = request.subjects[0]
    #expect(app.kind == .app)
    #expect(app.key == "app:activity monitor")
    #expect(app.label == "Activity Monitor")
    #expect(app.detail == "See and control its windows")
    #expect(app.hostLabel == nil)
    #expect(app.icon?.mimeType == "image/png")
    let png = try #require(app.icon?.pngData)
    #expect(png.prefix(4) == Data([0x89, 0x50, 0x4E, 0x47]))

    let phone = request.subjects[1]
    #expect(phone.kind == .device)
    #expect(phone.platform == "ios")
    #expect(phone.hostLabel == "M1")
    #expect(phone.icon == nil)
  }

  @Test func accessRequestIsAKnownType() {
    #expect(TurnItem.knownTypes.contains("access_request"))
  }

  @Test func accessRequestAnsweredStatesDecode() throws {
    let json = { (status: String, scope: String?) in
      """
      {"id":"ti_a","threadId":"thr_1","ordinal":1,"status":"completed","updatedAt":"2026-10-18T06:00:05.123Z",
       "type":"access_request","accessTitle":"Use Notes","reason":"","accessStatus":"\(status)"\(scope.map { ",\"accessScope\":\"\($0)\"" } ?? ""),
       "subjects":[{"kind":"folder","key":"folder:/tmp","label":"tmp","detail":"Read files"}]}
      """
    }
    func request(_ status: String, _ scope: String?) throws -> TurnItem.AccessRequest {
      let item = try decodeJSON(TurnItem.self, json(status, scope))
      guard case let .accessRequest(request) = item.content else { throw DecodingError.dataCorrupted(.init(codingPath: [], debugDescription: "not access")) }
      return request
    }
    #expect(try request("allowed", "machine").accessScope == .machine)
    #expect(try request("allowed", "thread").accessScope == .thread)
    #expect(try request("denied", nil).accessStatus == .denied)
    #expect(try request("cancelled", nil).accessStatus == .cancelled)
    // Newer servers stay readable: an unknown status and scope never fail the item.
    let future = try request("expired", "everywhere")
    #expect(future.accessStatus.rawValue == "expired")
    #expect(future.accessStatus.known == nil)
    #expect(future.accessScope == nil)
    #expect(try request("allowed", "thread").subjects.first?.kind == .folder)
  }

  @Test func accessRequestToleratesABrokenIconAndAnUnknownKind() throws {
    let item = try decodeJSON(TurnItem.self, """
      {"id":"ti_b","threadId":"thr_1","ordinal":1,"status":"waiting","updatedAt":"2026-10-18T06:00:05.123Z",
       "type":"access_request","accessTitle":"Use the printer","reason":"Print the report","accessStatus":"pending",
       "subjects":[{"kind":"printer","key":"printer:office","label":"Office","detail":"Print","icon":{"mimeType":"image/png"}}]}
      """)
    guard case let .accessRequest(request) = item.content else {
      Issue.record("Expected an access request")
      return
    }
    #expect(request.subjects.first?.kind.rawValue == "printer")
    #expect(request.subjects.first?.icon == nil)
  }

  @Test func accessRequestRoundTripsThroughTheCache() throws {
    let item = try accessItem()
    let again = try WireCoding.decoder.decode(TurnItem.self, from: WireCoding.encoder.encode(item))
    #expect(again == item)
  }

  @Test func accessRequestAnswerEncodesAsTheContract() throws {
    #expect(try encodeToJSON(AccessRequestAnswer.allow(scope: .thread)) == .object(["type": .string("allow"), "scope": .string("thread")]))
    #expect(try encodeToJSON(AccessRequestAnswer.allow(scope: .machine)) == .object(["type": .string("allow"), "scope": .string("machine")]))
    #expect(try encodeToJSON(AccessRequestAnswer.deny) == .object(["type": .string("deny")]))
    #expect(try decodeJSON(AccessRequestAnswer.self, #"{"type":"deny"}"#) == .deny)
    #expect(throws: DecodingError.self) { try decodeJSON(AccessRequestAnswer.self, #"{"type":"maybe"}"#) }
  }

  @Test func accessRequestRpcFrame() throws {
    #expect(RpcMethod.accessAnswerRequest.rawValue == "access.answerRequest")
    #expect(!RpcMethod.accessAnswerRequest.isStream)
    let input = AccessAnswerRequestInput(threadId: "thr_1", turnItemId: "ti_access", answer: .allow(scope: .machine))
    let frame = try RpcClientMessage.request(id: 9, method: .accessAnswerRequest, payload: input)
    let expected: JSONValue = .object([
      "_tag": .string("Request"), "id": .number(9), "tag": .string("access.answerRequest"),
      "payload": .object([
        "threadId": .string("thr_1"),
        "turnItemId": .string("ti_access"),
        "answer": .object(["type": .string("allow"), "scope": .string("machine")]),
      ]),
      "headers": .array([]),
    ])
    #expect(try encodeToJSON(frame) == expected)
  }

  @Test func accessRequestErrorsReadAsTheServerMeansThem() {
    let error = ServerError.from(causes: [.fail(.object(["_tag": .string("AccessRequestError"), "reason": .string("already_answered")]))])
    #expect(error.message == "This access request was already answered.")
    #expect(error.kind == .other(tag: "AccessRequestError"))
    let stopped = ServerError.from(causes: [.fail(.object(["_tag": .string("AccessRequestError"), "reason": .string("agent_stopped")]))])
    #expect(stopped.message == "The agent that asked has stopped, so there is nothing to allow.")
  }
}
