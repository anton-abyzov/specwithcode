import Foundation
import SWCWire

// Port of the event handling in packages/client-runtime/src/state/orchestrationV2Projection.ts,
// limited to the parts of the projection the app decodes.

public enum ThreadReducer {
  /// Applies one committed event to the projection of the same thread.
  /// `partialTimeline` is set for bounded snapshots, which hold only recent history.
  public static func apply(_ event: DomainEvent, to projection: ThreadProjection, partialTimeline: Bool = false, latestLocalTurnOrdinal: Int? = nil) -> ThreadProjection {
    guard event.threadId == projection.thread.id else { return projection }
    var next = projection
    switch event.payload {
    case let .thread(thread):
      next.thread = thread
      // Visited tracking is read state, not activity.
      if event.type != "thread.visited", event.type != "thread.marked-unread" {
        next.updatedAt = event.occurredAt
      }
    case let .run(run):
      next.updatedAt = event.occurredAt
      next.runs = upsert(next.runs, run)
      next.visibleTurnItems = activeVisibleTurnItems(next)
    case let .message(message):
      next.updatedAt = event.occurredAt
      next.messages = upsert(next.messages, message)
    case let .plan(plan):
      next.updatedAt = event.occurredAt
      next.plans = upsert(next.plans, plan)
    case let .runtimeRequest(request):
      next.updatedAt = event.occurredAt
      next.runtimeRequests = upsert(next.runtimeRequests, request)
    case let .turnItem(item):
      if partialTimeline, !projection.turnItems.contains(where: { $0.id == item.id }),
         shouldDropMissingPartialItem(projection, item, latestLocalTurnOrdinal: latestLocalTurnOrdinal) {
        return projection
      }
      next.updatedAt = event.occurredAt
      next.turnItems = upsert(next.turnItems, item)
      if isVisible(item, runs: next.runs) {
        next.visibleTurnItems = upsertVisible(next, item, partialTimeline: partialTimeline, latestLocalTurnOrdinal: latestLocalTurnOrdinal)
      } else {
        next.visibleTurnItems = removeVisible(next.visibleTurnItems, itemId: item.id)
      }
    case .unknown:
      next.updatedAt = event.occurredAt
    }
    return next
  }

  /// Rolled-back runs leave no rows, and a queued message whose run was
  /// cancelled never reached the provider.
  public static func isVisible(_ item: TurnItem, runs: [Run]) -> Bool {
    guard let runId = item.runId, let run = runs.first(where: { $0.id == runId }) else { return true }
    if run.status == .rolledBack { return false }
    if run.status == .cancelled, case let .userMessage(message) = item.content, message.inputIntent == .queuedTurn {
      return false
    }
    return true
  }

  static func activeVisibleTurnItems(_ projection: ThreadProjection) -> [ProjectedTurnItem] {
    let rows = projection.visibleTurnItems
    let kept = rows.filter { $0.visibility != .local || isVisible($0.item, runs: projection.runs) }
    return kept.count == rows.count ? rows : renumber(kept)
  }

  static func removeVisible(_ rows: [ProjectedTurnItem], itemId: String) -> [ProjectedTurnItem] {
    guard let index = rows.firstIndex(where: { $0.sourceItemId == itemId }) else { return rows }
    var next = rows
    next.remove(at: index)
    return renumber(next)
  }

  static func renumber(_ rows: [ProjectedTurnItem]) -> [ProjectedTurnItem] {
    var next = rows
    for index in next.indices where next[index].position != index {
      next[index].position = index
    }
    return next
  }

  static func oldestLocalOrdinal(_ rows: [ProjectedTurnItem]) -> Int? {
    rows.filter { $0.visibility == .local }.map(\.item.ordinal).min()
  }

  static func shouldDropMissingPartialItem(_ projection: ThreadProjection, _ item: TurnItem, latestLocalTurnOrdinal: Int?) -> Bool {
    if projection.visibleTurnItems.contains(where: { $0.sourceItemId == item.id }) { return false }
    if let latestLocalTurnOrdinal, item.ordinal <= latestLocalTurnOrdinal { return true }
    if let oldest = oldestLocalOrdinal(projection.visibleTurnItems), item.ordinal < oldest { return true }
    return false
  }

  static func upsertVisible(_ projection: ThreadProjection, _ item: TurnItem, partialTimeline: Bool, latestLocalTurnOrdinal: Int?) -> [ProjectedTurnItem] {
    let rows = projection.visibleTurnItems
    let index = rows.firstIndex { $0.sourceItemId == item.id }
    let row = ProjectedTurnItem(position: 0, visibility: .local, sourceThreadId: item.threadId, sourceItemId: item.id, item: item)
    if let index {
      let previous = rows[index]
      if previous.visibility == .local, previous.sourceThreadId == row.sourceThreadId, previous.item == item {
        return rows
      }
    } else if partialTimeline, shouldDropMissingPartialItem(projection, item, latestLocalTurnOrdinal: latestLocalTurnOrdinal) {
      return rows
    }
    var updated = rows
    if let index { updated.remove(at: index) }
    let insertion = updated.firstIndex { candidate in
      candidate.visibility == .local
        && (candidate.item.ordinal > item.ordinal || (candidate.item.ordinal == item.ordinal && candidate.item.id > item.id))
    }
    updated.insert(row, at: insertion ?? updated.endIndex)
    return renumber(updated)
  }

  static func upsert<T: Identifiable>(_ items: [T], _ item: T) -> [T] {
    var next = items
    if let index = next.firstIndex(where: { $0.id == item.id }) {
      next[index] = item
    } else {
      next.append(item)
    }
    return next
  }
}

/// One open thread as its subscription builds it.
public struct ThreadState: Sendable, Hashable {
  public private(set) var projection: ThreadProjection?
  /// The last sequence applied: the snapshot's, then each event's.
  public private(set) var sequence: Int?
  /// The projection is current on this subscription: a snapshot arrived or
  /// the replay of missed events finished.
  public private(set) var isSynchronized = false
  /// The snapshot was a bounded window of recent history.
  public private(set) var partialTimeline = false
  public private(set) var latestLocalTurnOrdinal: Int?

  public init() {}

  /// The sequence to resume from, when a projection is held.
  public var resumeSequence: Int? { projection == nil ? nil : sequence }

  public mutating func beginSubscription() {
    isSynchronized = false
  }

  /// Applies one stream item. Returns true when anything visible changed.
  @discardableResult
  public mutating func apply(_ item: ThreadStreamItem) -> Bool {
    switch item {
    case .synchronized:
      defer { isSynchronized = true }
      return !isSynchronized
    case let .snapshot(snapshot):
      projection = snapshot.projection
      sequence = snapshot.snapshotSequence
      // A snapshot is the thread as it is now. Without this the transcript reads
      // as stale until the marker arrives, one ack round trip later.
      isSynchronized = true
      // A bounded snapshot is partial only while older history remains
      // (client-runtime threads.ts); a complete window applies every item.
      partialTimeline = snapshot.hasMoreHistory == true || snapshot.historyCursor != nil
      latestLocalTurnOrdinal = snapshot.latestLocalTurnOrdinal
      return true
    case let .event(eventSequence, event):
      guard let current = projection else { return false }
      if let sequence, eventSequence <= sequence { return false }
      sequence = eventSequence
      let next = ThreadReducer.apply(event, to: current, partialTimeline: partialTimeline, latestLocalTurnOrdinal: latestLocalTurnOrdinal)
      guard next != current else { return false }
      projection = next
      return true
    case .unknown:
      return false
    }
  }
}
