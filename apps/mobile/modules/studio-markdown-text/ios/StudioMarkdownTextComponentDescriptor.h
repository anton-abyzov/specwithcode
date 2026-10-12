#pragma once

#include "StudioMarkdownTextShadowNode.h"

#include <react/renderer/core/ConcreteComponentDescriptor.h>
#include <react/renderer/componentregistry/ComponentDescriptorProviderRegistry.h>

namespace facebook::react {
using StudioMarkdownTextComponentDescriptor = ConcreteComponentDescriptor<StudioMarkdownTextShadowNode>;

void StudioMarkdownTextSpec_registerComponentDescriptorsFromCodegen(
  std::shared_ptr<const ComponentDescriptorProviderRegistry> registry);
}
