import Foundation

extension FixtureEngine {
  /// Sanitized shape of a scheduled check message. Not a live incident receipt.
  static var checkOutputRows: [TranscriptRow.Kind] {
    let activities = ["studio-code.studio_thread_list", "studio-code.studio_thread_send"].map { name -> TranscriptRow.Kind in
      let presentation = ToolPresentation(name: name, output: nil)
      return .tool(title: presentation.title, detail: presentation.detail, symbol: "bubble.left.and.bubble.right", status: .completed)
    }
    return [
      .notice(text: "Sample check output · no live incident or provider"),
      .user(text: """
      The check `/sample/due-check.sh` passed. Its output:

      ```json
      {"queue": {"escalated": 2, "recovered": 4, "verifying": 1},
       "worker": {"active": 0, "stale": 0},
       "monitor_error": null}
      ```
      """)
    ] + activities + [
      .assistant(markdown: "The repair owner is checking the **verifying job**. Two escalated jobs still need attention.", streaming: false)
    ]
  }
}
