/**
 * Synthetic design-system data for component tests and the headless fixture
 * in apps/web/tests/design-systems; only tests import it. Weave is modelled
 * on SpecWithCode's own tokens; "Acme UI" is an invented React kit. Nothing
 * here is read from any real project.
 */
import type {
  DesignSystemComponent,
  DesignSystemComponentChange,
  DesignSystemProposal,
  DesignSystemProposalSummary,
  DesignSystemScanResult,
  DesignSystemSummary,
  DesignToken,
  DesignTokenType,
  FigmaDesktopStatus,
} from "@specweave-studio/contracts";

export const NOW = Date.parse("2026-10-20T15:00:00Z");
const ago = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();
const SHA = "a".repeat(64);

export const PROJECTS = [
  { id: "atlas-web", title: "Atlas web" },
  { id: "borealis-api", title: "Borealis API" },
] as never as Array<{ id: never; title: string }>;

const value = (raw: string, location: string, line: number, extractor = "weave") => ({
  raw,
  resolved: raw.startsWith("var(") ? null : raw,
  provenance: { source: "file" as const, location, line, extractor },
});

function weaveToken(
  name: string,
  type: DesignTokenType,
  light: string,
  dark: string,
  line: number,
): DesignToken {
  return {
    name,
    type,
    group: type === "color" ? "color" : type,
    values: {
      light: value(light, "weave/tokens.json", line),
      dark: value(dark, "weave/tokens.json", line + 1),
    },
  };
}

function acmeToken(
  name: string,
  type: DesignTokenType,
  light: string,
  dark: string | null,
  line: number,
): DesignToken {
  const location = "packages/ui/src/tokens/acme.tokens.json";
  return {
    name,
    type,
    values:
      dark === null
        ? { default: value(light, location, line, "dtcg") }
        : {
            light: value(light, location, line, "dtcg"),
            dark: value(dark, location, line + 1, "dtcg"),
          },
  };
}

const cssComponent = (name: string, variants: string[], line: number): DesignSystemComponent => ({
  id: `css:.wv-${name}`,
  name: `.wv-${name}`,
  framework: "css-class",
  importPath: `.wv-${name}`,
  variants,
  provenance: { source: "file", location: "weave/weave.css", line, extractor: "css-classes" },
});

const reactComponent = (name: string, variants: string[], line: number): DesignSystemComponent => ({
  id: `react:${name}`,
  name,
  framework: "react",
  importPath: "@acme/ui",
  exportName: name,
  variants,
  provenance: {
    source: "file",
    location: `packages/ui/src/${name}.tsx`,
    line,
    extractor: "ts-components",
  },
});

const unchangedComponent = (component: DesignSystemComponent): DesignSystemComponentChange => ({
  id: component.id,
  change: "unchanged",
  component,
});

// ---------------------------------------------------------------------------
// Weave: an update to an existing system, with every kind of change
// ---------------------------------------------------------------------------

const weaveLineBefore = weaveToken("wv-line", "color", "#e4e4e7", "#2e2e33", 40);
const weaveLineAfter = weaveToken("wv-line", "color", "#dcdce0", "#34343a", 40);
const weaveAccentBefore = weaveToken("wv-accent", "color", "#3b6cf6", "#6f95ff", 20);
const weaveAccentAfter = weaveToken("wv-accent", "color", "#2f62f0", "#6f95ff", 20);
const weaveTokens: DesignSystemProposal["tokens"] = [
  { name: "wv-accent", change: "changed", token: weaveAccentAfter, previous: weaveAccentBefore },
  {
    name: "wv-focus-ring",
    change: "added",
    token: weaveToken("wv-focus-ring", "color", "#2f62f080", "#6f95ff80", 52),
  },
  {
    name: "wv-ink",
    change: "unchanged",
    token: weaveToken("wv-ink", "color", "#18181b", "#f4f4f5", 10),
  },
  { name: "wv-line", change: "changed", token: weaveLineAfter, previous: weaveLineBefore },
  {
    name: "wv-muted",
    change: "unchanged",
    token: weaveToken("wv-muted", "color", "#71717a", "#a1a1aa", 14),
  },
  {
    name: "wv-paper",
    change: "unchanged",
    token: weaveToken("wv-paper", "color", "#ffffff", "#111113", 6),
  },
  {
    name: "wv-radius-md",
    change: "unchanged",
    token: weaveToken("wv-radius-md", "dimension", "8px", "8px", 70),
  },
  {
    name: "wv-scrim",
    change: "added",
    token: weaveToken("wv-scrim", "color", "rgb(9 9 11 / 0.45)", "rgb(0 0 0 / 0.6)", 58),
  },
  {
    name: "wv-shadow-soft",
    change: "removed",
    token: weaveToken("wv-shadow-soft", "shadow", "0 1px 2px rgb(0 0 0 / 0.06)", "none", 80),
  },
  {
    name: "wv-success",
    change: "added",
    token: weaveToken("wv-success", "color", "#15803d", "#4ade80", 30),
  },
];

const WEAVE_COMPONENTS = [
  cssComponent("btn", ["primary", "ghost", "danger", "sm"], 120),
  cssComponent("card", ["raised", "flat"], 160),
  cssComponent("chip", ["selected"], 190),
  cssComponent("input", ["invalid"], 210),
  cssComponent("tabs", [], 240),
  cssComponent("toast", ["success", "error"], 270),
  cssComponent("dialog", [], 300),
  cssComponent("badge", ["info", "warning"], 330),
  cssComponent("avatar", ["sm", "lg"], 350),
];
const weaveTooltip = cssComponent("tooltip", [], 380);
const weaveBtnBefore = cssComponent("btn", ["primary", "ghost", "sm"], 118);

export const WEAVE_PROPOSAL: DesignSystemProposal = {
  id: "prop_weave",
  owner: { kind: "project", projectId: "atlas-web" as never },
  origin: "code",
  createdAt: ago(2),
  createdBy: { kind: "user" },
  target: { systemId: "weave", revision: 3 },
  system: {
    schema: "swc.design-system/1",
    id: "weave",
    name: "Weave",
    revision: 4,
    createdAt: ago(9_000),
    updatedAt: ago(2),
    modes: [
      { id: "light", name: "Light" },
      { id: "dark", name: "Dark" },
    ],
    tokens: weaveTokens.filter((change) => change.change !== "removed").map((c) => c.token),
    components: [...WEAVE_COMPONENTS, weaveTooltip],
    sources: [
      { kind: "file", location: "weave/tokens.json", sha256: SHA, readAt: ago(2) },
      { kind: "file", location: "weave/weave.css", sha256: SHA, readAt: ago(2) },
    ],
    copiedFrom: null,
  },
  tokens: weaveTokens,
  components: [
    {
      id: "css:.wv-btn",
      change: "changed",
      component: WEAVE_COMPONENTS[0]!,
      previous: weaveBtnBefore,
    },
    ...WEAVE_COMPONENTS.slice(1).map(unchangedComponent),
    { id: weaveTooltip.id, change: "added", component: weaveTooltip },
  ],
  findings: [
    {
      code: "drift",
      severity: "warning",
      message:
        "--wv-scrim only in vskill-platform copy. The copy in this project does not define it.",
      location: "vskill-platform/src/styles/weave.css",
      line: 88,
    },
    {
      code: "only-in-json",
      severity: "info",
      message: "wv-focus-ring is in tokens.json but no CSS rule uses it yet.",
      location: "weave/tokens.json",
      line: 52,
    },
  ],
};

// ---------------------------------------------------------------------------
// Acme UI: a new system from an invented React kit
// ---------------------------------------------------------------------------

const ACME_TOKENS: DesignToken[] = [
  acmeToken("acme-primary", "color", "#7c3aed", "#a78bfa", 4),
  acmeToken("acme-primary-hover", "color", "#6d28d9", "#c4b5fd", 8),
  acmeToken("acme-surface", "color", "#ffffff", "#0f0f14", 12),
  acmeToken("acme-surface-raised", "color", "#f8f7fc", "#1a1a22", 16),
  acmeToken("acme-text", "color", "#1c1b22", "#ecebf3", 20),
  acmeToken("acme-text-muted", "color", "#6b6880", "#9f9cb3", 24),
  acmeToken("acme-border", "color", "#e5e3ef", "#2c2b36", 28),
  acmeToken("acme-danger", "color", "#dc2626", "#f87171", 32),
  acmeToken("acme-radius-md", "dimension", "10px", null, 40),
  acmeToken("acme-space-2", "dimension", "8px", null, 44),
  acmeToken("acme-font-body", "fontFamily", "'Inter', system-ui, sans-serif", null, 48),
];

const ACME_COMPONENTS = [
  reactComponent("Button", ["primary", "secondary", "ghost", "danger", "size=sm", "size=lg"], 12),
  reactComponent("IconButton", ["ghost", "outline"], 9),
  reactComponent("Input", ["invalid", "size=sm"], 14),
  reactComponent("Select", [], 20),
  reactComponent("Checkbox", ["indeterminate"], 8),
  reactComponent("Switch", [], 7),
  reactComponent("Card", ["elevated", "outline"], 10),
  reactComponent("Modal", ["size=sm", "size=lg"], 22),
  reactComponent("Tabs", ["pill", "underline"], 16),
  reactComponent("Toast", ["success", "error", "info"], 18),
  reactComponent("Avatar", ["circle", "square"], 6),
];

export const ACME_PROPOSAL: DesignSystemProposal = {
  id: "prop_acme",
  owner: { kind: "project", projectId: "borealis-api" as never },
  origin: "code",
  createdAt: ago(1),
  createdBy: { kind: "user" },
  target: null,
  system: {
    schema: "swc.design-system/1",
    id: "acme-ui",
    name: "Acme UI",
    revision: 0,
    createdAt: ago(1),
    updatedAt: ago(1),
    modes: [
      { id: "light", name: "Light" },
      { id: "dark", name: "Dark" },
      { id: "default", name: "Default" },
    ],
    tokens: ACME_TOKENS,
    components: ACME_COMPONENTS,
    sources: [
      {
        kind: "file",
        location: "packages/ui/src/tokens/acme.tokens.json",
        sha256: SHA,
        readAt: ago(1),
      },
      { kind: "file", location: "packages/ui/src/index.ts", sha256: SHA, readAt: ago(1) },
    ],
    copiedFrom: null,
  },
  tokens: ACME_TOKENS.map((token) => ({ name: token.name, change: "added" as const, token })),
  components: ACME_COMPONENTS.map((component) => ({
    id: component.id,
    change: "added" as const,
    component,
  })),
  findings: [
    {
      code: "unresolved",
      severity: "info",
      message: "Select takes its colors from props; no token is referenced.",
      location: "packages/ui/src/Select.tsx",
      line: 20,
    },
  ],
};

// ---------------------------------------------------------------------------
// Lists, scan and Figma
// ---------------------------------------------------------------------------

const summary = (
  systemId: string,
  name: string,
  owner: "atlas-web" | "borealis-api" | null,
  ownerLabel: string,
  sources: DesignSystemSummary["sources"],
  minutes: number,
  tokenCount: number,
  componentCount: number,
): DesignSystemSummary =>
  ({
    ref: {
      owner:
        owner === null
          ? { kind: "playground", environmentId: "host" }
          : { kind: "project", environmentId: "host", projectId: owner },
      systemId,
      path: `.specweave/design/systems/${systemId}/system.json`,
    },
    name,
    revision: 3,
    updatedAt: ago(minutes),
    tokenCount,
    componentCount,
    sources,
    ownerLabel,
  }) as never;

const file = (location: string) => ({ kind: "file" as const, location, sha256: SHA, readAt: "" });

export const SYSTEMS: DesignSystemSummary[] = [
  summary(
    "weave",
    "Weave",
    "atlas-web",
    "Atlas web",
    [file("weave/tokens.json"), file("weave/weave.css")],
    45,
    86,
    10,
  ),
  summary("app-theme", "App theme", "atlas-web", "Atlas web", [file("src/theme.css")], 300, 24, 0),
  summary(
    "brand",
    "Brand",
    "borealis-api",
    "Borealis API",
    [{ kind: "figma-export", location: "Brand.Light.tokens.json", readAt: "" }],
    2_000,
    40,
    0,
  ),
  summary(
    "moodboard",
    "Moodboard palette",
    null,
    "Playground",
    [{ kind: "agent", location: "thread", readAt: "" }],
    10,
    12,
    0,
  ),
  summary(
    "figma-kit",
    "Figma kit",
    null,
    "Playground",
    [{ kind: "figma-desktop", location: "abc123/1:2", readAt: "" }],
    20_000,
    64,
    0,
  ),
];

export const PROPOSALS: DesignSystemProposalSummary[] = [
  {
    id: "prop_agent",
    owner: { kind: "playground" },
    origin: "agent",
    createdAt: ago(3),
    createdBy: { kind: "agent", threadId: "thread-1" as never, provider: "claude" },
    name: "Calm blue",
    target: null,
    counts: { added: 18, changed: 0, removed: 0, findings: 0 },
  },
  {
    id: "prop_weave",
    owner: { kind: "project", projectId: "atlas-web" as never },
    origin: "code",
    createdAt: ago(2),
    createdBy: { kind: "user" },
    name: "Weave",
    target: { systemId: "weave", revision: 3 },
    counts: { added: 4, changed: 3, removed: 1, findings: 2 },
  },
];

const candidate = (
  path: string,
  kind: DesignSystemScanResult["candidates"][number]["kind"],
  tokenCount: number,
  componentCount: number,
  modes: string[],
  suggestion: string,
  bytes: number,
) => ({ path, kind, sha256: SHA, bytes, tokenCount, componentCount, modes, suggestion });

export const SCAN_RESULT: DesignSystemScanResult = {
  candidates: [
    candidate("weave/tokens.json", "weave", 86, 0, ["light", "dark"], "weave", 18_400),
    candidate("weave/weave.css", "css", 86, 10, ["light", "dark"], "weave", 42_100),
    candidate("weave/legacy.tokens.json", "dtcg", 30, 0, [], "weave", 6_200),
    candidate("src/theme.css", "css", 24, 0, ["light", "dark"], "app-theme", 3_900),
    candidate("src/components/index.ts", "components", 0, 14, [], "app-theme", 1_100),
  ],
  suggestions: [
    {
      key: "weave",
      name: "Weave",
      paths: ["weave/tokens.json", "weave/weave.css"],
      copies: ["vskill-platform/src/styles/weave.css"],
      description: "Tokens and component classes shared by the app.",
    },
    {
      key: "app-theme",
      name: "App theme",
      paths: ["src/theme.css", "src/components/index.ts"],
      copies: [],
      derivedFromLabel: "Weave",
    },
  ],
  skipped: [
    { path: "fixtures/huge.tokens.json", reason: "too-large" },
    { path: "shared/tokens.json", reason: "symlink-outside-root" },
  ],
  filesSeen: 1_284,
  truncated: false,
};

export const FIGMA_OFF: FigmaDesktopStatus = {
  state: "off",
  endpoint: "http://127.0.0.1:3845/mcp",
  tools: [],
  variablesTool: null,
};

export const FIGMA_CONNECTED: FigmaDesktopStatus = {
  state: "connected",
  endpoint: "http://127.0.0.1:3845/mcp",
  tools: [{ name: "get_variable_defs" }],
  variablesTool: "get_variable_defs",
  serverName: "Figma Dev Mode MCP",
};
