import Foundation
import Testing
@testable import Weave

/// Vectors ported from `markdownDocument` in packages/shared/src/reportDocument.test.ts,
/// so a report reads the same on the phone as on the desktop.
@Suite("Markdown files as documents")
struct MarkdownDocumentTests {
  static let research = [
    "---",
    "title: Project joining, folder handoff and machine pairing",
    "date: October 19, 2026",
    "source: anton-abyzov/specwithcode origin/main 8358add5d9 (read-only checkout ~/Projects/github/studio-live-activity-base)",
    "installed: M4 1.0.54, M3 1.0.53",
    "status: research and design only, nothing implemented",
    "---",
    "",
    "# Project joining, folder handoff and machine pairing",
    "",
    "**Verdict.** Build three things.",
    "",
    "## 1. The session",
    "",
    "| Field | Value |",
    "|---|---|",
    "| App | Claude desktop |",
  ].joined(separator: "\n")

  @Test("Frontmatter becomes the title and properties; the body stays as written")
  func research() {
    let document = MarkdownDocument.parse(Self.research)
    #expect(document.title == "Project joining, folder handoff and machine pairing")
    #expect(document.properties == [
      .init(label: "Date", value: .text("October 19, 2026")),
      .init(label: "Source", value: .text("anton-abyzov/specwithcode origin/main 8358add5d9 (read-only checkout ~/Projects/github/studio-live-activity-base)")),
      .init(label: "Installed", value: .text("M4 1.0.54, M3 1.0.53")),
      .init(label: "Status", value: .text("research and design only, nothing implemented")),
    ])
    #expect(document.body == "**Verdict.** Build three things.\n\n## 1. The session\n\n| Field | Value |\n|---|---|\n| App | Claude desktop |")
  }

  @Test("A saved report's quoted values, lists and keys read as properties")
  func savedReport() {
    let document = MarkdownDocument.parse("""
    ---
    title: "Review of PR 877, Suggestion clipboard fix"
    threadTitle: "Review PR 877"
    savedAt: "2026-11-24T16:16:00.739Z"
    head: afa860030f
    areas: [Mermaid, "Reports"]
    owners:
      - Anton
      - 'Percy'
    verdict: ship once the PR Gate runs for real (undraft); no code fix required
    ---

    # PR 877 review at `afa86003`

    ## Verdict
    """)
    #expect(document.title == "Review of PR 877, Suggestion clipboard fix")
    #expect(document.properties.map(\.label) == ["Thread title", "Saved at", "Head", "Areas", "Owners", "Verdict"])
    #expect(document.properties[3].value == .chips(["Mermaid", "Reports"]))
    #expect(document.properties[4].value == .chips(["Anton", "Percy"]))
    // The opening heading differs from the title, so it stays in the body.
    #expect(document.body.hasPrefix("# PR 877 review at `afa86003`"))
  }

  @Test("The opening heading names the page; one that differs from the title stays")
  func openingHeading() {
    let notes = MarkdownDocument.parse("---\ndate: today\n---\n\n# Notes\n\nBody.")
    #expect(notes.title == "Notes")
    #expect(notes.body == "Body.")
    let differs = MarkdownDocument.parse("---\ntitle: A\n---\n\n# B\n\nBody.")
    #expect(differs.title == "A")
    #expect(differs.properties.isEmpty)
    #expect(differs.body == "# B\n\nBody.")
  }

  @Test("Frontmatter too rich for a table shows as YAML, never as a rule and a heading")
  func richFrontmatter() {
    let document = MarkdownDocument.parse("---\nmeta:\n  nested: 1\n---\n\nBody.")
    #expect(document == MarkdownDocument(title: nil, properties: [], body: "~~~~yaml\nmeta:\n  nested: 1\n~~~~\n\nBody."))
  }

  @Test("A title keeps its own characters and a closing hash run only after a space")
  func titleCharacters() {
    #expect(MarkdownDocument.parse("---\ndate: x\n---\n\n# The my_module API for Vec<T>\n\nBody.").title == "The my_module API for Vec<T>")
    #expect(MarkdownDocument.parse("---\ndate: x\n---\n\n# Learn C#\n\nBody.").title == "Learn C#")
    #expect(MarkdownDocument.parse("---\ndate: x\n---\n\n# Closed ##\n\nBody.").title == "Closed")
    let styled = MarkdownDocument.parse("---\ntitle: snake_case_name\n---\n\n# **The** `snake_case_name`\n\nBody.")
    #expect(styled.title == "snake_case_name")
    #expect(styled.body == "# **The** `snake_case_name`\n\nBody.")
    #expect(MarkdownDocument.parse("---\ntitle: \"`snake_case_name`\"\n---\n\nBody.").title == "snake_case_name")
  }

  @Test("An indented code block that opens the body keeps its indentation")
  func indentedCode() {
    #expect(MarkdownDocument.parse("---\ndate: x\n---\n\n    indented code\n    more\n").body == "    indented code\n    more")
  }

  @Test("Rules around prose and files without frontmatter come back as written")
  func asWritten() {
    for text in [
      "---\n\nNote: draft only\n\n---\n\n# Real\n\nText",
      "---\n\nJust an intro\n\n---",
      "---\nJust an intro\n---\n",
      "# Title\n\n---\n\nBody.\n",
    ] {
      #expect(MarkdownDocument.parse(text) == MarkdownDocument(title: nil, properties: [], body: text))
    }
  }

  @Test("Keys read as words")
  func labels() {
    #expect(MarkdownDocument.humanized("threadTitle") == "Thread title")
    #expect(MarkdownDocument.humanized("saved_at") == "Saved at")
    #expect(MarkdownDocument.humanized("head-sha") == "Head sha")
    #expect(MarkdownDocument.humanized("URL") == "URL")
    #expect(MarkdownDocument.humanized("status") == "Status")
  }

  @Test("A reply that opens with frontmatter shows a title and a property card, not one big heading")
  func replyFrontmatter() {
    let blocks = MarkdownParser.parse("---\ntitle: Status\nverdict: ship\n---\n\nAll green.")
    #expect(blocks == [
      .heading(level: 1, text: "Status"),
      .properties([.init(label: "Verdict", value: .text("ship"))]),
      .paragraph("All green."),
    ])
  }
}
