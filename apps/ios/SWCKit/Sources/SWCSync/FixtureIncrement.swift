import Foundation

extension FixtureEngine {
  public func incrementProgress(for target: ChatTarget) async throws -> IncrementRead {
    guard scenario == .readability else { return .unbound }
    if case .aide = target { return .unbound }
    if case let .thread(ref) = target, ref.threadId != "t-release" { return .unbound }
    return .bound(try JSONDecoder().decode(IncrementProgress.self, from: Data(Self.sampleIncrement.utf8)))
  }

  static let sampleIncrement = #"""
  {"threadId":"t-release","incrementId":"0970-phone-fleet-failover","binding":"claim","boundTaskId":"T-05","title":"Phone keeps working when the main machine is off · Sample","status":"active","incrementPath":"/sample/project/.specweave/increments/0970-phone-fleet-failover","specPath":"/sample/project/.specweave/increments/0970-phone-fleet-failover/spec.md","readable":true,"tasks":[{"id":"T-04","title":"Continue on another machine","status":"done","criteria":["AC-04"],"note":null,"commit":"sample-commit"},{"id":"T-05","title":"Physical two-Mac acceptance","status":"blocked","criteria":["AC-06"],"note":"Sample: physical M4-off check has not been run."}],"criteria":[{"id":"AC-04","text":"Show eligible destinations and explain refusal.","met":true},{"id":"AC-06","text":"Verify the phone with M4 off and a second Mac reachable.","met":false}],"verify":{"ok":false,"ranAt":"2026-10-21T12:00:00Z"}}
  """#

  static var readabilityRows: [TranscriptRow.Kind] {
    [
      .notice(text: "Sample conversation · no live machine or provider"),
      .user(text: "Show the threads and explain what is actually verified."),
      .assistant(markdown: """
      ## Phone continuity
      The simulator checks passed. **Physical acceptance is still pending.**

      [Open the release thread](studio://thread/t-release) to inspect its separate SpecWeave increment.

      | Check | Result |
      | --- | --- |
      | Markdown and links | Passed in sample |
      | Destination execution | Not verified by this sample |

      ### Next steps
      1. Open **Threads** for the project's work.
      2. Open **SpecWeave increment** for recorded tasks and acceptance criteria.
         - A provider checklist is a conversation aid.
         - The increment is read from the project's spec and ledger.

      ```sh
      specweave verify 0970
      ```

      > A screenshot proves the screen, not execution on another Mac.
      """, streaming: false),
      .tool(title: "Read conversation", detail: "Tool: mcp__studio_code__studio_thread_read", symbol: "doc.text", status: .completed),
      .tool(title: "Find conversations", detail: "Project access denied. Ask the project owner for access.\nTool: mcp__studio_code__studio_thread_list", symbol: "bubble.left.and.bubble.right", status: .failed),
      .plan(steps: [.init(id: "a", text: "Inspect the screenshot", status: .completed), .init(id: "b", text: "Compare mobile and desktop handoff", status: .running)]),
      .assistant(markdown: "This is the provider's checklist. Tap **SpecWeave increment** to inspect the actual binding. [Unavailable thread](studio://thread/not-loaded) reports why it cannot open.", streaming: false)
    ]
  }
}
