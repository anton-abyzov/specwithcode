import type { SVGProps } from "react";
import { GITHUB_COPILOT_ICON_PATHS } from "@specweave-studio/contracts";

export function GitHubCopilotIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      data-provider-icon="github-copilot"
      {...props}
    >
      {GITHUB_COPILOT_ICON_PATHS.map((d, index) => (
        <path key={index} d={d} />
      ))}
    </svg>
  );
}
