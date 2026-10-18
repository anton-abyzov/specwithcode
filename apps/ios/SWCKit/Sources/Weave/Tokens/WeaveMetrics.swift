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
}
