import SwiftUI
import CoreGraphics

/// Spacing steps, named after the Weave tokens (wv-space-1 is 4 pt).
public nonisolated enum WeaveSpacing {
  public static let s1: CGFloat = 4
  public static let s2: CGFloat = 8
  public static let s3: CGFloat = 12
  public static let s4: CGFloat = 16
  public static let s6: CGFloat = 24
  public static let s8: CGFloat = 32

  /// Side margin for chrome and cards.
  public static let gutter: CGFloat = 16
  /// Leading inset of text inside cards, section labels and assistant replies.
  public static let contentInset: CGFloat = 32
}

/// Corner radii.
///
/// xs, sm, md and lg are the Weave web radii and keep their meaning for small
/// things: chips and inline code (4-6), inputs inside cards (10), small frames
/// (14). Weave caps radius at 14 on the web, but the phone follows iOS
/// conventions for large surfaces: cards, menus and sheets use larger
/// continuous corners so they sit well with the device corners and system
/// sheets. Always pair these with `style: .continuous`.
public nonisolated enum WeaveRadius {
  public static let xs: CGFloat = 4
  public static let sm: CGFloat = 6
  public static let md: CGFloat = 10
  public static let lg: CGFloat = 14
  /// Project icon tiles.
  public static let tile: CGFloat = 8
  /// Message bubbles.
  public static let bubble: CGFloat = 20
  /// Grouped cards, context menus, text field cards.
  public static let card: CGFloat = 24
  /// Top corners of bottom sheets.
  public static let sheet: CGFloat = 38
  /// The main screen while the drawer is open.
  public static let drawerContent: CGFloat = 40
}

/// Fixed sizes.
public nonisolated enum WeaveSize {
  /// Minimum hit area for anything tappable.
  public static let minTap: CGFloat = 44
  /// Circular header buttons and the title capsule height.
  public static let control: CGFloat = 44
  /// Buttons inside the composer.
  public static let innerControl: CGFloat = 36
  /// Composer capsule height with one line of text.
  public static let composer: CGFloat = 52
  /// Icon tile inside the title capsule.
  public static let titleTile: CGFloat = 27
  /// Hairline width.
  public static let hairline: CGFloat = 0.5
  /// Widest a transcript, composer or list grows in a wide detail column, so
  /// lines stay readable on an unfolded or rotated phone.
  public static let readableColumn: CGFloat = 720
  /// Scene width from which navigation sits beside the detail as a column.
  /// Below it (a folded phone, an unfolded Duo held upright, Split View) the
  /// chat keeps the whole width and navigation is the modal drawer.
  public static let sidebarBreakpoint: CGFloat = 760
  /// An iPhone Duo reports its status bar as a trailing rail and no top inset,
  /// but the system still takes touches along the top edge: on the Duo
  /// simulator a button there did not fire above about 15 points. Headers start
  /// this far down, which also clears the display's rounded corners.
  public static let statusRailHeaderTop: CGFloat = 20
  /// From the top of the screen to the first control in the rail, below the
  /// clock and Wi-Fi ring, which end at about 98 points.
  public static let statusRailClearance: CGFloat = 112
  /// The clock and Wi-Fi sit this far inward of the rail's centre (measured at 48
  /// points from the edge of the 84-point rail).
  public static let statusRailCenterOffset: CGFloat = 6
  /// Narrower trailing regions are a landscape phone's camera housing, not a rail.
  public static let statusRailMinWidth: CGFloat = 70
  /// The longest a machine's name runs in a thread header before it ends in an ellipsis.
  public static let machineNameMaxWidth: CGFloat = 120
}

public extension EdgeInsets {
  /// A status rail: a region on one side only and no top inset. A landscape
  /// phone reports both sides, so it does not count.
  var hasStatusRail: Bool { top == 0 && (leading > 0) != (trailing > 0) }
}
