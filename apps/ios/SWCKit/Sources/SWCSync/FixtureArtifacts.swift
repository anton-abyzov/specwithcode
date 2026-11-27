import Foundation

/// Sample replies and files for the `artifacts` scenario: what agents hand
/// over (diagrams, saved reports, pages, sheets, pictures, whiteboards), shown
/// with no live machine. The files are written to a temporary folder and
/// served from there as `file://` URLs; only this scenario returns one.
public nonisolated enum FixtureArtifacts {
  /// Where a reply says the files are, as a machine would write the paths.
  static let hostFolder = "/Users/sample/project/.specweave/reports/threads"

  static let reportName = "2026-11-27-iphone-rendering-review.md"
  static let pageName = "release-dashboard.html"
  static let sheetName = "release-checks.csv"
  static let pictureName = "release-flow.svg"
  static let boardName = "release-plan.excalidraw"
  static let notesName = "notes.md"

  static var rows: [TranscriptRow.Kind] {
    [
      .notice(text: "Sample conversation · no live machine or provider"),
      .user(text: "How does a release reach the phone?"),
      .assistant(markdown: """
      Here is the release path, from merge to the App Store.

      ```mermaid
      flowchart TD
        A[PR merged] --> B{CI green?}
        B -- yes --> C[Request release]
        B -- no --> D[Fix and push]
        D --> B
        C --> E[Desktop update]
        C --> F[TestFlight build]
        F --> G[App Store review]
      ```

      And who talks to whom while a build ships:

      ```mermaid
      sequenceDiagram
        participant Dev as Coordinator
        participant CI as GitHub Actions
        participant ASC as App Store Connect
        Dev->>CI: Merge and tag
        CI-->>Dev: Checks passed
        Dev->>ASC: Upload build 58
        ASC-->>Dev: Processing done
      ```
      """, streaming: false),
      .user(text: "Send me the report and the files."),
      .assistant(markdown: """
      Saved the review and the files it refers to:

      - Report: [iPhone rendering review](\(hostFolder)/\(reportName))
      - Dashboard: [\(pageName)](\(hostFolder)/\(pageName))
      - Checks: [\(sheetName)](\(hostFolder)/\(sheetName))
      - Diagram: [\(pictureName)](\(hostFolder)/\(pictureName))
      - Whiteboard: [\(boardName)](\(hostFolder)/\(boardName))
      - Notes: `\(hostFolder)/\(notesName)`
      """, streaming: false),
    ]
  }

  /// The local copy of a file a reply names, written on first use.
  static func localURL(for hostPath: String) -> URL? {
    let name = (hostPath as NSString).lastPathComponent
    guard let body = files[name] else { return nil }
    let folder = FileManager.default.temporaryDirectory.appendingPathComponent("swc-fixture-artifacts", isDirectory: true)
    try? FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
    let url = folder.appendingPathComponent(name)
    do {
      try Data(body.utf8).write(to: url, options: .atomic)
    } catch {
      return nil
    }
    return url
  }

  static let files: [String: String] = [
    reportName: report,
    pageName: page,
    sheetName: sheet,
    pictureName: picture,
    boardName: board,
    notesName: notes,
  ]

  static let report = """
  ---
  title: "iPhone rendering review"
  thread: "thread:sample-review-1498"
  threadTitle: "Review iPhone rendering"
  savedAt: "2026-11-27T14:05:00.000Z"
  reviewer: Muse Wonder Full 1.0
  date: November 27, 2026
  status: ship
  areas: [Mermaid, Reports, Sheets, Whiteboards]
  ---

  # iPhone rendering review

  Diagrams, reports and files now read cleanly on an iPhone. Two small follow-ups remain; neither blocks the release.

  ## Verdict

  Ship it. Every artifact type opens, fits the screen and follows dark mode. The **Mermaid** renderer works offline and the source stays one tap away.

  ## What changed

  | Area | Before | After |
  |---|---|---|
  | Mermaid | Raw code block | Diagram, zoomable |
  | Reports | One giant heading | Title, properties, body |
  | Sheets | Monospaced text | Table with a header row |
  | Whiteboards | Not a link | Drawing, zoomable |

  ## Flow

  ```mermaid
  flowchart LR
    Reply --> Parser --> Blocks
    Blocks --> Text
    Blocks --> Diagram
    Blocks --> Table
  ```

  ## Checks

  1. `swift test --filter Markdown` passed.
  2. Simulator screenshots in light and dark.
     - iPhone Duo, iOS 27.2
     - Offline: diagrams still render
  3. Real-device launch is still pending.

  ```bash
  make testflight V=0.1.9 B=58 NOTES="Diagrams and reports"
  ```

  > The App Store submission waits for a launch on a real phone.

  - [x] Port the frontmatter parser
  - [x] Render Mermaid offline
  - [ ] Launch on the owner's phone
  """

  static let notes = """
  # Notes

  Short notes with no frontmatter. The opening heading becomes the title.

  ---

  A rule between paragraphs stays a rule.
  """

  static let page = """
  <!doctype html>
  <html lang="en">
  <head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Release dashboard</title>
  <style>
    :root { color-scheme: light dark; font-family: -apple-system, system-ui, sans-serif; }
    body { margin: 0; padding: 20px; background: Canvas; color: CanvasText; }
    h1 { font-size: 22px; margin: 0 0 4px; }
    p { color: GrayText; margin: 0 0 16px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }
    .card { border: 1px solid color-mix(in srgb, CanvasText 12%, transparent); border-radius: 12px; padding: 14px; }
    .label { font-size: 12px; color: GrayText; }
    .value { font-size: 24px; font-weight: 600; margin-top: 4px; }
  </style>
  </head>
  <body>
  <h1>Release dashboard</h1>
  <p>Build 58 · November 27, 2026</p>
  <div class="grid">
    <div class="card"><div class="label">Checks</div><div class="value">42 / 42</div></div>
    <div class="card"><div class="label">Crash-free</div><div class="value">99.8%</div></div>
    <div class="card"><div class="label">Testers</div><div class="value">12</div></div>
    <div class="card"><div class="label">Review</div><div class="value">Pending</div></div>
  </div>
  </body>
  </html>
  """

  static let sheet = """
  Check,Platform,Result,Duration,Notes
  Unit tests,iOS,Passed,2m 14s,"swift test, 412 tests"
  Markdown snapshots,iOS,Passed,48s,
  Mermaid offline,iOS,Passed,12s,"flowchart, sequence, class"
  Server build,macOS,Passed,1m 03s,
  Web build,macOS,Passed,1m 41s,"vite, 2.1 MB"
  Brand audit,macOS,Passed,9s,
  Real-device launch,iOS,Pending,,Waiting for the owner
  """

  static let picture = """
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 220" width="640" height="220">
    <rect width="640" height="220" fill="#f7f7fb"/>
    <g font-family="-apple-system, sans-serif" font-size="16" text-anchor="middle">
      <rect x="20" y="80" width="160" height="60" rx="12" fill="#e8e6ff" stroke="#5b4cf0"/>
      <text x="100" y="116">Merge</text>
      <rect x="240" y="80" width="160" height="60" rx="12" fill="#e8e6ff" stroke="#5b4cf0"/>
      <text x="320" y="116">Build</text>
      <rect x="460" y="80" width="160" height="60" rx="12" fill="#e8e6ff" stroke="#5b4cf0"/>
      <text x="540" y="116">Ship</text>
      <path d="M180 110 H240 M400 110 H460" stroke="#5b4cf0" stroke-width="2"/>
    </g>
  </svg>
  """

  static let board = #"""
  {
    "type": "excalidraw",
    "version": 2,
    "source": "https://excalidraw.com",
    "elements": [
      {"id":"r1","type":"rectangle","x":40,"y":40,"width":220,"height":90,"angle":0,"strokeColor":"#1e1e1e","backgroundColor":"#a5d8ff","fillStyle":"solid","strokeWidth":2,"roundness":{"type":3},"isDeleted":false,"opacity":100},
      {"id":"t1","type":"text","x":80,"y":72,"width":140,"height":25,"angle":0,"strokeColor":"#1e1e1e","backgroundColor":"transparent","text":"Plan in spec.md","fontSize":20,"fontFamily":1,"textAlign":"center","isDeleted":false,"opacity":100},
      {"id":"d1","type":"diamond","x":340,"y":25,"width":180,"height":120,"angle":0,"strokeColor":"#1e1e1e","backgroundColor":"#ffec99","fillStyle":"solid","strokeWidth":2,"isDeleted":false,"opacity":100},
      {"id":"t2","type":"text","x":385,"y":72,"width":90,"height":25,"angle":0,"strokeColor":"#1e1e1e","backgroundColor":"transparent","text":"Review","fontSize":20,"fontFamily":1,"textAlign":"center","isDeleted":false,"opacity":100},
      {"id":"e1","type":"ellipse","x":600,"y":40,"width":180,"height":90,"angle":0,"strokeColor":"#1e1e1e","backgroundColor":"#b2f2bb","fillStyle":"solid","strokeWidth":2,"isDeleted":false,"opacity":100},
      {"id":"t3","type":"text","x":655,"y":72,"width":70,"height":25,"angle":0,"strokeColor":"#1e1e1e","backgroundColor":"transparent","text":"Ship","fontSize":20,"fontFamily":1,"textAlign":"center","isDeleted":false,"opacity":100},
      {"id":"a1","type":"arrow","x":260,"y":85,"width":80,"height":0,"angle":0,"strokeColor":"#1e1e1e","backgroundColor":"transparent","strokeWidth":2,"points":[[0,0],[80,0]],"endArrowhead":"arrow","isDeleted":false,"opacity":100},
      {"id":"a2","type":"arrow","x":520,"y":85,"width":80,"height":0,"angle":0,"strokeColor":"#1e1e1e","backgroundColor":"transparent","strokeWidth":2,"points":[[0,0],[80,0]],"endArrowhead":"arrow","isDeleted":false,"opacity":100},
      {"id":"f1","type":"freedraw","x":420,"y":190,"width":120,"height":30,"angle":0,"strokeColor":"#e03131","backgroundColor":"transparent","strokeWidth":2,"points":[[0,10],[20,0],[40,20],[60,5],[80,25],[100,8],[120,18]],"isDeleted":false,"opacity":100},
      {"id":"t4","type":"text","x":300,"y":230,"width":360,"height":25,"angle":0,"strokeColor":"#e03131","backgroundColor":"transparent","text":"Hand off if the track runs out","fontSize":18,"fontFamily":1,"textAlign":"center","isDeleted":false,"opacity":100}
    ],
    "appState": {"viewBackgroundColor": "#ffffff"},
    "files": {}
  }
  """#
}

extension FixtureEngine {
  public func hostFileURL(path: String, thumbnail: Bool, for target: ChatTarget) async throws -> URL? {
    guard scenario == .artifacts else { return nil }
    return FixtureArtifacts.localURL(for: path)
  }
}
