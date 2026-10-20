import type { RuntimeMode } from "@specweave-studio/contracts";
import type { ComponentType, SVGProps } from "react";

import {
  AutoAcceptEditsAccessGlyph,
  AutoAccessGlyph,
  FullAccessGlyph,
  SupervisedAccessGlyph,
} from "./AccessGlyph";

export type RuntimeModeIcon = ComponentType<SVGProps<SVGSVGElement>>;

export const runtimeModeConfig: Record<
  RuntimeMode,
  { label: string; description: string; icon: RuntimeModeIcon }
> = {
  "approval-required": {
    label: "Supervised",
    description: "Ask before commands and file changes.",
    icon: SupervisedAccessGlyph,
  },
  "auto-accept-edits": {
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
    icon: AutoAcceptEditsAccessGlyph,
  },
  auto: {
    label: "Auto",
    description: "Supported providers approve routine actions; others still ask.",
    icon: AutoAccessGlyph,
  },
  "full-access": {
    label: "Full access",
    description: "Allow commands and edits without prompts.",
    icon: FullAccessGlyph,
  },
};

export const runtimeModeOptions = Object.keys(runtimeModeConfig) as RuntimeMode[];
