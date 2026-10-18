import SwiftUI
import SWCSync
import Weave

/// Search over projects and threads, shown in place of the drawer list.
struct DrawerSearchView: View {
  @Binding var isPresented: Bool
  @Environment(AppModel.self) private var model
  @Environment(AppRouter.self) private var router
  @State private var query = ""
  @FocusState private var focused: Bool

  var body: some View {
    let projects = ([model.aide].compactMap(\.self)) + model.projects
    let results = SearchResults(query: query, projects: projects, threads: model.allThreads)
    VStack(spacing: 0) {
      HStack(spacing: WeaveSpacing.s2) {
        HStack(spacing: WeaveSpacing.s2) {
          Image(systemName: "magnifyingglass")
            .font(.system(size: 15, weight: .medium))
            .foregroundStyle(Color.weave.muted)
            .accessibilityHidden(true)
          TextField("Search", text: $query, prompt: .weavePlaceholder("Search"))
            .font(.weave(.body))
            .foregroundStyle(Color.weave.ink)
            .focused($focused)
            .submitLabel(.search)
            .autocorrectionDisabled()
            .accessibilityLabel("Search projects and threads")
          if !query.isEmpty {
            Button {
              query = ""
            } label: {
              Image(systemName: "xmark.circle.fill")
                .foregroundStyle(Color.weave.control)
                .frame(width: WeaveSize.minTap, height: WeaveSize.minTap)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Clear search")
          }
        }
        .padding(.leading, WeaveSpacing.s4)
        .frame(minHeight: WeaveSize.control)
        .weaveGlass(in: Capsule())
        // The whole capsule focuses the field; the Clear button keeps its tap.
        .contentShape(Capsule())
        .onTapGesture { focused = true }
        Button("Cancel") {
          withAnimation(.snappy) { isPresented = false }
        }
        .font(.weave(.body))
        .foregroundStyle(Color.weave.ink)
        .buttonStyle(.plain)
        .frame(minHeight: WeaveSize.minTap)
      }
      .dynamicTypeSize(...DynamicTypeSize.xxxLarge)
      .padding(.horizontal, WeaveSpacing.gutter)
      .padding(.bottom, WeaveSpacing.s2)

      ScrollView {
        VStack(alignment: .leading, spacing: 0) {
          if query.trimmingCharacters(in: .whitespaces).isEmpty {
            hint("Type a project or thread name.")
          } else if results.isEmpty {
            hint("No matches for \u{201C}\(query)\u{201D}.")
          } else {
            if !results.projects.isEmpty {
              DrawerSectionLabel("Projects")
              ForEach(results.projects) { project in
                WeaveRow(project.title, subtitle: project.machineLabel, titleLineLimit: 1, subtitleLineLimit: 1, action: { open(project) }) {
                  ProjectAvatar(icon: project.icon.avatarIcon, title: project.title, size: 24, style: .plain)
                    .frame(width: 28)
                    .accessibilityHidden(true)
                } trailing: {
                  ProjectStatusGlyphs(project: project)
                }
                .accessibilityValue(ProjectStatusGlyphs.spoken(project))
              }
            }
            if !results.threads.isEmpty {
              DrawerSectionLabel("Threads")
              ForEach(results.threads) { thread in
                WeaveRow(thread.title, subtitle: thread.projectTitle ?? thread.machineLabel, titleLineLimit: 1, subtitleLineLimit: 1, action: { router.open(.thread(thread.ref)) }) {
                  WeaveRowSymbol(RecentThreadGlyph.symbol(for: thread), tint: RecentThreadGlyph.tint(for: thread))
                } trailing: {
                  RecentThreadGlyph(thread: thread)
                }
                .accessibilityValue(RecentThreadGlyph.spoken(thread))
              }
            }
          }
        }
        .padding(.bottom, WeaveSpacing.s8)
      }
      .scrollDismissesKeyboard(.interactively)
    }
    .onAppear { focused = true }
  }

  private func hint(_ text: String) -> some View {
    Text(text)
      .weaveFont(.callout)
      .foregroundStyle(Color.weave.muted)
      .padding(.horizontal, WeaveSpacing.s4)
      .padding(.top, WeaveSpacing.s4)
  }

  private func open(_ project: ProjectSummary) {
    router.open(project.kind == .personal ? .aide(project.ref) : .project(project.ref))
  }
}
