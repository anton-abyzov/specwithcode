#pragma once

#include <react/renderer/components/StudioMarkdownTextSpec/EventEmitters.h>
#include <react/renderer/components/StudioMarkdownTextSpec/Props.h>
#include <react/renderer/components/StudioMarkdownTextSpec/States.h>
#include <react/renderer/components/view/ConcreteViewShadowNode.h>

namespace facebook::react {
extern const char StudioMarkdownTextRunComponentName[];

using StudioMarkdownTextRunShadowNode = ConcreteViewShadowNode<
    StudioMarkdownTextRunComponentName,
    StudioMarkdownTextRunProps,
    StudioMarkdownTextRunEventEmitter,
    StudioMarkdownTextRunState>;
}
