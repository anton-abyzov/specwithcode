import SwiftUI
import Weave
import SWCSync

/// The thread's model picker: a sheet instead of menus inside menus. The
/// model the next message runs on and its family come first, then recent
/// picks, then every provider on the thread's machine, with one search over
/// all of them. A list keeps its place while the chat behind it updates.
struct ModelPickerSheet: View {
  let models: [ModelChoice]
  let selectedId: String?
  /// The machine whose providers these are ("m4").
  var machine: String?
  let onPick: (ModelChoice) -> Void

  @Environment(\.dismiss) private var dismiss
  @State private var query = ""
  /// Providers the person opened or closed; the picked model's starts open.
  @State private var toggled: Set<String> = []
  @AppStorage(AppDefaults.recentModels) private var recentModels = ""

  private var recentIds: [String] { recentModels.split(separator: "\n").map(String.init) }

  var body: some View {
    let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
    NavigationStack {
      List {
        if trimmed.isEmpty {
          sections(ModelPicker.layout(models, selectedId: selectedId, recentIds: recentIds))
        } else {
          results(ModelPicker.search(trimmed, in: models, selectedId: selectedId), query: trimmed)
        }
      }
      .searchable(text: $query, placement: searchPlacement, prompt: "Search models and providers")
      .autocorrectionDisabled()
      #if os(iOS)
      .textInputAutocapitalization(.never)
      .navigationBarTitleDisplayMode(.inline)
      #endif
      .navigationTitle("Model")
      .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
    }
    .presentationDragIndicator(.visible)
    .accessibilityIdentifier("model-picker")
  }

  private var searchPlacement: SearchFieldPlacement {
    #if os(iOS)
    .navigationBarDrawer(displayMode: .always)
    #else
    .automatic
    #endif
  }

  // MARK: Sections

  @ViewBuilder private func sections(_ layout: ModelPicker.Layout) -> some View {
    if !layout.family.isEmpty {
      Section {
        ForEach(layout.family) { row($0, section: "family", showsProvider: true) }
      } header: {
        Text(layout.familyTitle.map { "\($0) family" } ?? "Current model")
      } footer: {
        Text("Applies from your next message.")
      }
    }
    if !layout.recent.isEmpty {
      Section("Recent") {
        ForEach(layout.recent) { row($0, section: "recent", showsProvider: true) }
      }
    }
    Section {
      ForEach(layout.providers) { group in
        let home = group.models.contains { $0.id == selectedId }
        // Open by default: the picked model's provider, and the only provider.
        let opensByDefault = home || layout.providers.count == 1
        DisclosureGroup(isExpanded: Binding(
          get: { toggled.contains(group.id) != opensByDefault },
          set: { open in
            if open == opensByDefault { toggled.remove(group.id) } else { toggled.insert(group.id) }
          }
        )) {
          ForEach(group.models) { row($0, section: group.id, showsProvider: false) }
        } label: {
          HStack(spacing: WeaveSpacing.s3) {
            ProviderMark(group.brand, size: 22)
            Text(group.provider)
              .weaveFont(.body, weight: .medium)
              .foregroundStyle(Color.weave.ink)
            Spacer(minLength: WeaveSpacing.s2)
            Text("\(group.models.count)")
              .weaveFont(.callout)
              .foregroundStyle(Color.weave.muted)
              .monospacedDigit()
          }
          .frame(minHeight: WeaveSize.minTap - 16)
          .accessibilityElement(children: .ignore)
          .accessibilityLabel("\(group.provider), \(group.models.count == 1 ? "1 model" : "\(group.models.count) models")")
          .accessibilityAddTraits(.isButton)
          .accessibilityIdentifier("model-picker.provider.\(group.id)")
        }
      }
    } header: {
      Text(machine.map { "Providers on \($0)" } ?? "Providers")
    }
  }

  @ViewBuilder private func results(_ found: ModelPicker.SearchResult, query: String) -> some View {
    if found.matches.isEmpty {
      Section {
        VStack(spacing: WeaveSpacing.s2) {
          Image(systemName: "magnifyingglass")
            .font(.system(size: 28, weight: .regular))
            .foregroundStyle(Color.weave.muted)
            .accessibilityHidden(true)
          Text("No models match \u{201C}\(query)\u{201D}")
            .weaveFont(.body, weight: .medium)
            .foregroundStyle(Color.weave.ink)
          Text(machine.map { "Only models that are ready on \($0) are listed." } ?? "Only models that are ready on this thread's machine are listed.")
            .weaveFont(.callout)
            .foregroundStyle(Color.weave.muted)
            .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, WeaveSpacing.s6)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("model-picker.empty")
      }
    } else {
      Section {
        ForEach(found.matches) { row($0, section: "search", showsProvider: true, words: found.words) }
      } header: {
        Text(Self.resultsTitle(found))
      }
    }
  }

  /// "Closest matches", "3 models", or "Fast · 3 models".
  static func resultsTitle(_ found: ModelPicker.SearchResult) -> String {
    let count = found.matches.count == 1 ? "1 model" : "\(found.matches.count) models"
    if found.isClosest { return "No exact match. Closest: \(count)" }
    return (found.filters + [count]).joined(separator: " · ")
  }

  // MARK: Rows

  private func row(_ choice: ModelChoice, section: String, showsProvider: Bool, words: [String] = []) -> some View {
    let isSelected = choice.id == selectedId
    return Button {
      recentModels = ModelPicker.remembering(choice.id, in: recentIds).joined(separator: "\n")
      onPick(choice)
      dismiss()
    } label: {
      HStack(spacing: WeaveSpacing.s3) {
        if showsProvider { ProviderMark(choice.brand, size: 22) }
        let name = Text(Self.highlighted(choice.name, words: words, in: .body))
          .weaveFont(.body)
          .foregroundStyle(Color.weave.ink)
        if showsProvider {
          let provider = Text(Self.highlighted(choice.provider, words: words, in: .callout))
            .weaveFont(.callout)
            .foregroundStyle(Color.weave.muted)
          // One line when both fit; a long provider name goes under the model.
          ViewThatFits(in: .horizontal) {
            HStack(spacing: WeaveSpacing.s2) {
              name.lineLimit(1)
              Spacer(minLength: WeaveSpacing.s2)
              provider.lineLimit(1)
            }
            VStack(alignment: .leading, spacing: 2) {
              name
              provider
            }
            .frame(maxWidth: .infinity, alignment: .leading)
          }
        } else {
          name
          Spacer(minLength: WeaveSpacing.s2)
        }
        if isSelected {
          Image(systemName: "checkmark")
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(Color.weave.iris)
            .accessibilityHidden(true)
        }
      }
      .frame(minHeight: WeaveSize.minTap - 16)
      .contentShape(Rectangle())
    }
    .buttonStyle(.plain)
    .id("\(section)/\(choice.id)")
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(showsProvider ? "\(choice.name), \(choice.provider)" : choice.name)
    .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
    .accessibilityIdentifier("model-picker.\(section).\(choice.id)")
  }

  /// The text with the parts a search matched in semibold.
  static func highlighted(_ text: String, words: [String], in role: WeaveFont) -> AttributedString {
    var attributed = AttributedString(text)
    for range in ModelPicker.highlights(in: text, words: words) {
      guard let lower = AttributedString.Index(range.lowerBound, within: attributed),
            let upper = AttributedString.Index(range.upperBound, within: attributed) else { continue }
      attributed[lower..<upper].font = .weave(role, weight: .bold)
      attributed[lower..<upper].foregroundColor = Color.weave.iris
    }
    return attributed
  }
}
