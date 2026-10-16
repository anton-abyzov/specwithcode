import type { SVGProps } from "react";
import {
  GITHUB_COPILOT_ICON_PATHS,
  GITHUB_COPILOT_ICON_VIEW_BOX,
} from "@specweave-studio/contracts";

/** The one Copilot glyph in the web app; every Copilot surface renders it. */
export function GitHubCopilotIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox={GITHUB_COPILOT_ICON_VIEW_BOX}
      fill="currentColor"
      aria-hidden="true"
      data-provider-icon="github-copilot"
      {...props}
    >
      {GITHUB_COPILOT_ICON_PATHS.map((d) => (
        <path key={d} d={d} fillRule="evenodd" clipRule="evenodd" />
      ))}
    </svg>
  );
}
