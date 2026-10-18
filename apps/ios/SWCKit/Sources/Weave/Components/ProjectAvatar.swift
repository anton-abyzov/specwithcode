import SwiftUI

/// A project's icon: an SF Symbol (or a Lucide name mapped to one), an emoji or
/// a monogram, on a tinted tile or bare.
public struct ProjectAvatar: View {
  public enum Icon: Hashable, Sendable {
    /// A Lucide icon name from SpecWithCode ("concierge-bell") and a tint name or hex.
    case lucide(name: String, tint: String?)
    /// An SF Symbol name and a tint name or hex.
    case symbol(systemName: String, tint: String?)
    case emoji(String)
    /// Up to two letters are shown.
    case monogram(String, tint: String?)
    /// Shows a folder.
    case none
  }

  public enum Style: Sendable {
    /// Glyph on a softly tinted rounded tile.
    case tile
    /// Colored glyph only, for drawer rows.
    case plain
  }

  let icon: Icon
  let title: String
  let size: CGFloat
  let style: Style

  /// - Parameters:
  ///   - title: The project name, used for the accessibility label and the
  ///     monogram fallback.
  ///   - size: Tile side in points (27 in the title capsule, 31 in settings).
  public init(icon: Icon, title: String, size: CGFloat = 28, style: Style = .tile) {
    self.icon = icon
    self.title = title
    self.size = size
    self.style = style
  }

  public var body: some View {
    content
      .frame(width: size, height: size)
      .background {
        if style == .tile {
          RoundedRectangle(cornerRadius: size * 0.3, style: .continuous)
            .fill(tint.opacity(0.14))
        }
      }
      .accessibilityElement(children: .ignore)
      .accessibilityLabel(title)
  }

  @ViewBuilder private var content: some View {
    switch icon {
    case let .lucide(name, _):
      glyph(WeaveLucide.systemName(for: name))
    case let .symbol(systemName, _):
      glyph(systemName)
    case let .emoji(emoji):
      Text(emoji)
        .font(.system(size: size * (style == .tile ? 0.6 : 0.8)))
    case let .monogram(text, _):
      Text(Self.monogram(text.isEmpty ? title : text))
        .font(.system(size: size * 0.42, weight: .semibold, design: .rounded))
        .foregroundStyle(tint)
        .minimumScaleFactor(0.6)
    case .none:
      glyph("folder")
    }
  }

  private func glyph(_ systemName: String) -> some View {
    Image(systemName: systemName)
      .font(.system(size: size * (style == .tile ? 0.52 : 0.72), weight: .regular))
      .foregroundStyle(tint)
  }

  private var tint: Color {
    switch icon {
    case let .lucide(_, tint), let .symbol(_, tint), let .monogram(_, tint): WeaveTint.color(tint)
    case .emoji, .none: .weave.muted
    }
  }

  static func monogram(_ text: String) -> String {
    let words = text.split(whereSeparator: { $0 == " " || $0 == "-" || $0 == "_" })
    let letters = words.count >= 2 ? words.prefix(2).compactMap(\.first).map(String.init).joined() : String(text.prefix(2))
    return letters.uppercased()
  }
}

/// Maps the Lucide icon names SpecWithCode stores for projects to SF Symbols.
public nonisolated enum WeaveLucide {
  /// Aide's glyph. SpecWithCode stores Aide's icon as Lucide "concierge-bell";
  /// SF Symbols has no concierge bell, and a plain bell reads as notifications,
  /// so the personal assistant gets a person with a check instead.
  public static let assistantSystemName = "person.crop.circle.badge.checkmark"

  /// The SF Symbol for a Lucide name; "folder" when there is no close match.
  public static func systemName(for lucideName: String) -> String {
    map[lucideName.lowercased()] ?? "folder"
  }

  /// Every mapped Lucide name.
  public static var knownNames: [String] { map.keys.sorted() }

  private static let map: [String: String] = [
    // Code and infrastructure
    "folder-code": "folder", "folder": "folder", "folder-open": "folder", "folder-git-2": "folder",
    "code": "chevron.left.forwardslash.chevron.right", "code-xml": "chevron.left.forwardslash.chevron.right",
    "braces": "curlybraces", "terminal": "terminal", "square-terminal": "apple.terminal",
    "file-code": "doc.text", "git-branch": "arrow.triangle.branch", "git-merge": "arrow.triangle.merge",
    "git-pull-request": "arrow.triangle.pull", "github": "chevron.left.forwardslash.chevron.right",
    "gitlab": "chevron.left.forwardslash.chevron.right", "bug": "ladybug", "cpu": "cpu", "binary": "number",
    "regex": "asterisk", "variable": "x.squareroot", "webhook": "link", "plug": "powerplug",
    "puzzle": "puzzlepiece", "blocks": "square.grid.2x2", "boxes": "shippingbox", "box": "shippingbox",
    "package": "shippingbox", "container": "cube", "layers": "square.3.layers.3d",
    "layout-dashboard": "rectangle.3.group", "layout-grid": "square.grid.2x2", "component": "square.on.square",
    "workflow": "point.3.connected.trianglepath.dotted", "network": "network", "server": "server.rack",
    "server-cog": "server.rack", "database": "cylinder.split.1x2", "hard-drive": "internaldrive",
    "cloud": "cloud", "cloud-cog": "cloud", "globe": "globe", "earth": "globe.americas", "wifi": "wifi",
    "router": "wifi.router", "monitor": "display", "laptop": "laptopcomputer", "smartphone": "iphone",
    "tablet": "ipad", "watch": "applewatch", "keyboard": "keyboard", "mouse-pointer-2": "cursorarrow",
    "app-window": "macwindow",
    // AI and science
    "bot": "cpu", "sparkles": "sparkles", "brain": "brain", "brain-circuit": "brain.head.profile",
    "wand-sparkles": "wand.and.stars", "atom": "atom", "flask-conical": "flask", "test-tube": "testtube.2",
    "microscope": "magnifyingglass", "dna": "atom", "telescope": "binoculars", "orbit": "atom",
    "rocket": "airplane.departure", "satellite": "antenna.radiowaves.left.and.right",
    // Tools and security
    "wrench": "wrench.adjustable", "hammer": "hammer", "settings": "gearshape",
    "sliders-horizontal": "slider.horizontal.3", "cog": "gearshape", "shield": "shield",
    "shield-check": "checkmark.shield", "lock": "lock", "key-round": "key", "fingerprint": "touchid",
    "scan-eye": "eye", "eye": "eye", "search": "magnifyingglass", "zap": "bolt", "flame": "flame",
    // Writing and data
    "book-open": "book", "book": "book.closed", "notebook-pen": "square.and.pencil", "file-text": "doc.text",
    "files": "doc.on.doc", "scroll-text": "scroll", "newspaper": "newspaper", "clipboard-list": "list.clipboard",
    "list-checks": "checklist", "list-todo": "checklist", "kanban": "rectangle.split.3x1",
    "calendar": "calendar", "clock": "clock", "timer": "timer", "chart-column": "chart.bar",
    "chart-line": "chart.xyaxis.line", "chart-pie": "chart.pie", "trending-up": "chart.line.uptrend.xyaxis",
    "table": "tablecells", "sheet": "tablecells", "presentation": "display",
    // Design and media
    "pen-tool": "pencil.tip", "pencil": "pencil", "palette": "paintpalette", "brush": "paintbrush",
    "image": "photo", "camera": "camera", "film": "film", "clapperboard": "movieclapper",
    "music": "music.note", "headphones": "headphones", "mic": "mic", "radio": "radio",
    "podcast": "dot.radiowaves.left.and.right", "gamepad-2": "gamecontroller", "joystick": "gamecontroller",
    "dices": "dice",
    // Business and people
    "briefcase": "briefcase", "building-2": "building.2", "store": "storefront", "shopping-bag": "bag",
    "shopping-cart": "cart", "credit-card": "creditcard", "wallet": "wallet.bifold", "banknote": "banknote",
    "coins": "dollarsign.circle", "receipt": "receipt", "landmark": "building.columns", "scale": "scalemass",
    "handshake": "person.2", "users": "person.2", "user": "person", "contact": "person.crop.rectangle",
    "mail": "envelope", "inbox": "tray", "send": "paperplane", "message-square": "message",
    "messages-square": "bubble.left.and.bubble.right", "phone": "phone", "bell": "bell",
    "megaphone": "megaphone", "concierge-bell": assistantSystemName,
    // Life and places
    "house": "house", "heart": "heart", "star": "star", "smile": "face.smiling", "coffee": "cup.and.saucer",
    "utensils": "fork.knife", "pizza": "fork.knife", "apple": "leaf", "leaf": "leaf", "sprout": "leaf",
    "tree-pine": "tree", "flower-2": "camera.macro", "sun": "sun.max", "moon": "moon", "cloud-sun": "cloud.sun",
    "snowflake": "snowflake", "mountain": "mountain.2", "waves": "water.waves", "map": "map",
    "map-pin": "mappin", "compass": "safari", "plane": "airplane", "car": "car", "bike": "bicycle",
    "ship": "ferry", "train-front": "tram", "dumbbell": "dumbbell", "trophy": "trophy", "medal": "medal",
    "target": "target", "flag": "flag", "award": "rosette", "gift": "gift", "graduation-cap": "graduationcap",
    "school": "building.columns", "baby": "figure.and.child.holdinghands", "dog": "dog", "cat": "cat",
    "bird": "bird", "fish": "fish", "paw-print": "pawprint", "stethoscope": "stethoscope", "pill": "pills",
    "activity": "waveform.path.ecg", "hospital": "cross.case",
    // Symbols
    "lightbulb": "lightbulb", "gem": "diamond", "crown": "crown", "infinity": "infinity",
    "anchor": "sailboat", "feather": "pencil.tip", "ghost": "theatermasks", "glasses": "eyeglasses",
    "umbrella": "umbrella", "tag": "tag", "bookmark": "bookmark", "archive": "archivebox", "hash": "number",
    "at-sign": "at", "link": "link", "qr-code": "qrcode", "languages": "character.bubble",
    "accessibility": "accessibility", "recycle": "arrow.3.trianglepath", "battery-full": "battery.100",
    "power": "power", "cable": "cable.connector", "satellite-dish": "antenna.radiowaves.left.and.right",
  ]
}

#Preview("Light") {
  ProjectAvatarPreview().weavePreview(.light)
}

#Preview("Dark") {
  ProjectAvatarPreview().weavePreview(.dark)
}

private struct ProjectAvatarPreview: View {
  var body: some View {
    VStack(alignment: .leading, spacing: WeaveSpacing.s4) {
      HStack(spacing: WeaveSpacing.s3) {
        ProjectAvatar(icon: .lucide(name: "concierge-bell", tint: "violet"), title: "Aide")
        ProjectAvatar(icon: .lucide(name: "dna", tint: "amber"), title: "specweave")
        ProjectAvatar(icon: .lucide(name: "globe", tint: "violet"), title: "Site")
        ProjectAvatar(icon: .lucide(name: "wrench", tint: "red"), title: "Tools")
        ProjectAvatar(icon: .lucide(name: "flask-conical", tint: "#9f1239"), title: "Lab")
        ProjectAvatar(icon: .emoji("🚀"), title: "Launch")
        ProjectAvatar(icon: .monogram("vskill", tint: "teal"), title: "vskill")
        ProjectAvatar(icon: .none, title: "Untitled")
      }
      HStack(spacing: WeaveSpacing.s3) {
        ProjectAvatar(icon: .lucide(name: "rocket", tint: "blue"), title: "Rocket", size: 22, style: .plain)
        ProjectAvatar(icon: .lucide(name: "unknown-icon", tint: nil), title: "Fallback", size: 22, style: .plain)
      }
    }
  }
}
