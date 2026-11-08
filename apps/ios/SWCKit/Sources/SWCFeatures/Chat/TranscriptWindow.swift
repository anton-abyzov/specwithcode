import SWCSync

/// How much of a long transcript is on screen: the newest rows, with earlier
/// ones one tap away. A coordinator's transcript runs to thousands of rows,
/// and laying all of them out against the bottom edge outlasted the 10 s
/// watchdog when the phone took its snapshot for the app switcher.
nonisolated enum TranscriptWindow {
  static let step = 150

  /// The rows shown with `limit`, and how many earlier rows stay hidden.
  static func shown(_ rows: [TranscriptRow], limit: Int) -> (rows: ArraySlice<TranscriptRow>, hidden: Int) {
    let hidden = max(0, rows.count - limit)
    return (rows[hidden...], hidden)
  }

  /// A limit that includes the row with `id`, so scrolling to it can land.
  static func limit(revealing id: TranscriptRow.ID, in rows: [TranscriptRow], current: Int) -> Int {
    guard let index = rows.firstIndex(where: { $0.id == id }) else { return current }
    return max(current, rows.count - index)
  }
}
