import SwiftUI
import SWCSync
import Weave

/// Chooses a project's icon: initials, a glyph or an emoji, in one of the
/// project palette colors. Uses the same Lucide names the desktop stores, so
/// the choice looks the same on every device.
struct ProjectIconPicker: View {
  let title: String
  let onPick: (ProjectIcon) -> Void

  @Environment(\.dismiss) private var dismiss
  @State private var icon: ProjectIcon
  @State private var color: String

  init(title: String, current: ProjectIcon, onPick: @escaping (ProjectIcon) -> Void) {
    self.title = title
    self.onPick = onPick
    _icon = State(initialValue: current)
    _color = State(initialValue: Self.color(of: current) ?? ProjectAvatar.tintName(for: title))
  }

  static let colors = ["indigo", "violet", "fuchsia", "rose", "orange", "amber", "emerald", "teal", "sky", "gray"]

  static let glyphs = [
    "code", "terminal", "sparkles", "cpu", "globe", "server", "network", "wand-sparkles",
    "database", "cloud", "smartphone", "laptop", "layers", "blocks", "package", "workflow",
    "flask-conical", "atom", "wrench", "shield-check", "zap", "flame", "book-open", "notebook-pen",
    "chart-line", "kanban", "palette", "film", "music", "gamepad-2", "briefcase", "store",
    "trophy", "target", "heart", "house", "leaf", "map", "plane", "dumbbell",
  ]

  static let emoji = ["🚀", "⚡️", "🧪", "🛠️", "🎯", "🏆", "📚", "🎨", "🎬", "🎵", "⚽️", "🌱", "🏠", "💡", "🔥", "✨"]

  var body: some View {
    ScrollView {
      VStack(alignment: .leading, spacing: WeaveSpacing.s6) {
        ProjectAvatar(icon: preview.avatarIcon, title: title, size: 72)
          .frame(maxWidth: .infinity)
          .padding(.top, WeaveSpacing.s2)
          .animation(.spring(duration: 0.3, bounce: 0.2), value: preview)

        section("Color") {
          HStack(spacing: WeaveSpacing.s2) {
            ForEach(Self.colors, id: \.self) { name in
              Button {
                color = name
                icon = Self.recolor(icon, to: name)
              } label: {
                Circle()
                  .fill(WeaveTint.color(name))
                  .frame(width: 26, height: 26)
                  .overlay {
                    if color == name {
                      Circle().strokeBorder(Color.weave.canvas, lineWidth: 2).padding(2)
                    }
                  }
                  .frame(maxWidth: .infinity, minHeight: WeaveSize.minTap)
                  .contentShape(Rectangle())
              }
              .buttonStyle(.plain)
              .accessibilityLabel(name.capitalized)
              .accessibilityAddTraits(color == name ? .isSelected : [])
            }
          }
          .disabled(isEmoji)
          .opacity(isEmoji ? 0.4 : 1)
        }

        section("Icon") {
          LazyVGrid(columns: columns, spacing: WeaveSpacing.s2) {
            cell(.monogram(text: "", color: color), label: "Initials")
            ForEach(Self.glyphs, id: \.self) { name in
              cell(.symbol(name: name, color: color), label: name.replacingOccurrences(of: "-", with: " "))
            }
          }
        }

        section("Emoji") {
          LazyVGrid(columns: columns, spacing: WeaveSpacing.s2) {
            ForEach(Self.emoji, id: \.self) { value in
              cell(.emoji(value), label: value)
            }
          }
        }
      }
      .padding(.horizontal, WeaveSpacing.gutter)
      .padding(.bottom, WeaveSpacing.s8)
    }
    .screenChrome {
      ScreenHeader {
        WeaveIconButton("xmark", label: "Cancel") { dismiss() }
      } center: {
        HeaderTitle(title: "Icon")
      } trailing: {
        WeaveIconButton("checkmark", label: "Use icon", style: .filled) {
          onPick(preview)
          dismiss()
        }
        .accessibilityIdentifier("icon.use")
      }
    }
    .sensoryFeedback(.selection, trigger: preview)
  }

  private var columns: [GridItem] { [GridItem(.adaptive(minimum: 48, maximum: 64), spacing: WeaveSpacing.s2)] }

  private var isEmoji: Bool {
    if case .emoji = icon { return true }
    return false
  }

  /// Initials without text use the project name.
  private var preview: ProjectIcon {
    // The server keeps at most two characters of a monogram.
    if case let .monogram(text, tint) = icon, text.isEmpty { return .monogram(text: ProjectAvatar.identityMonogram(title), color: tint) }
    return icon
  }

  private func section(_ title: String, @ViewBuilder content: () -> some View) -> some View {
    VStack(alignment: .leading, spacing: WeaveSpacing.s2) {
      Text(title)
        .font(.weave(.footnote, weight: .semibold))
        .foregroundStyle(Color.weave.muted)
      content()
    }
  }

  private func cell(_ option: ProjectIcon, label: String) -> some View {
    let selected = Self.sameShape(option, icon)
    let shown: ProjectIcon = if case .monogram = option { .monogram(text: ProjectAvatar.identityMonogram(title), color: color) } else { option }
    return Button { icon = option } label: {
      ProjectAvatar(icon: shown.avatarIcon, title: title, size: 36)
        .frame(maxWidth: .infinity, minHeight: 52)
        .background(
          RoundedRectangle(cornerRadius: WeaveRadius.md, style: .continuous)
            .fill(selected ? Color.weave.iris.opacity(0.12) : Color.clear)
        )
        .overlay(
          RoundedRectangle(cornerRadius: WeaveRadius.md, style: .continuous)
            .strokeBorder(selected ? Color.weave.iris : Color.clear, lineWidth: 1.5)
        )
        .contentShape(Rectangle())
    }
    .buttonStyle(PressableStyle())
    .accessibilityLabel(label)
    .accessibilityAddTraits(selected ? .isSelected : [])
  }

  static func color(of icon: ProjectIcon) -> String? {
    switch icon {
    case let .symbol(_, color), let .monogram(_, color): color
    case .emoji, .none: nil
    }
  }

  static func recolor(_ icon: ProjectIcon, to color: String) -> ProjectIcon {
    switch icon {
    case let .symbol(name, _): .symbol(name: name, color: color)
    case let .monogram(text, _): .monogram(text: text, color: color)
    case .none: .monogram(text: "", color: color)
    case .emoji: icon
    }
  }

  /// Same glyph or emoji, whatever the color; any initials match initials.
  static func sameShape(_ a: ProjectIcon, _ b: ProjectIcon) -> Bool {
    switch (a, b) {
    case let (.symbol(x, _), .symbol(y, _)): x == y
    case let (.emoji(x), .emoji(y)): x == y
    case (.monogram, .monogram), (.monogram, .none): true
    default: false
    }
  }
}
