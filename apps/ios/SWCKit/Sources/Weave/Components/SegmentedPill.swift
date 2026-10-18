import SwiftUI

/// A capsule segmented control, for example Threads / Library / PRs.
public struct SegmentedPill<Value: Hashable>: View {
  @Binding var selection: Value
  let options: [(value: Value, label: String)]

  @Namespace private var namespace

  public init(selection: Binding<Value>, options: [(value: Value, label: String)]) {
    self._selection = selection
    self.options = options
  }

  public var body: some View {
    HStack(spacing: 0) {
      ForEach(options.indices, id: \.self) { index in
        let option = options[index]
        let isSelected = option.value == selection
        Button {
          withAnimation(.snappy(duration: 0.25)) { selection = option.value }
        } label: {
          Text(option.label)
            .font(.weave(.callout, weight: isSelected ? .semibold : .regular))
            .foregroundStyle(isSelected ? Color.weave.ink : Color.weave.muted)
            .lineLimit(1)
            .padding(.horizontal, WeaveSpacing.s4)
            .frame(maxWidth: .infinity, minHeight: 35)
            .background {
              if isSelected {
                Capsule()
                  .fill(Color.weave.panel)
                  .shadow(color: .black.opacity(0.08), radius: 3, y: 1)
                  .matchedGeometryEffect(id: "selection", in: namespace)
              }
            }
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
      }
    }
    .padding(3)
    .background(Color.weave.sunken, in: Capsule())
    .frame(minHeight: WeaveSize.minTap)
  }
}

#Preview("Light") {
  SegmentedPillPreview().weavePreview(.light)
}

#Preview("Dark") {
  SegmentedPillPreview().weavePreview(.dark)
}

private struct SegmentedPillPreview: View {
  @State private var tab = "threads"

  var body: some View {
    SegmentedPill(selection: $tab, options: [("threads", "Threads"), ("library", "Library"), ("prs", "PRs")])
      .frame(maxWidth: 260)
  }
}
