import CoreGraphics
import Testing
import Weave

@Suite struct LayoutClassTests {
  /// Portrait widths of the phones the app supports, and the class each gets.
  @Test func everyPhoneWidthGetsOneClass() {
    let phones: [(String, CGFloat, WeaveLayoutClass)] = [
      ("iPhone SE (1st generation)", 320, .compact),
      ("folded iPhone Duo beside its rail", 358, .compact),
      ("iPhone SE (3rd generation), mini", 375, .regular),
      ("iPhone 16e", 390, .regular),
      ("iPhone 16, 16 Pro", 393, .regular),
      ("iPhone 17, 17 Pro", 402, .regular),
      ("iPhone 16 Plus", 430, .large),
      ("iPhone 17 Pro Max", 440, .large),
      ("iPhone in landscape", 759, .large),
      ("unfolded iPhone Duo, iPad", 951, .wide),
    ]
    for (name, width, expected) in phones {
      #expect(WeaveLayoutClass(width: width) == expected, "\(name) at \(width)")
    }
  }

  @Test func wideStartsAtTheSidebarBreakpoint() {
    #expect(WeaveLayoutClass(width: WeaveSize.sidebarBreakpoint) == .wide)
    #expect(WeaveLayoutClass(width: WeaveSize.sidebarBreakpoint - 1) == .large)
    #expect(WeaveLayoutClass.compact < .regular && WeaveLayoutClass.large < .wide)
  }
}
