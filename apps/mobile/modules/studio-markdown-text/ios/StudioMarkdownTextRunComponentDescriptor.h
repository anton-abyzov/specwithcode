#pragma once

#include "StudioMarkdownTextRunShadowNode.h"

#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>

namespace facebook::react {
using StudioMarkdownTextRunComponentDescriptor = ConcreteComponentDescriptor<StudioMarkdownTextRunShadowNode>;

void StudioMarkdownTextRunSpec_registerComponentDescriptorsFromCodegen(
  std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
}
