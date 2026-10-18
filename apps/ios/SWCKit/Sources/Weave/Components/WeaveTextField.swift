import SwiftUI

/// A single-line field in a rounded panel card, with an optional label above,
/// an optional leading view (for example a project icon tile) and an optional
/// trailing view (for example a paste or clear button).
public struct WeaveTextField<Leading: View, Trailing: View>: View {
  let placeholder: String
  @Binding var text: String
  let label: String?
  let leading: Leading
  let trailing: Trailing
  let onSubmit: (() -> Void)?

  @FocusState private var focused: Bool

  public init(_ placeholder: String, text: Binding<String>, label: String? = nil, onSubmit: (() -> Void)? = nil, @ViewBuilder leading: () -> Leading, @ViewBuilder trailing: () -> Trailing) {
    self.placeholder = placeholder
    self._text = text
    self.label = label
    self.onSubmit = onSubmit
    self.leading = leading()
    self.trailing = trailing()
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: WeaveSpacing.s2) {
      if let label { FieldLabel(label) }
      HStack(spacing: WeaveSpacing.s3) {
        leading
        TextField(placeholder, text: $text, prompt: Text.weavePlaceholder(placeholder))
          .font(.weave(.body))
          .foregroundStyle(Color.weave.ink)
          .focused($focused)
          .submitLabel(.done)
          .onSubmit { onSubmit?() }
          .accessibilityLabel(label ?? placeholder)
          .fieldTapTarget { focused = true }
        trailing
      }
      .padding(.leading, WeaveSpacing.s4)
      .padding(.trailing, Trailing.self == EmptyView.self ? WeaveSpacing.s4 : WeaveSpacing.s2)
      .frame(minHeight: 56)
      .weaveFieldCard(focused: focused)
      .contentShape(Rectangle())
      .onTapGesture { focused = true }
    }
  }
}

extension WeaveTextField where Trailing == EmptyView {
  public init(_ placeholder: String, text: Binding<String>, label: String? = nil, onSubmit: (() -> Void)? = nil, @ViewBuilder leading: () -> Leading) {
    self.init(placeholder, text: text, label: label, onSubmit: onSubmit, leading: leading) { EmptyView() }
  }
}

extension WeaveTextField where Leading == EmptyView, Trailing == EmptyView {
  public init(_ placeholder: String, text: Binding<String>, label: String? = nil, onSubmit: (() -> Void)? = nil) {
    self.init(placeholder, text: text, label: label, onSubmit: onSubmit, leading: { EmptyView() }, trailing: { EmptyView() })
  }
}

/// A multiline field in a rounded panel card. Grows from `minLines` to
/// `maxLines`, then scrolls. With `characterLimit` it shows a counter.
public struct WeaveTextEditor: View {
  let placeholder: String
  @Binding var text: String
  let label: String?
  let minLines: Int
  let maxLines: Int
  let characterLimit: Int?
  let font: WeaveFont

  @FocusState private var focused: Bool

  public init(_ placeholder: String, text: Binding<String>, label: String? = nil, minLines: Int = 3, maxLines: Int = 12, characterLimit: Int? = nil, font: WeaveFont = .body) {
    self.placeholder = placeholder
    self._text = text
    self.label = label
    self.minLines = minLines
    self.maxLines = max(minLines, maxLines)
    self.characterLimit = characterLimit
    self.font = font
  }

  public var body: some View {
    VStack(alignment: .leading, spacing: WeaveSpacing.s2) {
      if let label { FieldLabel(label) }
      TextField(placeholder, text: $text, prompt: Text.weavePlaceholder(placeholder), axis: .vertical)
        .weaveFont(font)
        .foregroundStyle(Color.weave.ink)
        .lineLimit(minLines...maxLines)
        .focused($focused)
        .accessibilityLabel(label ?? placeholder)
        .padding(.horizontal, WeaveSpacing.s4)
        .padding(.vertical, WeaveSpacing.s3 + 2)
        .frame(maxWidth: .infinity, alignment: .topLeading)
        .weaveFieldCard(focused: focused)
        .contentShape(Rectangle())
        .onTapGesture { focused = true }
      if let characterLimit {
        let over = text.count > characterLimit
        Text("\(text.count.formatted())/\(characterLimit.formatted())")
          .font(.weave(.caption))
          .monospacedDigit()
          .foregroundStyle(over ? Color.weave.fail : Color.weave.muted)
          .frame(maxWidth: .infinity, alignment: .trailing)
          .padding(.horizontal, WeaveSpacing.s4)
          .accessibilityLabel(over ? "\(text.count - characterLimit) characters over the limit" : "\(characterLimit - text.count) characters left")
      }
    }
  }
}

extension Text {
  /// Placeholder text in the control color: quieter than muted text, still
  /// readable (at least 3:1 on the panel and on glass).
  public static func weavePlaceholder(_ text: String) -> Text {
    Text(text).foregroundStyle(Color.weave.control)
  }
}

extension View {
  /// Gives a text field a tap target at least 44 pt tall that focuses it.
  /// A single-line field alone inside a tap target takes that target's frame
  /// for accessibility; on its own it is only as tall as one line of text.
  fileprivate func fieldTapTarget(focus: @escaping () -> Void) -> some View {
    frame(maxWidth: .infinity, minHeight: WeaveSize.minTap, alignment: .leading)
      .contentShape(Rectangle())
      .onTapGesture(perform: focus)
  }

  fileprivate func weaveFieldCard(focused: Bool) -> some View {
    background(Color.weave.panel, in: RoundedRectangle(cornerRadius: WeaveRadius.card, style: .continuous))
      .overlay(
        RoundedRectangle(cornerRadius: WeaveRadius.card, style: .continuous)
          .strokeBorder(focused ? Color.weave.iris : Color.weave.line, lineWidth: focused ? 1.5 : WeaveSize.hairline)
      )
      .animation(.easeOut(duration: 0.12), value: focused)
  }
}

#Preview("Light") {
  WeaveTextFieldPreview().weavePreview(.light)
}

#Preview("Dark") {
  WeaveTextFieldPreview().weavePreview(.dark)
}

private struct WeaveTextFieldPreview: View {
  @State private var name = "specweave"
  @State private var goal = "Plan the work in a spec, let any agent do it, and keep the record in git."
  @State private var empty = ""

  var body: some View {
    VStack(spacing: WeaveSpacing.s6) {
      WeaveTextField("Project name", text: $name, label: "Name") {
        ProjectAvatar(icon: .lucide(name: "dna", tint: "amber"), title: name, size: 31)
      }
      WeaveTextEditor("What should this project achieve?", text: $goal, label: "Goal", characterLimit: 8000)
      WeaveTextField("Optional", text: $empty, label: "Context (optional)")
    }
  }
}
