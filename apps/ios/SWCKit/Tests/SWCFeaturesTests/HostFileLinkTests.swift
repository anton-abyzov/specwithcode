import Foundation
import SwiftUI
import Testing
@testable import Weave

@MainActor
@Suite("Host file links")
struct HostFileLinkTests {
  private func links(_ markdown: String) -> [URL] {
    MarkdownInline.render(markdown, dynamicTypeSize: .large).runs.compactMap(\.link)
  }

  @Test func linkedAbsolutePathsOpenInTheViewer() throws {
    let found = links("[cue-sheet.html](/Users/me/Movies/live/cue-sheet.html) and [notes](file:///Users/me/notes.md)")
    #expect(found.compactMap(HostFileLink.path) == ["/Users/me/Movies/live/cue-sheet.html", "/Users/me/notes.md"])
  }

  @Test func backtickedAbsolutePathsBecomeLinks() {
    let found = links("Wrote `/Users/me/run.txt` and `/tmp/data.json`, ran `npm test`")
    #expect(found.compactMap(HostFileLink.path) == ["/Users/me/run.txt", "/tmp/data.json"])
  }

  @Test func onlyViewableAbsoluteFilesQualify() {
    #expect(links("[hosts](file:///etc/hosts)").isEmpty)
    #expect(links("[relative](docs/readme.md)").isEmpty)
    #expect(links("`/usr/bin/env`").isEmpty)
    #expect(links("`/Users/me/archive.zip`").isEmpty)
    #expect(links("[remote](file://server/share/a.html)").isEmpty)
    #expect(HostFileLink.hostPath("/Users/me/../etc/a.html") == nil)
    #expect(HostFileLink.hostPath("//server/a.html") == nil)
  }

  @Test func lineSuffixesAndEncodingAreDropped() {
    #expect(HostFileLink.hostPath("/Users/me/a%20b.md") == "/Users/me/a b.md")
    #expect(HostFileLink.hostPath("/Users/me/log.txt:42") == "/Users/me/log.txt")
    #expect(HostFileLink.hostPath("/Users/me/page.html#L3") == "/Users/me/page.html")
  }

  @Test func internalLinksRoundTripAndRejectOtherSchemes() throws {
    let url = try #require(HostFileLink.url(for: "/Users/me/My Report.html"))
    #expect(HostFileLink.path(url) == "/Users/me/My Report.html")
    #expect(!MarkdownInline.isOpenable(url))
    #expect(HostFileLink.path(try #require(URL(string: "https://example.com/a.html"))) == nil)
    #expect(HostFileLink.path(try #require(URL(string: "swc-file://evil/a.html"))) == nil)
  }

  @Test func kindsFollowTheExtension() {
    #expect(HostFileLink.kind(of: "/a/b.HTML") == .page)
    #expect(HostFileLink.kind(of: "/a/b.md") == .markdown)
    #expect(HostFileLink.kind(of: "/a/b.json") == .text)
    #expect(HostFileLink.kind(of: "/a/b.svg") == .image)
    #expect(HostFileLink.kind(of: "/a/b.pdf") == .pdf)
    #expect(HostFileLink.kind(of: "/a/b") == nil)
  }
}
