import SwiftUI

/// How much room a screen has, from the width it is given, not the device
/// model or size class: an iPhone Duo reports a compact class at full width,
/// and Split View or a rail narrows any scene. Screens choose what to show
/// from this instead of measuring themselves, so a change in what they show
/// never feeds back into the width they read.
public nonisolated enum WeaveLayoutClass: Int, Comparable, Sendable, CaseIterable {
  /// Under 375 points: iPhone SE (1st generation), a folded Duo beside its
  /// rail, narrow Split View. Headers drop labels and subtitles first.
  case compact
  /// 375 to 429 points: iPhone SE (2nd and 3rd), mini, 16e, 16, 17, Pro.
  case regular
  /// 430 to 759 points: Plus, Pro Max, Air, a phone in landscape short of
  /// the sidebar, an unfolded Duo held upright.
  case large
  /// From `WeaveSize.sidebarBreakpoint`: navigation sits beside the detail.
  case wide

  public init(width: CGFloat) {
    switch width {
    case ..<375: self = .compact
    case ..<430: self = .regular
    case ..<WeaveSize.sidebarBreakpoint: self = .large
    default: self = .wide
    }
  }

  public static func < (lhs: Self, rhs: Self) -> Bool { lhs.rawValue < rhs.rawValue }
}

private nonisolated struct LayoutClassKey: EnvironmentKey {
  static let defaultValue = WeaveLayoutClass.regular
}

extension EnvironmentValues {
  /// The room the current column has. `DrawerContainer` sets it for the
  /// detail and for the drawer or column from their own widths.
  public nonisolated var layoutClass: WeaveLayoutClass {
    get { self[LayoutClassKey.self] }
    set { self[LayoutClassKey.self] = newValue }
  }
}
