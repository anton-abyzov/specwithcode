// Synthetic design system for the 1046 fixture: a fictional marina booking app
// ("Harbor") shaped like a real component library, with light and dark modes.
import type {
  DesignId,
  DesignSummary,
  DesignSystem,
  DesignSystemFile,
  DesignSystemId,
  DesignToken,
  EnvironmentId,
  ProjectId,
  ThreadId,
} from "@specweave-studio/contracts";

// The app's own marketing font, read into the fixture as a stored brand font.
import dmSansDataUrl from "../../../marketing/src/assets/fonts/dm-sans-latin.woff2?inline";

export const ENVIRONMENT = "env-fixture" as EnvironmentId;
export const PROJECT = "harbor-app" as ProjectId;
export const SYSTEM_ID = "s_harborkit01" as DesignSystemId;
export const UPDATED_AT = "2026-10-23T21:40:00.000Z";

const provenance = (location: string, line: number) => ({
  source: "file" as const,
  location,
  line,
  extractor: "css@1",
});
const TOKENS_FILE = "packages/ui-kit/src/styles/tokens.css";

let line = 10;
function token(
  name: string,
  type: DesignToken["type"],
  group: string,
  light: string,
  dark?: string,
  description?: string,
): DesignToken {
  line += 1;
  const values: DesignToken["values"] = {
    light: { raw: light, resolved: light, provenance: provenance(TOKENS_FILE, line) },
  };
  if (dark !== undefined)
    values.dark = { raw: dark, resolved: dark, provenance: provenance(TOKENS_FILE, line + 400) };
  return { name, type, group, values, ...(description ? { description } : {}) };
}

const COLORS: DesignToken[] = [
  token("color-ground", "color", "color", "#fafafa", "#12161c", "Page ground behind every card."),
  token("color-surface", "color", "color", "#ffffff", "#1a1f27", "Cards and sheets."),
  token("color-surface-2", "color", "color", "#f3f4f6", "#222833"),
  token("color-line", "color", "color", "#e5e7eb", "#2c3340", "1px hairlines between rows."),
  token("color-line-strong", "color", "color", "#cbd5e1", "#3b4454"),
  token("color-ink", "color", "color", "#22263b", "#f4f6f8", "Body text. Never pure black."),
  token("color-muted", "color", "color", "#5b6478", "#a4adbd"),
  token("color-muted-2", "color", "color", "#8a93a6", "#7c8698"),
  token(
    "color-brand",
    "color",
    "color",
    "#595ecc",
    "#7d84ff",
    "Primary links, the active tab and focus.",
  ),
  token("color-brand-deep", "color", "color", "#3a3f8f", "#9a9ff5"),
  token("color-on-brand", "color", "color", "#ffffff", "#0d1020"),
  token("color-scrim", "color", "color", "rgba(15, 20, 30, 0.52)", "rgba(0, 0, 0, 0.72)"),
  token("tide-high", "color", "tide", "#0e7490", "#22d3ee", "High tide on the berth chart."),
  token("tide-low", "color", "tide", "#a16207", "#facc15"),
  token("tide-slack", "color", "tide", "#64748b", "#94a3b8"),
  token("berth-free", "color", "berth", "#169c5b", "#34d399"),
  token("berth-held", "color", "berth", "#d97706", "#fbbf24"),
  token("berth-taken", "color", "berth", "#dc2626", "#f87171"),
  token("chip-ink-free", "color", "chip", "#0f5132", "#bbf7d0"),
  token("chip-ink-taken", "color", "chip", "#7f1d1d", "#fecaca"),
  token("sig", "color", "color", "#e11d48", "#fb7185", "Signal flag red, alerts only."),
];

const TYPE: DesignToken[] = [
  token("font-sans", "fontFamily", "type", '"Inter Variable", system-ui, sans-serif'),
  token("font-mono", "fontFamily", "type", '"JetBrains Mono", ui-monospace, monospace'),
  token(
    "type-display",
    "typography",
    "type",
    "700 40px/1.1 var(--font-sans)",
    undefined,
    "Page titles on marketing screens.",
  ),
  token("type-heading", "typography", "type", "600 24px/1.25 var(--font-sans)"),
  token("type-title", "typography", "type", "600 17px/1.35 var(--font-sans)"),
  token(
    "type-body",
    "typography",
    "type",
    "400 15px/1.5 var(--font-sans)",
    undefined,
    "Default reading text.",
  ),
  token("type-caption", "typography", "type", "500 12px/1.4 var(--font-sans)"),
  token(
    "type-kicker",
    "typography",
    "type",
    "600 11px/1.35 var(--font-sans)",
    undefined,
    "The only uppercase label.",
  ),
  token("type-data", "typography", "type", "500 13px/1.4 var(--font-mono)"),
];

const SCALES: DesignToken[] = [
  ...[4, 8, 12, 16, 24, 32, 48].map((px, index) =>
    token(`space-${index + 1}`, "dimension", "spacing", `${px}px`),
  ),
  ...[
    ["radius-xs", "2px"],
    ["radius-sm", "4px"],
    ["radius-md", "8px"],
    ["radius-lg", "12px"],
    ["radius-pill", "999px"],
  ].map(([name, value]) => token(name!, "dimension", "radius", value!)),
  token(
    "shadow-card",
    "shadow",
    "shadow",
    "0 1px 2px rgba(15, 23, 42, 0.08)",
    "0 1px 2px rgba(0, 0, 0, 0.6)",
  ),
  token(
    "shadow-raised",
    "shadow",
    "shadow",
    "0 6px 16px rgba(15, 23, 42, 0.12)",
    "0 8px 20px rgba(0, 0, 0, 0.55)",
  ),
  token(
    "shadow-overlay",
    "shadow",
    "shadow",
    "0 18px 48px rgba(15, 23, 42, 0.2)",
    "0 20px 56px rgba(0, 0, 0, 0.7)",
  ),
  token("duration-micro", "duration", "duration", "120ms"),
  token("duration-base", "duration", "duration", "200ms"),
  token("duration-slow", "duration", "duration", "320ms"),
  token("ease-standard", "easing", "easing", "cubic-bezier(0.2, 0, 0, 1)"),
  token("ease-exit", "easing", "easing", "cubic-bezier(0.4, 0, 1, 1)"),
  token("bp-sm", "dimension", "breakpoint", "40rem"),
  token("bp-md", "dimension", "breakpoint", "48rem"),
  token("bp-lg", "dimension", "breakpoint", "64rem"),
  token("z-float", "number", "zIndex", "30"),
  token("z-overlay", "number", "zIndex", "50"),
  token("z-toast", "number", "zIndex", "70"),
  token("size-tap", "dimension", "control", "44px", undefined, "Smallest touch target."),
  token("size-control", "dimension", "control", "36px"),
  token("noise-media-opacity", "number", "opacity", "0.05"),
];

const button = (variant: string, background: string, color: string) =>
  `<button style="font:600 14px/1 var(--font-sans);padding:10px 16px;border-radius:var(--radius-md);border:1px solid var(--color-line);background:${background};color:${color}">${variant}</button>`;

export const SYSTEM: DesignSystem = {
  schema: "swc.design-system/1",
  id: SYSTEM_ID,
  name: "Harbor UI",
  description:
    "Harbor books berths across marinas. One indigo brand color, tide and berth status colors, and calm tables.",
  revision: 7,
  createdAt: "2026-10-21T09:00:00.000Z",
  updatedAt: UPDATED_AT,
  modes: [
    { id: "light", name: "Light" },
    { id: "dark", name: "Dark" },
  ],
  tokens: [...COLORS, ...TYPE, ...SCALES],
  components: [
    {
      id: "button",
      name: "Button",
      framework: "react",
      group: "Actions",
      importPath: "@harbor/ui-kit",
      exportName: "Button",
      variants: ["primary", "secondary", "ghost"],
      previewHtml: `<div style="display:flex;gap:8px;padding:16px">${button("Book berth", "var(--color-brand)", "var(--color-on-brand)")}${button("Details", "var(--color-surface)", "var(--color-ink)")}</div>`,
      provenance: provenance("packages/ui-kit/src/primitives/Button.tsx", 1),
    },
    {
      id: "berth-chip",
      name: "BerthChip",
      framework: "react",
      group: "Status",
      importPath: "@harbor/ui-kit",
      exportName: "BerthChip",
      previewHtml:
        '<div style="display:flex;gap:6px;padding:16px;font:500 12px/1 var(--font-sans)"><span style="padding:4px 8px;border-radius:999px;background:var(--berth-free);color:#fff">Free</span><span style="padding:4px 8px;border-radius:999px;background:var(--berth-taken);color:#fff">Taken</span></div>',
      provenance: provenance("packages/ui-kit/src/primitives/BerthChip.tsx", 1),
    },
    {
      id: "tide-chart",
      name: "TideChart",
      framework: "react",
      group: "Data",
      importPath: "@harbor/ui-kit",
      exportName: "TideChart",
      provenance: provenance("packages/ui-kit/src/charts/TideChart.tsx", 1),
    },
  ],
  sources: [
    { kind: "file", location: TOKENS_FILE, readAt: "2026-10-21T09:00:00.000Z" },
    {
      kind: "file",
      location: "packages/ui-kit/src/primitives/index.ts",
      readAt: "2026-10-21T09:00:00.000Z",
    },
  ],
  copiedFrom: null,
};

export const EMPTY_SYSTEM: DesignSystem = {
  ...SYSTEM,
  id: "s_scratch0001" as DesignSystemId,
  name: "Regatta brand",
  description: undefined as never,
  revision: 0,
  tokens: [],
  components: [],
  sources: [],
};

const README = `# Harbor UI

Harbor books berths across marinas. Every screen reads like a harbor master's board: calm tables, one indigo brand color and status colors people already know.

## Principles

- Sentence case everywhere. Only the kicker style is uppercase.
- Status colors belong to the berth, never to the brand.
- Tables before cards when people compare.

## Using tokens

Import \`@harbor/ui-kit/tokens.css\` once. Use \`color-brand\` for links and focus, \`color-ink\` for body text.
`;

const VOICE = `# Voice

Say what happens: "Book berth", "Release hold". Never "Submit".
`;

/** Stored files of the system, as `designSystem.files` returns them, with their bytes. */
export const STORED: Array<{ file: DesignSystemFile; text?: string; base64?: string }> = [
  { file: stored("README.md", "text/markdown", README.length), text: README },
  { file: stored("docs/voice.md", "text/markdown", VOICE.length), text: VOICE },
  {
    file: stored("assets/Logos/harbor-mark.svg", "image/svg+xml", 0),
    text: `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96"><rect width="96" height="96" rx="20" fill="#595ecc"/><path d="M20 60c8 8 16 8 28 0s20-8 28 0" stroke="#fff" stroke-width="6" fill="none" stroke-linecap="round"/><circle cx="48" cy="34" r="10" fill="#fff"/></svg>`,
  },
  {
    file: stored("assets/Logos/harbor-wordmark.svg", "image/svg+xml", 0),
    text: `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="64" viewBox="0 0 240 64"><text x="0" y="46" font-family="Georgia, serif" font-size="44" fill="#22263b">Harbor</text></svg>`,
  },
  {
    file: stored("assets/Screens/berth-board.png", "image/png", 0),
    base64:
      "iVBORw0KGgoAAAANSUhEUgAAAGAAAAA8CAIAAAAWtijjAAAAqElEQVR42u3ZsQ2DQAxA0asoKRmA4pZgkgiJKZBYIwNkpCyARBtRsAFNwgQoLq66Z/3S1esspz4PuikhAAQIECBAgAABEiBABYAe0ztU9xpDrUsTass5VDs/Q53BAQQIECBAgAABAgQIEKASQN+/57MfV7XtAwIECBAgQIAAAQIECFAJIMeqax4QIECAAAECBAgQIED+Yq55QIAAAQIECBAgQIAAVbD/A3MQezdKHbiaAAAAAElFTkSuQmCC",
  },
  {
    file: stored("fonts/DM Sans.woff2", "font/woff2", 0),
    base64: dmSansDataUrl.slice(dmSansDataUrl.indexOf(",") + 1),
  },
];

function stored(path: string, mimeType: string, bytes: number): DesignSystemFile {
  return { path, origin: "stored", bytes, mimeType, updatedAt: UPDATED_AT };
}

for (const entry of STORED)
  if (entry.file.bytes === 0)
    (entry.file as { bytes: number }).bytes =
      entry.text !== undefined
        ? entry.text.length
        : Math.floor(((entry.base64 ?? "").length * 3) / 4);

export const SOURCES: Array<{ file: DesignSystemFile; text: string }> = [
  {
    file: { path: TOKENS_FILE, origin: "source", bytes: 0, mimeType: "text/css" },
    text: `:root {\n${COLORS.map((t) => `  --${t.name}: ${t.values.light!.raw};`).join("\n")}\n}\n`,
  },
  {
    file: {
      path: "packages/ui-kit/src/primitives/index.ts",
      origin: "source",
      bytes: 0,
      mimeType: "text/typescript",
    },
    text: 'export { Button } from "./Button";\nexport { BerthChip } from "./BerthChip";\n',
  },
];
for (const entry of SOURCES) (entry.file as { bytes: number }).bytes = entry.text.length;

/** How many of the project's designs use Harbor UI, for the delete warning. */
export const USAGE: Record<string, number> = { [SYSTEM_ID]: 4 };

/** This machine's "No project" folder, as its server config reports it. */
export const SCRATCH_ROOT = "/Users/me/.specwithcode/scratch";

const project = (
  id: string,
  title: string,
  workspaceRoot: string,
  updatedAt: string,
  workspaceSettings: Record<string, unknown> | null = null,
) => ({
  environmentId: ENVIRONMENT,
  id: id as ProjectId,
  title,
  workspaceRoot,
  repositoryIdentity: null,
  faviconPath: null,
  projectIcon: { kind: "monogram", text: title.charAt(0), color: "blue" },
  workspaceSettings,
  createdAt: "2026-09-01T09:00:00.000Z",
  updatedAt,
});

/**
 * This machine's projects: two of the person's own, an archived one, one a
 * release check made for itself, and the "No project" folder. Only the first
 * two may take a design (the 1041 picker rule).
 */
export const PROJECTS = [
  project("harbor-app", "Harbor app", "/Users/me/code/harbor-app", "2026-10-23T20:00:00.000Z"),
  project("atlas-web", "Atlas web", "/Users/me/code/atlas-web", "2026-10-22T18:00:00.000Z"),
  project("old-site", "Old marketing site", "/Users/me/code/old-site", "2026-10-23T21:00:00.000Z", {
    archived: true,
    revision: 2,
  }),
  project(
    "release-check",
    "Release check",
    "/Users/me/code/release-check",
    "2026-10-23T22:00:00.000Z",
    { origin: "automated", revision: 1 },
  ),
  project("scratch", "No project", SCRATCH_ROOT, "2026-10-23T22:30:00.000Z"),
];

/** The Playground design's thread, still in "No project". */
export const THREADS = [
  {
    environmentId: ENVIRONMENT,
    id: "t_pricing" as ThreadId,
    projectId: "scratch" as ProjectId,
    title: "Pricing page ideas",
    movedTo: null,
  },
];

const summary = (
  designId: string,
  title: string,
  owner: DesignSummary["ref"]["owner"],
  updatedAt: string,
  extra: Partial<DesignSummary> = {},
): DesignSummary => ({
  ref: { owner, designId: designId as DesignId, path: `${designId}/design.json` },
  kind: "design",
  title,
  revision: 3,
  updatedAt,
  pageCount: 1,
  designSystem: null,
  ownerLabel: owner.kind === "playground" ? "Playground" : "Harbor app",
  ...extra,
});

const PLAYGROUND_OWNER = { kind: "playground", environmentId: ENVIRONMENT } as const;
const HARBOR_OWNER = { kind: "project", environmentId: ENVIRONMENT, projectId: PROJECT } as const;

export const DESIGNS: DesignSummary[] = [
  summary("d_pricing", "Pricing page", PLAYGROUND_OWNER, "2026-10-23T21:10:00.000Z", {
    revision: 12,
    thread: { environmentId: ENVIRONMENT, threadId: "t_pricing" as ThreadId },
  }),
  summary("d_moodboard", "Marina moodboard", PLAYGROUND_OWNER, "2026-10-21T10:00:00.000Z"),
  summary("d_berths", "Berth board", HARBOR_OWNER, "2026-10-23T19:30:00.000Z", {
    designSystem: SYSTEM_ID,
    revision: 9,
  }),
];
