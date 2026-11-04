import CoreGraphics
import Foundation
import ImageIO
import SWCTransport
import SWCWire
import Testing
import UniformTypeIdentifiers
@testable import SWCSync

@MainActor
@Suite struct PhotoAttachmentTests {
  /// A landscape picture in `type`, tagged with a GPS position and rotated by EXIF.
  nonisolated func picture(_ type: UTType, width: Int = 4000, height: Int = 3000) throws -> Data {
    let space = try #require(CGColorSpace(name: CGColorSpace.sRGB))
    let context = try #require(CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: space, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
    context.setFillColor(CGColor(red: 0.2, green: 0.4, blue: 0.8, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    let image = try #require(context.makeImage())
    let output = NSMutableData()
    let destination = try #require(CGImageDestinationCreateWithData(output, type.identifier as CFString, 1, nil))
    let properties: [CFString: Any] = [
      kCGImagePropertyOrientation: 6,
      kCGImagePropertyGPSDictionary: [kCGImagePropertyGPSLatitude: 40.7, kCGImagePropertyGPSLongitude: 74.0],
    ]
    CGImageDestinationAddImage(destination, image, properties as CFDictionary)
    #expect(CGImageDestinationFinalize(destination))
    return output as Data
  }

  nonisolated func properties(_ data: Data) throws -> [CFString: Any] {
    let source = try #require(CGImageSourceCreateWithData(data as CFData, nil))
    return try #require(CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any])
  }

  @Test func heicBecomesASmallUprightJpegWithoutLocation() throws {
    let encoded = try PhotoAttachmentEncoder.encode(try picture(.heic))
    #expect(encoded.mimeType == "image/jpeg")
    #expect(encoded.name.hasSuffix(".jpg"))
    #expect(encoded.data.count <= PhotoAttachmentEncoder.maximumBytes)
    let source = try #require(CGImageSourceCreateWithData(encoded.data as CFData, nil))
    #expect(CGImageSourceGetType(source) as String? == UTType.jpeg.identifier)
    let info = try properties(encoded.data)
    // EXIF orientation 6 turns 4000x3000 upright, then the long side fits 2048.
    #expect(info[kCGImagePropertyPixelHeight] as? Int == 2048)
    #expect(info[kCGImagePropertyPixelWidth] as? Int == 1536)
    #expect(info[kCGImagePropertyGPSDictionary] == nil)
    #expect((info[kCGImagePropertyOrientation] as? Int ?? 1) == 1)
  }

  @Test func notAPictureSaysSo() {
    #expect(throws: PhotoAttachmentError.self) { try PhotoAttachmentEncoder.encode(Data("not a picture".utf8)) }
  }

  func first(_ value: JSONValue?) -> JSONValue? {
    if case let .array(items)? = value { items.first } else { nil }
  }

  func image() throws -> OutgoingImage { try PhotoAttachmentEncoder.encode(try picture(.png, width: 64, height: 48)) }

  func answerUploads(_ h: LiveEngineTests.Harness) {
    h.machine.answer("attachments.createUploadUrl", with: #"{"attachmentId":"pending-abc","relativeUrl":"/api/attachments/upload/tok.sig","expiresAt":1}"#)
  }

  @Test func aThreadMessageUploadsThenSendsThePendingId() async throws {
    let tests = LiveEngineTests()
    let h = try await tests.harness()
    defer { h.engine.setActive(false) }
    #expect(await tests.loaded(h))
    answerUploads(h)
    let photo = try image()
    try await h.engine.send("", images: [photo], to: .thread(ThreadRef(environmentId: tests.env, threadId: "thr_1")))
    let ask = try #require(h.machine.payloads("attachments.createUploadUrl").first)
    #expect(ask["type"]?.stringValue == "image")
    #expect(ask["mimeType"]?.stringValue == "image/jpeg")
    #expect(ask["sizeBytes"] == .number(Double(photo.data.count)))
    let upload = try #require(h.machine.uploads.values.first)
    #expect(upload.url?.path == "/api/attachments/upload/tok.sig")
    #expect(upload.httpMethod == "POST")
    #expect(upload.httpBody == photo.data)
    #expect(upload.url?.host() == "192.168.1.20")
    let command = try #require(h.machine.payloads("orchestration.dispatchCommand").last)
    let attachment = try #require(first(command["attachments"]))
    #expect(attachment["id"]?.stringValue == "pending-abc")
    #expect(attachment["sizeBytes"] == .number(Double(photo.data.count)))
  }

  @Test func aCoordinatorMessageCarriesThePendingId() async throws {
    let tests = LiveEngineTests()
    let h = try await tests.harness()
    defer { h.engine.setActive(false) }
    #expect(await tests.loaded(h))
    answerUploads(h)
    let project = try #require(h.model.projects.first)
    try await h.engine.send("look", images: [try image()], to: .project(project.ref))
    let input = try #require(h.machine.payloads("projects.coordinatorSend").last)
    #expect(input["prompt"]?.stringValue == "look")
    let attachment = try #require(first(input["attachments"]))
    #expect(attachment["id"]?.stringValue == "pending-abc")
  }

  @Test func aFailedUploadSendsNothing() async throws {
    let tests = LiveEngineTests()
    let h = try await tests.harness(failing: ["attachments.createUploadUrl": "refused"])
    defer { h.engine.setActive(false) }
    #expect(await tests.loaded(h))
    await #expect(throws: (any Error).self) {
      try await h.engine.send("look", images: [try image()], to: .thread(ThreadRef(environmentId: tests.env, threadId: "thr_1")))
    }
    let dispatched = h.machine.payloads("orchestration.dispatchCommand").filter { $0["type"]?.stringValue == "message.dispatch" }
    #expect(dispatched.isEmpty)
    #expect(h.model.session(for: .thread(ThreadRef(environmentId: tests.env, threadId: "thr_1"))).rows.allSatisfy { $0.id.hasPrefix("pending:") == false })
  }

  @Test func linksReadTheMachinesOwnThreadList() async throws {
    let tests = LiveEngineTests()
    let h = try await tests.harness()
    defer { h.engine.setActive(false) }
    #expect(await tests.loaded(h))
    let machines = try #require(h.engine.threadLinkMachines())
    #expect(machines.count == 1)
    #expect(try h.model.threadLink(threadId: "thr_1", environmentId: nil, from: tests.env) == ThreadRef(environmentId: tests.env, threadId: "thr_1"))
  }

  @Test func attachmentURLUsesTheSocketRouteEvenWhenPublishedStatusLags() async throws {
    let tests = LiveEngineTests()
    let h = try await tests.harness()
    defer { h.engine.setActive(false) }
    #expect(await tests.loaded(h))
    // The socket and status feeds are consumed independently during reconnect.
    let entry = try #require(h.engine.machines[tests.env])
    entry.status.route = try #require(MachineRoute(httpBase: "https://old-route.invalid"))
    h.machine.answer("assets.createUrl", with: #"{"relativeUrl":"/api/assets/tok.sig","expiresAt":1}"#)
    let shown = TranscriptAttachment(id: "thr-1-abc", name: "a.jpg", mimeType: "image/jpeg", isImage: true)
    let url = try await h.engine.attachmentURL(shown, on: tests.env)
    #expect(url?.absoluteString == "http://192.168.1.20:8319/api/assets/tok.sig")
    let resource = try #require(h.machine.payloads("assets.createUrl").last?["resource"])
    #expect(resource["_tag"]?.stringValue == "attachment")
    #expect(resource["disposition"]?.stringValue == "inline")
  }
}
