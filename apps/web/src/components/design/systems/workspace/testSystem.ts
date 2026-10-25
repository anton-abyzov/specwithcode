/**
 * A small synthetic design system ("Harbor UI", a fictional marina app) for
 * the workspace's component tests. Only tests import it.
 */
import type { DesignSystem, DesignSystemId, DesignToken } from "@specweave-studio/contracts";

const provenance = { source: "file" as const, location: "ui/tokens.css", extractor: "css@1" };

export function testToken(
  name: string,
  type: DesignToken["type"],
  group: string | undefined,
  light: string,
  dark?: string,
  description?: string,
): DesignToken {
  const values: Record<string, DesignToken["values"][string]> = {
    light: { raw: light, resolved: light.startsWith("{") ? null : light, provenance },
  };
  if (dark !== undefined) values.dark = { raw: dark, resolved: dark, provenance };
  return {
    name,
    type,
    ...(group !== undefined ? { group } : {}),
    values,
    ...(description !== undefined ? { description } : {}),
  };
}

export const TEST_SYSTEM: DesignSystem = {
  schema: "swc.design-system/1",
  id: "s_harbor000001" as DesignSystemId,
  name: "Harbor UI",
  description: "Calm tables and one indigo brand color.",
  revision: 7,
  createdAt: "2026-10-21T09:00:00.000Z",
  updatedAt: "2026-10-23T21:40:00.000Z",
  modes: [
    { id: "light", name: "Light" },
    { id: "dark", name: "Dark" },
  ],
  tokens: [
    testToken("color-ground", "color", "color", "#fafafa", "#12161c"),
    testToken("color-surface", "color", "color", "#ffffff", "#1a1f27"),
    testToken("color-ink", "color", "color", "#22263b", "#f4f6f8", "Body text."),
    testToken("color-brand", "color", "color", "#595ecc", "#7d84ff"),
    testToken("color-scrim", "color", "color", "rgba(15, 20, 30, 0.52)"),
    testToken("color-link", "color", "color", "{color-brand}"),
    testToken("tide-high", "color", "tide", "#0e7490", "#22d3ee"),
    testToken("tide-low", "color", "tide", "#a16207", "#facc15"),
    testToken("sig", "color", "color", "#e11d48", "#fb7185"),
    testToken("font-sans", "fontFamily", "type", '"Inter Variable", system-ui, sans-serif'),
    testToken("type-body", "typography", "type", "400 15px/1.5 var(--font-sans)"),
    testToken(
      "type-kicker",
      "typography",
      "type",
      "600 11px/1.35 var(--font-sans)",
      undefined,
      "The only uppercase label. Letter spacing 0.06em.",
    ),
    testToken("space-1", "dimension", "spacing", "4px"),
    testToken("space-2", "dimension", "spacing", "8px"),
    testToken("radius-md", "dimension", "radius", "8px"),
    testToken(
      "shadow-card",
      "shadow",
      "shadow",
      "0 1px 2px rgba(15, 23, 42, 0.08)",
      "0 1px 2px rgba(0, 0, 0, 0.6)",
    ),
    testToken("duration-micro", "duration", "duration", "120ms"),
    testToken("ease-standard", "easing", "easing", "cubic-bezier(0.2, 0, 0, 1)"),
    testToken("bp-sm", "dimension", "breakpoint", "40rem"),
    testToken("z-float", "number", "zIndex", "30"),
    testToken("size-tap", "dimension", "control", "44px"),
    testToken("noise-opacity", "number", "opacity", "0.05"),
    testToken("tracking-wide", "other", "letterCase", "0.06em"),
  ],
  components: [
    {
      id: "button",
      name: "Button",
      framework: "react",
      importPath: "@harbor/ui",
      previewHtml:
        '<button style="background:var(--color-brand);color:#fff;border-radius:var(--radius-md)">Book</button>',
      provenance,
    },
    { id: "tide-chart", name: "TideChart", framework: "react", provenance },
  ],
  sources: [{ kind: "file", location: "ui/tokens.css", readAt: "2026-10-21T09:00:00.000Z" }],
  copiedFrom: null,
};
