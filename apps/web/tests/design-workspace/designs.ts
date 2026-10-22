// Synthetic designs only: invented products, no user content.
import type { DesignDocument, DesignNode, DesignSummary } from "@specweave-studio/contracts";

export const NOW = Date.parse("2026-10-20T15:00:00.000Z");
const at = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

let counter = 0;
const id = (prefix: string) => `${prefix}_${(counter += 1)}`;

const frame = (width: number, height: number, fill: string): DesignNode => ({
  id: "f_root",
  parentId: null,
  type: "frame",
  name: "Frame 1",
  x: 0,
  y: 0,
  width,
  height,
  fill,
  clip: true,
});
const rect = (
  x: number,
  y: number,
  width: number,
  height: number,
  fill: string,
  radius = 0,
  stroke?: string,
): DesignNode => ({
  id: id("n"),
  parentId: "f_root",
  type: "rect",
  x,
  y,
  width,
  height,
  fill,
  radius,
  ...(stroke ? { stroke, strokeWidth: 1 } : {}),
});
const text = (
  x: number,
  y: number,
  width: number,
  value: string,
  fontSize: number,
  color: string,
  fontWeight = 400,
): DesignNode => ({
  id: id("n"),
  parentId: "f_root",
  type: "text",
  x,
  y,
  width,
  height: fontSize * 1.4,
  text: value,
  fontSize,
  color,
  fontWeight,
});
const ellipse = (x: number, y: number, size: number, fill: string): DesignNode => ({
  id: id("n"),
  parentId: "f_root",
  type: "ellipse",
  x,
  y,
  width: size,
  height: size,
  fill,
});

function document(
  designId: string,
  title: string,
  nodes: DesignNode[],
  minutes: number,
  kind: DesignDocument["kind"] = "design",
): DesignDocument {
  return {
    schema: "swc.design/1",
    id: designId,
    kind,
    title,
    revision: 4,
    createdAt: at(minutes + 600),
    updatedAt: at(minutes),
    designSystem: null,
    pages: [{ id: "p_1", name: "Page 1", nodes }],
    comments: [],
    createdBy: { kind: "user" },
    copiedFrom: null,
  };
}

const plan = (x: number, name: string, price: string, accent: boolean): DesignNode[] => [
  rect(x, 360, 360, 460, accent ? "#16243d" : "#ffffff", 18, accent ? undefined : "#dfe3ea"),
  text(x + 32, 396, 300, name, 22, accent ? "#ffffff" : "#16243d", 600),
  text(x + 32, 440, 300, price, 44, accent ? "#ffffff" : "#16243d", 700),
  text(x + 32, 520, 300, "Unlimited projects", 16, accent ? "#c9d4e8" : "#5b6474"),
  text(x + 32, 552, 300, "Shared design systems", 16, accent ? "#c9d4e8" : "#5b6474"),
  text(x + 32, 584, 300, "Version history", 16, accent ? "#c9d4e8" : "#5b6474"),
  rect(x + 32, 730, 296, 52, accent ? "#5b8cff" : "#eef2f8", 12),
  text(x + 140, 744, 120, "Choose", 18, accent ? "#ffffff" : "#16243d", 600),
];

export const DOCUMENTS: DesignDocument[] = [
  document(
    "d_pricing",
    "Pricing page",
    [
      frame(1440, 1024, "#f6f7f9"),
      rect(0, 0, 1440, 72, "#ffffff", 0, "#e4e7ec"),
      text(64, 22, 200, "Atlas", 22, "#16243d", 700),
      text(470, 140, 500, "Simple pricing", 52, "#16243d", 700),
      text(520, 236, 400, "One plan per team, billed monthly.", 20, "#5b6474"),
      ...plan(150, "Starter", "$0", false),
      ...plan(540, "Team", "$24", true),
      ...plan(930, "Business", "$64", false),
    ],
    4,
  ),
  document(
    "d_onboarding",
    "Onboarding, step 2",
    [
      frame(390, 844, "#0f1420"),
      ellipse(135, 160, 120, "#5b8cff"),
      text(40, 340, 310, "Connect your calendar", 28, "#ffffff", 700),
      text(40, 392, 310, "We read busy times only.", 17, "#9aa6bd"),
      rect(40, 700, 310, 56, "#5b8cff", 14),
      text(150, 716, 120, "Continue", 18, "#ffffff", 600),
      rect(165, 800, 60, 6, "#2b3346", 3),
    ],
    38,
  ),
  document(
    "d_email",
    "Release notes email",
    [
      frame(600, 820, "#ffffff"),
      rect(0, 0, 600, 160, "#e9f0ff"),
      text(40, 56, 520, "What's new in October", 30, "#16243d", 700),
      text(40, 200, 520, "Faster sync across machines", 20, "#16243d", 600),
      text(40, 236, 520, "Projects now copy between Macs in seconds.", 16, "#5b6474"),
      rect(40, 290, 520, 220, "#f1f3f7", 12),
      text(40, 548, 520, "Design gallery", 20, "#16243d", 600),
      text(40, 584, 520, "Every design, in one place.", 16, "#5b6474"),
      rect(40, 660, 180, 48, "#16243d", 10),
      text(78, 672, 140, "Read more", 17, "#ffffff", 600),
    ],
    60 * 5,
  ),
  document(
    "d_roadmap",
    "Q4 roadmap",
    [
      frame(1920, 1080, "#14171f"),
      text(140, 140, 1200, "Q4 roadmap", 96, "#ffffff", 700),
      rect(140, 420, 480, 8, "#5b8cff", 4),
      rect(700, 420, 480, 8, "#3ccf91", 4),
      rect(1260, 420, 480, 8, "#ffb547", 4),
      text(140, 470, 480, "Sync", 40, "#ffffff", 600),
      text(700, 470, 480, "Design", 40, "#ffffff", 600),
      text(1260, 470, 480, "Mobile", 40, "#ffffff", 600),
    ],
    60 * 26,
    "slides",
  ),
  document(
    "d_moodboard",
    "Moodboard",
    [
      frame(1200, 800, "#fbfaf7"),
      ellipse(80, 80, 260, "#ffd6a5"),
      ellipse(300, 220, 200, "#caffbf"),
      rect(620, 80, 480, 300, "#9bf6ff", 24),
      rect(620, 420, 220, 300, "#bdb2ff", 24),
      rect(880, 420, 220, 300, "#ffc6ff", 24),
      {
        id: "note_1",
        parentId: "f_root",
        type: "note",
        x: 80,
        y: 520,
        width: 420,
        height: 180,
        text: "Soft, rounded, friendly. Try the lilac for the empty states.",
        color: "yellow",
      },
    ],
    1,
  ),
  document("d_blank", "Untitled design", [frame(1440, 1024, "#ffffff")], 60 * 24 * 9),
];

const owners = {
  web: { kind: "project", environmentId: "host", projectId: "atlas-web" },
  api: { kind: "project", environmentId: "host", projectId: "borealis-api" },
  pg: { kind: "playground", environmentId: "host" },
} as const;
const labels = { web: "Atlas web", api: "Borealis API", pg: "Playground" } as const;
const ownerOf: Record<string, keyof typeof owners> = {
  d_pricing: "web",
  d_onboarding: "web",
  d_email: "api",
  d_roadmap: "api",
  d_moodboard: "pg",
  d_blank: "pg",
};

export const SUMMARIES: DesignSummary[] = DOCUMENTS.map((doc) => {
  const owner = ownerOf[doc.id]!;
  return {
    ref: {
      owner: owners[owner],
      designId: doc.id,
      path: owner === "pg" ? `design/playground/${doc.id}` : `.specweave/design/${doc.id}`,
    },
    kind: doc.kind,
    title: doc.title,
    revision: doc.revision,
    updatedAt: doc.updatedAt,
    pageCount: doc.pages.length,
    designSystem: doc.designSystem,
    ownerLabel: labels[owner],
  } as DesignSummary;
});

export const PROJECTS = [
  { id: "atlas-web", title: "Atlas web" },
  { id: "borealis-api", title: "Borealis API" },
];
