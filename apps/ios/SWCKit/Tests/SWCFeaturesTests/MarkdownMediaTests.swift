import Foundation
import Testing
@testable import Weave

@Suite("Pictures in replies")
struct MarkdownMediaTests {
  @Test("An image with an absolute path or a web address becomes a block of its own")
  func imageBlocks() {
    let blocks = MarkdownParser.parse("""
    Here is the result.

    ![After](/Users/me/shots/after.png)

    Before ![web](https://example.com/a.png) after.
    """)
    #expect(blocks == [
      .paragraph("Here is the result."),
      .image(alt: "After", source: .host("/Users/me/shots/after.png")),
      .paragraph("Before"),
      .image(alt: "web", source: .web(URL(string: "https://example.com/a.png")!)),
      .paragraph("after."),
    ])
  }

  @Test("Encoded, angle-bracketed, titled and linked images resolve")
  func imageForms() {
    #expect(MarkdownParser.parse("![a](</Users/me/my shots/a.png>)") == [.image(alt: "a", source: .host("/Users/me/my shots/a.png"))])
    #expect(MarkdownParser.parse("![a](/Users/me/my%20shots/a.png)") == [.image(alt: "a", source: .host("/Users/me/my shots/a.png"))])
    #expect(MarkdownParser.parse("![a](file:///tmp/a.png)") == [.image(alt: "a", source: .host("/tmp/a.png"))])
    #expect(MarkdownParser.parse("![a](/tmp/a.jpg \"A title\")") == [.image(alt: "a", source: .host("/tmp/a.jpg"))])
    #expect(MarkdownParser.parse("[![a](/tmp/a.png)](https://example.com) done") == [
      .image(alt: "a", source: .host("/tmp/a.png")),
      .paragraph("done"),
    ])
  }

  @Test("What the app cannot draw stays text", arguments: [
    "![a](shots/a.png)",
    "![a](ftp://example.com/a.png)",
    "![a](/tmp/a.svg)",
    "![a](/tmp/notes.md)",
    "`![a](/tmp/a.png)`",
  ])
  func staysText(markdown: String) {
    #expect(MarkdownParser.parse(markdown) == [.paragraph(markdown)])
  }

  private func fallback(_ markdown: String) -> String? {
    MarkdownMedia.firstUnembeddedImage(in: MarkdownParser.parse(markdown))
  }

  @Test("A reply that names pictures only by path offers the first one")
  func fallbackPick() {
    #expect(fallback("Saved `/tmp/notes.md` and `/tmp/shots/after.png`, also `/tmp/shots/before.png`.") == "/tmp/shots/after.png")
    #expect(fallback("See [the shot](/tmp/shots/my%20shot.png) and `/tmp/b.png`.") == "/tmp/shots/my shot.png")
    #expect(fallback("- one\n- `/tmp/in-list.jpg`") == "/tmp/in-list.jpg")
    #expect(MarkdownMedia.fallbackImage(for: "Saved `/tmp/shots/after.png`.") == "/tmp/shots/after.png")
  }

  @Test("No fallback when the reply embeds media, names none, or only quotes code", arguments: [
    "![a](/tmp/a.png)\n\nAlso `/tmp/b.png`.",
    "![a](shots/a.png) and `/tmp/b.png`",
    "<img src=\"x.png\"> and `/tmp/b.png`",
    "<video src=\"/tmp/a.mp4\"></video> `/tmp/b.png`",
    "Nothing here but `/tmp/notes.md` and `relative/a.png`.",
    "```\n/tmp/in-a-log.png\n```",
    "See https://example.com/a.png",
    "`~/shots/a.png`",
  ])
  func noFallback(markdown: String) {
    #expect(fallback(markdown) == nil)
  }

  @Test("A collapsed reply counts and names its pictures")
  func collapse() {
    let image = MarkdownBlock.image(alt: "After", source: .host("/tmp/a.png"))
    #expect(MarkdownCollapse.length(image) == 500)
    #expect(MarkdownCollapse.plainText(image) == "After")
  }
}
