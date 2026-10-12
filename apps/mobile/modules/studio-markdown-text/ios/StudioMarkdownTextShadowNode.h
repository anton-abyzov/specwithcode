#pragma once

#include <react/renderer/components/StudioMarkdownTextSpec/EventEmitters.h>
#include <react/renderer/components/StudioMarkdownTextSpec/Props.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>
#include <react/renderer/textlayoutmanager/TextLayoutManager.h>
#include <react/renderer/core/LayoutContext.h>
#include <react/renderer/core/ShadowNode.h>

#include <string>
#include <vector>

namespace facebook::react {

extern const char StudioMarkdownTextComponentName[];

struct StudioMarkdownTextParagraphStyleRange {
  size_t location;
  size_t length;
  Float firstLineHeadIndent;
  Float headIndent;
  Float paragraphSpacing;
};

struct StudioMarkdownTextAttachmentRange {
  size_t location;
  size_t length;
  std::string imageUri;
  /// Recolor the loaded image with the run's foreground color, like `sf:` symbols.
  bool tintWithForeground;
  Float chipWidth = 0;
  Float chipHeight = 0;
};

inline Float StudioMarkdownTextAttachmentSize(const StudioMarkdownTextAttachmentRange &) {
  return 14;
}

inline Float StudioMarkdownTextAttachmentBaselineOffset(
    const StudioMarkdownTextAttachmentRange &) {
  return -2;
}

class StudioMarkdownTextStateReal final {
 public:
  AttributedString attributedString;
  std::vector<StudioMarkdownTextParagraphStyleRange> paragraphStyleRanges;
  std::vector<StudioMarkdownTextAttachmentRange> attachmentRanges;
};

class StudioMarkdownTextShadowNode final : public ConcreteViewShadowNode<
StudioMarkdownTextComponentName,
StudioMarkdownTextProps,
StudioMarkdownTextEventEmitter,
StudioMarkdownTextStateReal> {
public:
  using ConcreteViewShadowNode::ConcreteViewShadowNode;

  StudioMarkdownTextShadowNode(
   const ShadowNode& sourceShadowNode,
   const ShadowNodeFragment& fragment
  );

  static ShadowNodeTraits BaseTraits() {
    auto traits = ConcreteViewShadowNode::BaseTraits();
    traits.set(ShadowNodeTraits::Trait::LeafYogaNode);
    traits.set(ShadowNodeTraits::Trait::MeasurableYogaNode);
    return traits;
  }

  void layout(LayoutContext layoutContext) override;

  Size measureContent(
      const LayoutContext& layoutContext,
      const LayoutConstraints& layoutConstraints) const override;

private:
  mutable AttributedString _attributedString;
  mutable std::vector<StudioMarkdownTextParagraphStyleRange> _paragraphStyleRanges;
  mutable std::vector<StudioMarkdownTextAttachmentRange> _attachmentRanges;
};
} // namespace facebook::React
