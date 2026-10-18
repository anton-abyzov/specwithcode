import Foundation
import Testing
import SWCWire

/// Replays captured sessions with a real server. Every WebSocket frame must decode;
/// client frames must re-encode to what was sent; chunk and exit values must decode
/// as the type their request's method returns.
@Suite("Captured frames")
struct FramesTests {
  struct Tally: CustomStringConvertible {
    var sent = 0
    var reencoded = 0
    var received = 0
    var chunkValues = 0
    var exits = 0
    var http = 0
    var skipped: [String] = []
    var description: String {
      "sent \(sent), re-encoded \(reencoded), received \(received), chunk values \(chunkValues), exits \(exits), http \(http), skipped \(skipped.count)"
    }
  }

  /// Replays one capture and returns the counts, the shell items and the exits with their methods.
  static func replay(_ file: String) throws -> (Tally, [(String, ShellStreamItem)], [(String, RpcExit)]) {
    var tally = Tally()
    var tags: [String: String] = [:]
    var lastURL: [String: String] = [:]
    var shellItems: [(String, ShellStreamItem)] = []
    var exits: [(String, RpcExit)] = []

    func scope(_ line: JSONValue) -> String { line["label"]?.stringValue ?? "main" }
    func idKey(_ id: JSONValue?) -> String? {
      switch id {
      case let .number(n)?: String(Int(n))
      case let .string(s)?: s
      default: nil
      }
    }

    for line in try Fixture.lines(file) {
      let dir = line["dir"]?.stringValue ?? ""
      let kind = line["kind"]?.stringValue ?? ""
      let session = scope(line)

      if kind == "http" {
        tally.http += 1
        if dir == "send" {
          lastURL[session] = line["url"]?.stringValue
          continue
        }
        guard line["status"]?.intValue == 200, let body = line["body"], let url = lastURL[session] else { continue }
        if url.hasSuffix("/.well-known/studio/environment") {
          let descriptor = try body.decode(EnvironmentDescriptor.self)
          #expect(descriptor.compatibility == .compatible)
          #expect(descriptor.label == "Wire Probe")
        } else if url.hasSuffix("/api/orchestration/shell") {
          let snapshot = try body.decode(ShellSnapshot.self)
          #expect(snapshot.schemaVersion >= 1)
        }
        continue
      }
      guard kind == "ws", dir != "event" else { continue }

      // Frames sent as raw text: a batch array, or deliberately malformed input.
      var frames: [JSONValue] = []
      if let data = line["data"] {
        frames = [data]
      } else if let raw = line["raw"]?.stringValue {
        if let parsed = try? WireCoding.decoder.decode(JSONValue.self, from: Data(raw.utf8)) {
          frames = parsed.arrayValue ?? [parsed]
        } else {
          tally.skipped.append("\(file): unparseable raw frame")
          continue
        }
      }

      for frame in frames {
        let tag = frame["_tag"]?.stringValue ?? ""
        if dir == "send" {
          tally.sent += 1
          if tag == "Request", let id = idKey(frame["id"]), let method = frame["tag"]?.stringValue {
            tags["\(session)/\(id)"] = method
          }
          let message: RpcClientMessage?
          switch tag {
          case "Request":
            if let id = frame["id"]?.intValue, case .number = frame["id"], let method = frame["tag"]?.stringValue {
              message = .request(id: id, tag: method, payload: frame["payload"] ?? .object([:]))
            } else {
              message = nil
            }
          case "Ack": message = frame["requestId"]?.intValue.map { .ack(requestId: $0) }
          case "Interrupt": message = frame["requestId"]?.intValue.map { .interrupt(requestId: $0) }
          case "Ping": message = .ping
          default: message = nil
          }
          if let message {
            #expect(try encodeToJSON(message) == frame, "\(file): \(tag)")
            tally.reencoded += 1
          } else {
            tally.skipped.append("\(file): sent \(tag) \(frame["id"].map { "\($0)" } ?? "")")
          }
          continue
        }

        tally.received += 1
        let bytes = try WireCoding.encoder.encode(frame)
        if case let .string(id)? = frame["requestId"], Int(id) == nil {
          // The app only sends integer ids; a string id echo cannot be routed.
          #expect(throws: DecodingError.self) { try WireCoding.decoder.decode(RpcServerMessage.self, from: bytes) }
          tally.skipped.append("\(file): string request id \(id)")
          continue
        }
        let message = try WireCoding.decoder.decode(RpcServerMessage.self, from: bytes)
        switch message {
        case let .chunk(requestId, values):
          let method = try #require(tags["\(session)/\(requestId)"], "No request for chunk \(requestId)")
          for value in values {
            tally.chunkValues += 1
            switch RpcMethod(rawValue: method) {
            case .subscribeShell?:
              let item = try value.decode(ShellStreamItem.self)
              if case .unknown = item { Issue.record("Unknown shell item \(item.kind)") }
              shellItems.append((method, item))
            case .subscribeThread?:
              let item = try value.decode(ThreadStreamItem.self)
              if case .unknown = item { Issue.record("Unknown thread item") }
            case .subscribeServerConfig?:
              let item = try value.decode(ServerConfigStreamItem.self)
              if case let .snapshot(config) = item {
                #expect(config.environment.protocolVersion == OrchestrationProtocol.version)
              }
            default:
              Issue.record("Chunk for non-stream method \(method)")
            }
          }
        case let .exit(requestId, exit):
          tally.exits += 1
          let method = try #require(tags["\(session)/\(requestId)"], "No request for exit \(requestId)")
          exits.append((method, exit))
          if case .success = exit {
            switch RpcMethod(rawValue: method) {
            case .serverGetConfig?:
              let config = try exit.value(ServerConfig.self)
              #expect(!config.providers.isEmpty)
              #expect(config.settings != nil)
            case .ensureScratch?:
              _ = try exit.value(EnsureScratchResult.self)
            case .serverProbe?:
              _ = try exit.value(EmptyInput.self)
            default:
              break
            }
          }
        case .pong, .defect:
          break
        case let .unknown(tag):
          Issue.record("Unknown server frame \(tag)")
        }
      }
    }
    return (tally, shellItems, exits)
  }

  @Test func mainSession() throws {
    let (tally, shellItems, exits) = try Self.replay("frames-main.jsonl")
    #expect(tally.sent == 24)
    #expect(tally.received == 21)
    #expect(tally.chunkValues == 9)
    #expect(tally.exits == 9)
    #expect(tally.reencoded == 22)
    // Eof is not a frame the app sends; the string id request and its echo are skipped.
    #expect(tally.skipped.count == 3, "\(tally.skipped)")

    // The resolved-roots snapshot is a metadata patch.
    let patches = shellItems.filter {
      if case let .snapshot(_, roots) = $0.1 { return roots != nil }
      return false
    }
    #expect(patches.count == 2)
    let projectUpdates = shellItems.compactMap { item -> ProjectShell? in
      if case let .projectUpdated(_, project) = item.1 { return project }
      return nil
    }
    #expect(projectUpdates.count == 2)
    #expect(projectUpdates.first?.title == "No project")

    // Unsubscribing ends each of the three streams with interrupts only.
    let interrupted = exits.filter { $0.1.isInterruptOnly }.map(\.0)
    #expect(interrupted == [RpcMethod.subscribeShell, .subscribeShell, .subscribeServerConfig].map(\.rawValue))

    // Unknown methods and bad payloads fail as defects.
    var defects: [ServerError] = []
    for (_, exit) in exits where !exit.isSuccess && !exit.isInterruptOnly {
      #expect(throws: ServerError.self) { try exit.value(JSONValue.self) }
      do { _ = try exit.value(JSONValue.self) } catch let error as ServerError { defects.append(error) }
    }
    #expect(defects.allSatisfy { $0.kind == .defect })
    #expect(defects.count == 2)
    #expect(defects.first?.message == "Unknown request tag: no.such.method")
  }

  @Test func extrasSession() throws {
    let (tally, _, exits) = try Self.replay("frames-extras.jsonl")
    #expect(tally.received == 5)
    #expect(tally.reencoded == 2)
    #expect(tally.skipped.count == 3, "\(tally.skipped)")
    #expect(exits.count == 2)
    #expect(exits.allSatisfy { $0.1.isSuccess })
    #expect(tally.skipped.contains { $0.contains("unparseable") })
  }

  @Test func narrowTokenSession() throws {
    let (tally, _, exits) = try Self.replay("frames-narrow.jsonl")
    #expect(tally.exits == 2)
    for (_, exit) in exits {
      do {
        _ = try exit.value(ServerConfig.self)
        Issue.record("Expected an authorization failure")
      } catch let error as ServerError {
        #expect(error.kind == .authorization(requiredScope: "orchestration:read"))
      }
    }
  }
}
