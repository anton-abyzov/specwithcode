import type { ResponseStyle } from "@specweave-studio/contracts";

export type { ResponseStyle };

export const RESPONSE_STYLE_LABELS = {
  concise: "Concise",
  detailed: "Detailed",
} satisfies Record<ResponseStyle, string>;

export const RESPONSE_STYLE_DESCRIPTIONS = {
  concise: "Lead with the result in a few plain sentences",
  detailed: "Explain the steps behind the result",
} satisfies Record<ResponseStyle, string>;
