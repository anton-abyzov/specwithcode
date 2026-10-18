import Foundation

/// A change to one thread, delivered by `orchestration.subscribeThread`.
///
/// Payloads the app applies are typed. Any other event type, or a turn item of a type
/// this build does not know, carries `.unknown` with its raw payload; skip it but
/// still advance the resume cursor. A typed event whose payload does not decode fails.
public struct DomainEvent: Codable, Hashable, Sendable, Identifiable {
  public enum Payload: Hashable, Sendable {
    /// Every `thread.*` event carries the whole thread record.
    case thread(AppThread)
    /// `run.created` and `run.updated`.
    case run(Run)
    case message(ConversationMessage)
    case turnItem(TurnItem)
    case plan(PlanArtifact)
    case runtimeRequest(RuntimeRequest)
    case unknown(JSONValue)
  }

  public var id: String
  public var threadId: String
  public var runId: String?
  public var nodeId: String?
  public var driver: String?
  public var providerInstanceId: String?
  public var rawEventId: String?
  public var occurredAt: Date
  public var type: String
  public var payload: Payload

  public init(id: String, threadId: String, runId: String? = nil, nodeId: String? = nil, occurredAt: Date, type: String, payload: Payload) {
    self.id = id
    self.threadId = threadId
    self.runId = runId
    self.nodeId = nodeId
    self.occurredAt = occurredAt
    self.type = type
    self.payload = payload
  }

  /// The `thread.*` types whose payload is the thread record.
  public static let threadEventTypes: Set<String> = [
    "thread.created", "thread.archived", "thread.unarchived", "thread.deleted", "thread.settled", "thread.unsettled",
    "thread.snoozed", "thread.unsnoozed", "thread.pinned", "thread.auto-settle-set", "thread.unpinned",
    "thread.pin-reordered", "thread.active-reordered", "thread.visited", "thread.marked-unread",
    "thread.pull-request-synced", "thread.metadata-updated", "thread.runtime-mode-updated",
    "thread.interaction-mode-updated", "thread.model-selection-updated", "thread.provider-switched",
  ]

  /// Every type decoded into a typed payload.
  public static let typedEventTypes: Set<String> = threadEventTypes.union([
    "run.created", "run.updated", "message.updated", "turn-item.updated", "plan.updated", "runtime-request.updated",
  ])

  enum CodingKeys: String, CodingKey { case id, threadId, runId, nodeId, driver, providerInstanceId, rawEventId, occurredAt, type, payload }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    let type = try c.decode(String.self, forKey: .type)
    guard Self.typedEventTypes.contains(type) else {
      self = DomainEvent(lenient: c, type: type)
      return
    }
    self.type = type
    id = try c.decode(String.self, forKey: .id)
    threadId = try c.decode(String.self, forKey: .threadId)
    runId = try c.decodeIfPresent(String.self, forKey: .runId)
    nodeId = try c.decodeIfPresent(String.self, forKey: .nodeId)
    driver = try c.decodeIfPresent(String.self, forKey: .driver)
    providerInstanceId = try c.decodeIfPresent(String.self, forKey: .providerInstanceId)
    rawEventId = try c.decodeIfPresent(String.self, forKey: .rawEventId)
    occurredAt = try c.decode(Date.self, forKey: .occurredAt)
    switch type {
    case "run.created", "run.updated":
      payload = .run(try c.decode(Run.self, forKey: .payload))
    case "message.updated":
      payload = .message(try c.decode(ConversationMessage.self, forKey: .payload))
    case "turn-item.updated":
      let item = try c.decode(TurnItem.self, forKey: .payload)
      if case let .unknown(_, raw) = item.content {
        payload = .unknown(raw)
      } else {
        payload = .turnItem(item)
      }
    case "plan.updated":
      payload = .plan(try c.decode(PlanArtifact.self, forKey: .payload))
    case "runtime-request.updated":
      payload = .runtimeRequest(try c.decode(RuntimeRequest.self, forKey: .payload))
    default:
      payload = .thread(try c.decode(AppThread.self, forKey: .payload))
    }
  }

  private init(lenient c: KeyedDecodingContainer<CodingKeys>, type: String) {
    id = (try? c.decode(String.self, forKey: .id)) ?? ""
    threadId = (try? c.decode(String.self, forKey: .threadId)) ?? ""
    runId = try? c.decodeIfPresent(String.self, forKey: .runId)
    nodeId = try? c.decodeIfPresent(String.self, forKey: .nodeId)
    driver = try? c.decodeIfPresent(String.self, forKey: .driver)
    providerInstanceId = try? c.decodeIfPresent(String.self, forKey: .providerInstanceId)
    rawEventId = try? c.decodeIfPresent(String.self, forKey: .rawEventId)
    occurredAt = (try? c.decode(Date.self, forKey: .occurredAt)) ?? Date(timeIntervalSince1970: 0)
    self.type = type
    payload = .unknown((try? c.decodeIfPresent(JSONValue.self, forKey: .payload)) ?? .null)
  }

  public func encode(to encoder: Encoder) throws {
    var c = encoder.container(keyedBy: CodingKeys.self)
    try c.encode(id, forKey: .id)
    try c.encode(threadId, forKey: .threadId)
    try c.encodeIfPresent(runId, forKey: .runId)
    try c.encodeIfPresent(nodeId, forKey: .nodeId)
    try c.encodeIfPresent(driver, forKey: .driver)
    try c.encodeIfPresent(providerInstanceId, forKey: .providerInstanceId)
    try c.encodeIfPresent(rawEventId, forKey: .rawEventId)
    try c.encode(occurredAt, forKey: .occurredAt)
    try c.encode(type, forKey: .type)
    switch payload {
    case let .thread(v): try c.encode(v, forKey: .payload)
    case let .run(v): try c.encode(v, forKey: .payload)
    case let .message(v): try c.encode(v, forKey: .payload)
    case let .turnItem(v): try c.encode(v, forKey: .payload)
    case let .plan(v): try c.encode(v, forKey: .payload)
    case let .runtimeRequest(v): try c.encode(v, forKey: .payload)
    case let .unknown(raw): try c.encode(raw, forKey: .payload)
    }
  }

  public var isUnknown: Bool {
    if case .unknown = payload { return true }
    return false
  }
}

/// The first value of a thread subscription, unless resumed with `afterSequence`.
public struct ThreadSnapshot: Codable, Hashable, Sendable {
  public var snapshotSequence: Int
  public var projection: ThreadProjection
  /// Set on bounded snapshots: the cursor for older history.
  public var historyCursor: String?
  public var hasMoreHistory: Bool?
  public var latestLocalTurnOrdinal: Int?
  public var payloadBudgetExceeded: Bool?

  public init(snapshotSequence: Int, projection: ThreadProjection, historyCursor: String? = nil, hasMoreHistory: Bool? = nil, latestLocalTurnOrdinal: Int? = nil, payloadBudgetExceeded: Bool? = nil) {
    self.snapshotSequence = snapshotSequence
    self.projection = projection
    self.historyCursor = historyCursor
    self.hasMoreHistory = hasMoreHistory
    self.latestLocalTurnOrdinal = latestLocalTurnOrdinal
    self.payloadBudgetExceeded = payloadBudgetExceeded
  }
}

/// One value of the `orchestration.subscribeThread` stream.
public enum ThreadStreamItem: Codable, Hashable, Sendable {
  /// Initial catch-up is done; live events follow.
  case synchronized
  case snapshot(ThreadSnapshot)
  case event(sequence: Int, event: DomainEvent)
  /// A kind this build does not know. Skip it.
  case unknown(kind: String, raw: JSONValue)

  enum CodingKeys: String, CodingKey { case kind, sequence, event }

  public init(from decoder: Decoder) throws {
    let c = try decoder.container(keyedBy: CodingKeys.self)
    let kind = try c.decode(String.self, forKey: .kind)
    switch kind {
    case "synchronized":
      self = .synchronized
    case "snapshot":
      self = .snapshot(try ThreadSnapshot(from: decoder))
    case "event":
      self = .event(sequence: try c.decode(Int.self, forKey: .sequence), event: try c.decode(DomainEvent.self, forKey: .event))
    default:
      self = .unknown(kind: kind, raw: try JSONValue(from: decoder))
    }
  }

  public func encode(to encoder: Encoder) throws {
    switch self {
    case .synchronized:
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode("synchronized", forKey: .kind)
    case let .snapshot(snapshot):
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode("snapshot", forKey: .kind)
      try snapshot.encode(to: encoder)
    case let .event(sequence, event):
      var c = encoder.container(keyedBy: CodingKeys.self)
      try c.encode("event", forKey: .kind)
      try c.encode(sequence, forKey: .sequence)
      try c.encode(event, forKey: .event)
    case let .unknown(_, raw):
      try raw.encode(to: encoder)
    }
  }

  /// The event sequence: the snapshot's for a snapshot, nil for `synchronized`.
  public var sequence: Int? {
    switch self {
    case .synchronized: nil
    case let .snapshot(snapshot): snapshot.snapshotSequence
    case let .event(sequence, _): sequence
    case let .unknown(_, raw): raw["sequence"]?.intValue
    }
  }
}
