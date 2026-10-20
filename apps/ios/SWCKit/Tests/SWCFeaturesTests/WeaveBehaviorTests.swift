import Foundation
import SwiftUI
import Testing
@testable import Weave
#if canImport(AppKit)
import AppKit
#endif

@MainActor
@Suite("Markdown links")
struct MarkdownLinkTests {
  private func links(_ markdown: String) -> [URL] {
    MarkdownInline.render(markdown, dynamicTypeSize: .large).runs.compactMap(\.link)
  }

  private func text(_ markdown: String) -> String {
    String(MarkdownInline.render(markdown, dynamicTypeSize: .large).characters)
  }

  @Test func webMailAndPhoneLinksStay() throws {
    #expect(links("See [the run](https://github.com/acme/web/actions).") == [try #require(URL(string: "https://github.com/acme/web/actions"))])
    #expect(links("[local](http://localhost:3000/docs)").count == 1)
    #expect(links("[mail](mailto:team@example.com) or [call](tel:+15551234567)").count == 2)
  }

  @Test func theAppsOwnSchemeBecomesPlainText() {
    let pair = "[CI run](specwithcode://pair?link=https%3A%2F%2Fstudio-mac.local%40evil.example%2F%23token%3Dx)"
    #expect(links(pair).isEmpty)
    #expect(text(pair) == "CI run")
    #expect(links("[thread](specwithcode://thread/env/t-1)").isEmpty)
  }

  @Test func otherSchemesBecomePlainText() {
    #expect(links("[open](otherapp://do-something)").isEmpty)
    #expect(links("[hosts](file:///etc/hosts)").isEmpty)
    #expect(links("[x](javascript:void)").isEmpty)
    #expect(links("[relative](docs/readme.md)").isEmpty)
  }

  @Test func mixedLinksKeepOnlyTheSafeOnes() throws {
    let found = links("[ok](https://spec-weave.com) and [no](specwithcode://pair)")
    #expect(found == [try #require(URL(string: "https://spec-weave.com"))])
  }

  @Test func schemeCheckIgnoresCase() throws {
    #expect(MarkdownInline.isOpenable(try #require(URL(string: "HTTPS://example.com"))))
    #expect(MarkdownInline.isOpenable(try #require(URL(string: "Mailto:a@b.co"))))
    #expect(!MarkdownInline.isOpenable(try #require(URL(string: "SpecWithCode://thread/a/b"))))
    #expect(!MarkdownInline.isOpenable(try #require(URL(string: "relative/path"))))
  }

  @Test func inlineCodeStillRendersAtEverySize() {
    for size in [DynamicTypeSize.large, .accessibility3] {
      let rendered = MarkdownInline.render("Run `npm test` now", dynamicTypeSize: size)
      #expect(String(rendered.characters) == "Run npm test now")
      #expect(rendered.runs.contains { $0.inlinePresentationIntent?.contains(.code) == true })
    }
  }
}

@Suite("Notice kinds")
struct NoticeKindTests {
  @Test func warningsAndErrorsAreSpoken() {
    #expect(WeaveNoticeKind.fail.spokenPrefix == "Error")
    #expect(WeaveNoticeKind.warn.spokenPrefix == "Warning")
    #expect(WeaveNoticeKind.info.spokenPrefix == nil)
    #expect(WeaveNoticeKind.pass.spokenPrefix == nil)
  }

  @Test func announcementsCarryTheKind() {
    #expect(WeaveNoticeKind.fail.announcement(for: "Couldn't archive the thread") == "Error: Couldn't archive the thread")
    #expect(WeaveNoticeKind.warn.announcement(for: "Pairing expires soon") == "Warning: Pairing expires soon")
    #expect(WeaveNoticeKind.pass.announcement(for: "Copied") == "Copied")
  }

  @Test func errorToastsStayLongerAndWrap() {
    #expect(WeaveNoticeKind.fail.toastDuration(.seconds(2.5)) == .seconds(6))
    #expect(WeaveNoticeKind.fail.toastDuration(.seconds(8)) == .seconds(8))
    #expect(WeaveNoticeKind.info.toastDuration(.seconds(2.5)) == .seconds(2.5))
    #expect(WeaveNoticeKind.pass.toastDuration(.seconds(2.5)) == .seconds(2.5))
    #expect(WeaveNoticeKind.fail.toastLineLimit == 5)
    #expect(WeaveNoticeKind.warn.toastLineLimit == 2)
    #expect(WeaveNoticeKind.pass.toastLineLimit == 2)
  }
}

@Suite("Symbols")
struct SymbolTests {
  @Test func aideReadsAsAnAssistantNotNotifications() {
    #expect(WeaveLucide.systemName(for: "concierge-bell") == WeaveLucide.assistantSystemName)
    #expect(WeaveLucide.systemName(for: "Concierge-Bell") == WeaveLucide.assistantSystemName)
    #expect(!WeaveLucide.assistantSystemName.hasPrefix("bell"))
  }

  /// Saved brain and padlock project icons still draw, as a stand-in.
  @MainActor @Test func retiredBrainAndLockIconsDrawStandIns() {
    #expect(WeaveLucide.systemName(for: "brain") == "lightbulb")
    #expect(WeaveLucide.systemName(for: "brain-circuit") == "cpu")
    #expect(WeaveLucide.systemName(for: "lock") == "shield")
    for name in WeaveLucide.knownNames {
      let symbol = WeaveLucide.systemName(for: name)
      #expect(!symbol.hasPrefix("brain") && !symbol.hasPrefix("lock"), "\(name) maps to \(symbol)")
    }
    #expect(ProjectAvatar.displayEmoji("\u{1F9E0}") == "\u{1F4A1}")
    #expect(ProjectAvatar.displayEmoji("\u{1F512}\u{FE0F}") == "\u{1F6E1}\u{FE0F}")
    #expect(ProjectAvatar.displayEmoji("\u{1F680}") == "\u{1F680}")
    #expect(ThinkingGlyph.dots.map(\.opacity) == [1, 0.6, 0.3])
    let breath = stride(from: 0.0, through: 1.6, by: 0.05).map(ThinkingGlyph.pulseOpacity(at:))
    #expect(breath.allSatisfy { $0 >= 0.449 && $0 <= 1.001 })
  }

  #if canImport(AppKit)
  /// SF Symbols has no concierge bell; the assistant symbol and every other
  /// mapped name must exist, or the avatar draws nothing.
  @Test func everyMappedSymbolExists() {
    #expect(NSImage(systemSymbolName: WeaveLucide.assistantSystemName, accessibilityDescription: nil) != nil)
    for name in WeaveLucide.knownNames {
      let symbol = WeaveLucide.systemName(for: name)
      #expect(NSImage(systemSymbolName: symbol, accessibilityDescription: nil) != nil, "\(name) maps to missing symbol \(symbol)")
    }
  }
  #endif
}

@MainActor
@Suite("Design refinements")
struct DesignRefinementTests {
  @Test func refinedValues() {
    #expect(WeaveFont.body.lineHeightMultiple == 1.55)
    #expect(MarkdownText.fadeHeight == 64)
    #expect(ComposerBar.stopGlyphScale == 0.55)
  }
}
