#!/usr/bin/env node
/**
 * Increment 1051 scenario matrix: design creation (C-01 to C-04), boards (B-01 to B-08) and
 * slides (SL-01 to SL-05), run end to end on one private headless server built from this
 * checkout. It builds nothing: build web (`vp build` in apps/web) and the server
 * (`node apps/server/scripts/cli.ts build`) first, with Node 22.
 *
 * The server gets a fresh private home under /tmp, a loopback port of its own, every provider
 * off and the export browser's sandbox off (as the earlier private runs). No provider turn can
 * start; the runner also counts every `message.dispatch` the pages send and checks that each
 * thread it sees has no messages, runs or provider turns. It never reads a live store.
 *
 * It reuses the live runners instead of repeating them: verify-canvas.mjs --no-agent (canvas
 * basics, comments with replies, PNG/SVG/HTML/PDF export, Implement and Design from code with
 * no provider) and verify-slides.mjs (rail, layouts, menu, Present, Presenter view) run as child
 * processes against the same server through STUDIO_LIVE_SERVER. The rows they do not cover are
 * driven here with the same kit.
 *
 * Writes matrix.json and matrix.md (row, steps, verdict, measured values, screenshots), shots/
 * (light and dark at 1280 px, plus 360 px for layout rows), exports/ and children/.
 * PPTX files are read back with python-pptx: DESIGN_MATRIX_PYTHON names an interpreter that
 * has it, always run with -I. Headless only (PWDEBUG=0, PLAYWRIGHT_HTML_OPEN=never);
 * STUDIO_CHROMIUM_EXECUTABLE picks the headless shell; STUDIO_PLAYWRIGHT_MODULE a Playwright.
 *
 * Usage: node scripts/studio-verify/design-boards-slides.mjs /absolute/owned/report-dir
 *        [--rows=SL-01,SL-05] [--skip-children] [--keep-home]
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import {
  assert,
  checker,
  composerText,
  entrypointSha256,
  exportFromMenu,
  gitHead,
  initRepository,
  launchBrowser,
  pidAlive,
  portIsFree,
  repoRoot,
  requireBuild,
  saved,
  sleep,
  startServer,
  threadActivity,
  waitFor,
  warmExportBrowser,
  watchCommands,
  watchErrors,
} from "../../apps/web/tests/design-workspace/live/kit.mjs";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
if (process.versions.node.split(".")[0] !== "22") throw new Error("Use Node 22");

const args = process.argv.slice(2);
const outArg = args.find((arg) => !arg.startsWith("--"));
if (!outArg || !NodePath.isAbsolute(outArg))
  throw new Error("Pass an absolute, owned report directory.");
const out = outArg;
const only = args
  .find((arg) => arg.startsWith("--rows="))
  ?.slice(7)
  .split(",")
  .filter(Boolean);
const skipChildren = args.includes("--skip-children");
const keepHome = args.includes("--keep-home");
const PYTHON = process.env.DESIGN_MATRIX_PYTHON ?? "python3";
const shotsDir = NodePath.join(out, "shots");
const exportsDir = NodePath.join(out, "exports");
const childrenDir = NodePath.join(out, "children");
for (const dir of [out, shotsDir, exportsDir, childrenDir])
  NodeFS.mkdirSync(dir, { recursive: true });
requireBuild();

const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const liveDir = NodePath.join(repoRoot, "apps/web/tests/design-workspace/live");
const contrastScan = NodeFS.readFileSync(NodePath.join(here, "theme-contrast-scan.js"), "utf8");

// ---- the matrix ----------------------------------------------------------------------------------
const ROWS = [
  [
    "C-01",
    "Design, blank",
    'INV-1 "Design (New)" card, INV-3',
    true,
    "It saves, reloads unchanged, uses the chosen system, and the project copy lands in the repository's .specweave/design",
  ],
  [
    "C-02",
    "Design from code",
    'INV-1 "Design in codebase", INV-7',
    false,
    "A design bound to a new thread exists with the brief as the first message. With providers disabled the thread says why it cannot start; no turn is run",
  ],
  ["C-03", "Design system", "L-01 to L-35, RE-13", false, "As in 1046"],
  [
    "C-04",
    "Slides",
    'INV-6 "Slides (New)"',
    true,
    "The dialog matches the other create dialogs (owner, system, title)",
  ],
  ["B-01", "Basics", "INV-3", true, "No lost edit; the save state reads Saved"],
  ["B-02", "Pages", "INV-4", false, "The order and names survive a reload"],
  [
    "B-03",
    "Design system binding",
    "INV-2, RE-13.15",
    false,
    "Tokens re-resolve on switch; the component renders",
  ],
  [
    "B-04",
    "Comments and versions",
    "INV-5",
    false,
    "The history lists the version and restore brings the content back",
  ],
  ["B-05", "Export", "INV-4", false, "The files open; the PDF has one page per frame"],
  [
    "B-06",
    "Implement frame",
    "INV-7",
    false,
    "The thread is created with its handoff text; no turn runs",
  ],
  [
    "B-07",
    "Project board",
    "INV-9",
    false,
    "Scoped creates; the move keeps id, history and versions",
  ],
  ["B-08", "Share", "INV-5", true, "It states what is local and offers the local equivalent"],
  [
    "SL-01",
    'Deck from scratch, "Matchday launch"',
    "INV-6",
    true,
    "All actions work; Present keys; skipped slides left out; Presenter view; PDF and PPTX export; the read-back matches",
  ],
  [
    "SL-02",
    "Deck imported from PowerPoint",
    "not known from authorized evidence; local feature",
    false,
    "Slide count, text, notes and images arrive; unsupported parts are listed; the result can be edited, presented and exported",
  ],
  [
    "SL-03",
    "Deck authored by an agent",
    "INV-6 /slides <brief>",
    false,
    "The deck opens in the editor with a working rail and notes; the export read-back matches",
  ],
  [
    "SL-04",
    "Project deck",
    "INV-9",
    false,
    "The deck lands in the repository; slides and notes survive the move",
  ],
  [
    "SL-05",
    "Narrow and dark",
    "none",
    true,
    "The rail collapses cleanly; nothing overlaps; contrast is AA",
  ],
];
const rows = new Map(
  ROWS.map(([id, flow, claude, layout, passWhen]) => [
    id,
    {
      id,
      flow,
      claudeReference: claude,
      layout,
      passWhen,
      steps: [],
      checks: [],
      measured: {},
      screenshots: [],
      exports: [],
      notes: [],
      verdict: null,
    },
  ]),
);
const wanted = (id) => only === undefined || only.includes(id);
const row = (id) => rows.get(id);
const step = (id, text) => row(id).steps.push(text);
const measure = (id, values) => Object.assign(row(id).measured, values);

// ---- private home, fixtures and server ----------------------------------------------------------
const started = new Date();
const privateRoot = NodeFS.mkdtempSync("/tmp/swc-1051-matrix-");
const home = NodePath.join(privateRoot, "home");
const tools = NodePath.join(privateRoot, "tools");
const fixtures = NodePath.join(privateRoot, "fixtures");
const repo = NodePath.join(privateRoot, "repos", "matchday-web");
for (const dir of [tools, fixtures]) NodeFS.mkdirSync(dir, { recursive: true });
initRepository(repo, {
  "README.md": "Matchday web: the 1051 matrix's code project.\n",
  "src/styles/tokens.css":
    ":root {\n  --mw-background: #ffffff;\n  --mw-foreground: #0b1b2b;\n  --mw-primary: #0a6b3d;\n}\n",
});

const sha = gitHead();
const summary = {
  increment: "1051-design-boards-and-slides-claude-parity",
  sha,
  dirty: NodeChildProcess.execFileSync("/usr/bin/git", ["status", "--porcelain"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim(),
  builtEntrypointSha256: entrypointSha256(),
  node: process.version,
  startedAt: started.toISOString(),
  privateHome: home,
  browser: {
    headless: true,
    PWDEBUG: "0",
    PLAYWRIGHT_HTML_OPEN: "never",
    executable: process.env.STUDIO_CHROMIUM_EXECUTABLE ?? "playwright default",
  },
  python: PYTHON,
};

const errors = [];
const allCommands = [];
const threadsSeen = new Set();
const browser = await launchBrowser();
const server = await startServer({
  home,
  cwd: privateRoot,
  logFile: NodePath.join(out, "server.log"),
  label: "1051 scenario matrix",
});
const { origin, request, rpc } = server;
summary.server = { origin, port: server.port, pid: server.pid };
console.log(`server ${origin} pid ${server.pid} home ${home}`);
const descriptor = server.describe(NodePath.join(privateRoot, "live-server.json"), {
  scratchRoot: NodePath.join(privateRoot, "children"),
});
NodeFS.mkdirSync(NodePath.join(privateRoot, "children"), { recursive: true });

const PLAYGROUND = { kind: "playground" };
let projectId;
let projectOwner;
let matchday;
let night;
const designsOf = async () => (await rpc("design.list", { filter: { kind: "all" } })).designs;
const getDoc = async (owner, designId) => (await rpc("design.get", { owner, designId })).document;
const keyOf = (owner, designId) =>
  owner.kind === "playground" ? `pg.${designId}` : `p.${owner.projectId}.${designId}`;
const ownerOfKey = (key) =>
  key.startsWith("pg.") ? PLAYGROUND : { kind: "project", projectId: key.split(".")[1] };

// ---- python-pptx -----------------------------------------------------------------------------
const PPTX_TOOL = String.raw`
import json, sys
from pptx import Presentation
from pptx.util import Inches, Pt
from pptx.enum.shapes import MSO_SHAPE, MSO_SHAPE_TYPE

def read(path):
    deck = Presentation(path)
    slides = []
    for slide in deck.slides:
        texts, tables, pictures, shapes = [], [], 0, []
        def walk(items):
            nonlocal pictures
            for shape in items:
                shapes.append(str(shape.shape_type))
                if shape.shape_type == MSO_SHAPE_TYPE.PICTURE:
                    pictures += 1
                if shape.shape_type == MSO_SHAPE_TYPE.GROUP:
                    walk(shape.shapes)
                if getattr(shape, "has_text_frame", False) and shape.has_text_frame:
                    text = shape.text_frame.text.strip()
                    if text:
                        texts.append(text)
                if getattr(shape, "has_table", False) and shape.has_table:
                    for r in shape.table.rows:
                        for c in r.cells:
                            if c.text.strip():
                                tables.append(c.text.strip())
        walk(slide.shapes)
        notes = slide.notes_slide.notes_text_frame.text.strip() if slide.has_notes_slide else ""
        slides.append({"texts": texts, "tables": tables, "pictures": pictures, "notes": notes, "shapes": shapes})
    print(json.dumps({"slides": slides, "width": deck.slide_width, "height": deck.slide_height}))

def make(path, image):
    from PIL import Image, ImageDraw
    img = Image.new("RGB", (640, 360), (10, 107, 61))
    draw = ImageDraw.Draw(img)
    draw.ellipse((220, 80, 420, 280), fill=(255, 255, 255))
    img.save(image)
    deck = Presentation()
    deck.slide_width, deck.slide_height = Inches(13.333), Inches(7.5)
    def notes(slide, text):
        slide.notes_slide.notes_text_frame.text = text
    s = deck.slides.add_slide(deck.slide_layouts[0])
    s.shapes.title.text = "Harbor FC season review"
    s.placeholders[1].text = "Prepared for the club board"
    notes(s, "Welcome everyone and thank the volunteers.")
    s = deck.slides.add_slide(deck.slide_layouts[1])
    s.shapes.title.text = "What went well"
    body = s.placeholders[1].text_frame
    body.text = "Twelve home wins"
    for line in ["Youth academy doubled", "Ticket sales up 18%"]:
        body.add_paragraph().text = line
    notes(s, "Pause on the academy numbers.")
    s = deck.slides.add_slide(deck.slide_layouts[3])
    s.shapes.title.text = "Before and after"
    s.placeholders[1].text = "Paper sign-up sheets"
    s.placeholders[2].text = "Online match registration"
    notes(s, "Contrast the two seasons.")
    s = deck.slides.add_slide(deck.slide_layouts[5])
    s.shapes.title.text = "Our home ground"
    s.shapes.add_picture(image, Inches(3.5), Inches(1.8), Inches(6.4), Inches(3.6))
    notes(s, "The new floodlights went up in March.")
    s = deck.slides.add_slide(deck.slide_layouts[5])
    s.shapes.title.text = "Next season targets"
    box = s.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(1), Inches(2), Inches(5), Inches(2))
    box.text_frame.text = "Win the regional cup"
    s.shapes.add_shape(MSO_SHAPE.STAR_5_POINT, Inches(8), Inches(2), Inches(2), Inches(2))
    notes(s, "Targets agreed with the coaches.")
    s = deck.slides.add_slide(deck.slide_layouts[5])
    s.shapes.title.text = "Fixtures"
    table = s.shapes.add_table(2, 2, Inches(1), Inches(2), Inches(8), Inches(1.5)).table
    table.cell(0, 0).text = "Opponent"
    table.cell(0, 1).text = "Date"
    table.cell(1, 0).text = "Marina United"
    table.cell(1, 1).text = "August 9"
    notes(s, "Close with the first home fixture.")
    deck.save(path)
    print(json.dumps({"slides": 6}))

if sys.argv[1] == "read":
    read(sys.argv[2])
else:
    make(sys.argv[2], sys.argv[3])
`;
const pptxTool = NodePath.join(tools, "pptx_matrix.py");
NodeFS.writeFileSync(pptxTool, PPTX_TOOL);
const python = (...rest) =>
  JSON.parse(
    NodeChildProcess.execFileSync(PYTHON, ["-I", pptxTool, ...rest], {
      encoding: "utf8",
      cwd: tools,
      env: { PATH: "/usr/bin:/bin" },
    }),
  );
// The runner's own deck, made the way a third-party tool would, and its picture.
const thirdParty = NodePath.join(fixtures, "third-party-6-slides.pptx");
python("make", thirdParty, NodePath.join(fixtures, "ground.png"));
const norm = (text) =>
  String(text ?? "")
    .replace(/\s+/g, " ")
    .trim();
/** Texts and notes of the deck's shown slides, in order, from the server's document. */
function deckOutline(document) {
  return document.pages
    .filter((page) => page.skipped !== true)
    .map((page) => ({
      texts: page.nodes
        .filter((node) => (node.type === "text" || node.type === "note") && norm(node.text) !== "")
        .map((node) => norm(node.text)),
      notes: norm(page.notes),
      images: page.nodes.filter((node) => node.type === "image").length,
    }));
}
/** python-pptx read-back of `file` against the deck: count, texts and notes per slide. */
function readBack(file, document) {
  const pptx = python("read", file);
  const expected = deckOutline(document);
  const differences = [];
  if (pptx.slides.length !== expected.length)
    differences.push(`slides ${pptx.slides.length}, deck ${expected.length}`);
  expected.forEach((slide, index) => {
    const got = pptx.slides[index];
    if (!got) return;
    const want = slide.texts.toSorted().join(" | ");
    const have = got.texts.map(norm).toSorted().join(" | ");
    if (want !== have) differences.push(`slide ${index + 1} texts: deck [${want}] pptx [${have}]`);
    if (slide.notes !== norm(got.notes))
      differences.push(`slide ${index + 1} notes: deck "${slide.notes}" pptx "${norm(got.notes)}"`);
  });
  return {
    file,
    slides: pptx.slides.length,
    expectedSlides: expected.length,
    pictures: pptx.slides.reduce((sum, slide) => sum + slide.pictures, 0),
    differences,
  };
}
const pdfPages = (file) => {
  const info = NodeChildProcess.execFileSync("pdfinfo", [file], { encoding: "utf8" });
  return Number(info.match(/^Pages:\s+(\d+)/m)?.[1] ?? NaN);
};
/** Top-level visible frames of every page that is not skipped: what a PDF prints. */
const expectedSheets = (document) =>
  document.pages
    .filter((page) => page.skipped !== true)
    .reduce((sum, page) => {
      const frames = page.nodes.filter(
        (node) => node.parentId === null && node.type === "frame" && node.hidden !== true,
      );
      if (frames.length === 0) return sum + (page.nodes.length > 0 ? 1 : 0);
      return sum + (document.kind === "slides" ? 1 : frames.length);
    }, 0);

// ---- browser helpers -----------------------------------------------------------------------------
const contexts = {};
/** A signed-in context past onboarding, as a person who has used the app. */
async function context(options) {
  const value = await server.signedInContext(browser, options);
  await value.addInitScript(() => {
    // Init scripts run in every frame; sandboxed frames have no storage.
    if (window !== window.top) return;
    if (localStorage.getItem("studio:client-settings:v1") === null)
      localStorage.setItem(
        "studio:client-settings:v1",
        JSON.stringify({ onboardingCompletedAt: "2026-10-12T00:00:00Z" }),
      );
  });
  return value;
}
async function themed(theme) {
  contexts[theme] ??= await context({ colorScheme: theme, viewport: { width: 1280, height: 800 } });
  return contexts[theme];
}
async function newPage(theme = "light", label = theme) {
  const page = await (await themed(theme)).newPage();
  page.setDefaultTimeout(20000);
  watchErrors(page, label, errors);
  allCommands.push(watchCommands(page));
  return page;
}
const shotPath = (id, name) => NodePath.join(shotsDir, `${id}-${name}.png`);
async function shot(id, page, name) {
  const file = shotPath(id, name);
  await page.screenshot({ path: file });
  row(id).screenshots.push(file);
  return file;
}
/** Light and dark at 1280 px, and 360 px for layout rows: `open` navigates and prepares. */
async function themedShots(id, name, open, { widths } = {}) {
  const sizes = widths ?? (row(id).layout ? [1280, 360] : [1280]);
  for (const theme of ["light", "dark"])
    for (const width of sizes) {
      const page = await newPage(theme, `${id}-${theme}-${width}`);
      try {
        await page.setViewportSize({ width, height: width <= 400 ? 780 : 800 });
        await open(page, { theme, width });
        await page.waitForTimeout(500);
        await shot(id, page, `${name}-${theme}-${width}`);
      } catch (error) {
        row(id).notes.push(
          `shot ${name} ${theme} ${width}: ${String(error?.message ?? error).split("\n")[0]}`,
        );
      } finally {
        await page.close();
      }
    }
}
let drive;
/** The page a check drives when it is not `drive`; its failure shot comes from there. */
let current = null;
const checks = new Map();
const checkFor = (id) => {
  if (!checks.has(id))
    checks.set(
      id,
      checker(row(id).checks, {
        onFailure: async (name) => {
          const page = current !== null && !current.isClosed() ? current : drive;
          if (page && !page.isClosed())
            await shot(id, page, `fail-${name.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}`).catch(
              () => undefined,
            );
        },
        log: (line) => console.log(`[${id}] ${line}`),
      }),
    );
  return checks.get(id);
};
const editorReady = async (page) => {
  await page.getByTestId("design-canvas").waitFor({ timeout: 30000 });
  await saved(page, 15000);
};
const openDesign = async (page, key) => {
  await page.goto(`${origin}/design/${key}`);
  await editorReady(page);
  await page.waitForTimeout(400);
};
const designKeyFromUrl = (page) =>
  decodeURIComponent(new URL(page.url()).pathname.split("/design/")[1]);
const focusCanvas = (page) => page.getByTestId("design-canvas").focus();
const boxOf = async (page, id) => {
  const box = await page.locator(`[data-node="${id}"]`).first().boundingBox();
  assert(box !== null, `${id} has no box`);
  return box;
};
const rail = (page) => page.getByTestId("slide-rail");
const slideItems = (page) => rail(page).getByTestId("slide-item");
const slideMenu = async (page, index, item) => {
  await slideItems(page).nth(index).click({ button: "right" });
  await page.getByRole("menuitem", { name: item }).click();
  await saved(page);
};
/** Picks the first option in an open listbox whose text matches. */
const pickOption = (page, pattern) =>
  page.getByRole("option").filter({ hasText: pattern }).first().click();
const pickMatchday = async (dialog, page) => {
  await dialog.getByTestId("creation-system-trigger").click();
  const option = page
    .getByRole("option")
    .filter({ hasText: /^Matchday(?! Night)/ })
    .first();
  const testId = await option.getAttribute("data-testid");
  const text = (await option.textContent()).trim();
  await option.click();
  return { kind: testId ?? "own", text };
};
/** How many systems named Matchday the project holds: a move copies one in only when it has none. */
const projectCopies = async () =>
  (await rpc("designSystem.list", { filter: { kind: "all" } })).systems.filter(
    (system) =>
      system.ref.owner.kind === "project" &&
      system.ref.owner.projectId === projectId &&
      system.name === "Matchday",
  ).length;
const repoDesignFile = (designId) =>
  NodePath.join(repo, ".specweave/design", designId, "design.json");
async function shellThreads() {
  const item = await server.rpcFirst(
    "orchestration.subscribeShell",
    {},
    (value) => value.kind === "snapshot",
  );
  return item.snapshot.threads ?? [];
}

// ---- seed ----------------------------------------------------------------------------------------
async function createSystem(owner, name, tokens, components) {
  const created = await rpc("designSystem.create", {
    owner,
    name,
    description: `${name}: the 1051 matrix's design system.`,
    modes: [
      { id: "light", name: "Light" },
      { id: "dark", name: "Dark" },
    ],
  });
  const systemId = created.ref.systemId ?? created.system.id;
  const applied = await rpc("designSystem.apply", {
    owner,
    systemId,
    expectedRevision: created.system.revision,
    operations: [
      ...tokens.map(([tokenName, type, light, dark = light]) => ({
        op: "put_token",
        token: { name: tokenName, type, values: { light, dark } },
      })),
      ...components.map((component) => ({ op: "put_component", component })),
    ],
  });
  return {
    systemId,
    name,
    revision: applied.system.revision,
    tokens: applied.system.tokens.length,
    components: applied.system.components.length,
  };
}
const MATCHDAY_TOKENS = (primary, background = "#ffffff") => [
  ["mx-background", "color", background, "#0f1720"],
  ["mx-foreground", "color", "#0b1b2b", "#e8eef5"],
  ["mx-muted-foreground", "color", "#4a5a6a", "#9fb0c2"],
  ["mx-card", "color", "#eef3f8", "#18232f"],
  ["mx-primary", "color", primary, "#3ccf8e"],
  ["mx-primary-foreground", "color", "#ffffff", "#04210f"],
  ["mx-font-display", "fontFamily", '"Iowan Old Style", Georgia, serif'],
  ["mx-font-sans", "fontFamily", '"Avenir Next", "Helvetica Neue", sans-serif'],
];
const MATCHDAY_COMPONENTS = [
  {
    id: "join-button",
    name: "Join button",
    framework: "html",
    group: "Actions",
    previewHtml:
      '<button class="mx-join" style="font:600 16px/1 sans-serif;padding:12px 20px;border:0;border-radius:999px;background:var(--mx-primary);color:var(--mx-primary-foreground)">Join match</button>',
  },
  {
    id: "score-card",
    name: "Score card",
    framework: "html",
    group: "Cards",
    previewHtml:
      '<div class="mx-score" style="padding:16px;border-radius:12px;background:var(--mx-card);color:var(--mx-foreground);font:600 20px sans-serif">Harbor FC 2 - 1 Marina United</div>',
  },
];
const rgb = (hex) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
};

const seed = checker((summary.seed = []));
await seed("seed: a code project, the Matchday systems and a warm export browser", async () => {
  projectId = crypto.randomUUID();
  await request("/api/projects/mutate", {
    type: "project.create",
    commandId: crypto.randomUUID(),
    projectId,
    title: "Matchday web",
    workspaceRoot: repo,
    // A /tmp folder reads as a check's own project, which takes no new designs.
    origin: "user",
  });
  projectOwner = { kind: "project", projectId };
  matchday = await createSystem(
    PLAYGROUND,
    "Matchday",
    MATCHDAY_TOKENS("#0a6b3d"),
    MATCHDAY_COMPONENTS,
  );
  night = await createSystem(
    PLAYGROUND,
    "Matchday Night",
    MATCHDAY_TOKENS("#7c3aed", "#f4f1ff"),
    MATCHDAY_COMPONENTS,
  );
  const probe = await rpc("design.create", {
    owner: PLAYGROUND,
    kind: "design",
    title: "Export warm-up",
  });
  const page = probe.document.pages[0];
  const warm = await warmExportBrowser(server, {
    owner: PLAYGROUND,
    designId: probe.ref.designId,
    pageId: page.id,
    frameId: page.nodes.find((node) => node.type === "frame").id,
  });
  await rpc("design.delete", { owner: PLAYGROUND, designId: probe.ref.designId });
  return { projectId, repo, matchday, night, warm };
});

// ---- children ------------------------------------------------------------------------------------
const children = {};
function runChild(name, script, extra) {
  const dir = NodePath.join(childrenDir, name);
  NodeFS.mkdirSync(dir, { recursive: true });
  const started = Date.now();
  const result = NodeChildProcess.spawnSync(
    process.execPath,
    [NodePath.join(liveDir, script), ...extra, dir],
    {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        STUDIO_LIVE_SERVER: descriptor,
        PWDEBUG: "0",
        PLAYWRIGHT_HTML_OPEN: "never",
      },
      timeout: 1_200_000,
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  NodeFS.writeFileSync(
    NodePath.join(dir, "run.log"),
    `${result.stdout ?? ""}${result.stderr ?? ""}`,
  );
  const reportFile = NodePath.join(dir, "report.json");
  const report = NodeFS.existsSync(reportFile)
    ? JSON.parse(NodeFS.readFileSync(reportFile, "utf8"))
    : null;
  children[name] = {
    script: `apps/web/tests/design-workspace/live/${script} ${extra.join(" ")}`.trim(),
    exit: result.status,
    ms: Date.now() - started,
    summary: report?.summary ?? null,
    dir,
    report,
  };
  console.log(`child ${name}: exit ${result.status}, ${report?.summary ?? "no report"}`);
  return report;
}
const childCheck = (name, pattern) =>
  (children[name]?.report?.results ?? []).filter((result) => pattern.test(result.name));
/** Copies a child's checks matching `pattern` into the row, with its screenshots. */
function adopt(id, name, pattern, shotPattern) {
  const found = childCheck(name, pattern);
  if (found.length === 0) {
    row(id).checks.push({
      name: `${name}: ${pattern}`,
      ok: false,
      error: "the child run has no such check",
    });
    return [];
  }
  for (const result of found) row(id).checks.push({ ...result, name: `${name}: ${result.name}` });
  const dir = NodePath.join(children[name].dir, "screenshots");
  if (shotPattern && NodeFS.existsSync(dir))
    for (const file of NodeFS.readdirSync(dir)
      .filter((f) => shotPattern.test(f))
      .toSorted())
      row(id).screenshots.push(NodePath.join(dir, file));
  return found;
}

if (
  !skipChildren &&
  (wanted("B-01") || wanted("B-04") || wanted("B-05") || wanted("B-06") || wanted("C-02"))
)
  runChild("verify-canvas", "verify-canvas.mjs", ["--no-agent"]);
if (!skipChildren && (wanted("SL-01") || wanted("SL-05")))
  runChild("verify-slides", "verify-slides.mjs", []);

// ---- shared state between rows ---------------------------------------------------------------------
const state = {};

try {
  drive = await newPage("light", "drive");

  // ================================================================ C-04 and SL-01 =============
  if (wanted("C-04") || wanted("SL-01") || wanted("SL-02") || wanted("SL-04") || wanted("SL-05")) {
    const check = checkFor("C-04");
    step("C-04", "Gallery > Make something new > Design: read the dialog's fields, then Cancel.");
    step(
      "C-04",
      'Make something new > Slides: read the fields, title "Matchday launch", Save in Playground, system Matchday, Create slides.',
    );
    await check("the New slides dialog has the same fields as New design", async () => {
      await drive.goto(`${origin}/design`);
      await drive.getByTestId("design-gallery").waitFor({ timeout: 30000 });
      const fields = async (kind) => {
        await drive.locator(`[data-testid=design-create][data-kind="${kind}"]`).click();
        const dialog = drive.locator(`[data-testid=new-design-dialog][data-kind="${kind}"]`);
        await dialog.waitFor();
        const labels = (await dialog.locator("label").allTextContents()).map(norm);
        const title = norm(await dialog.getByRole("heading").first().textContent());
        const buttons = (await dialog.getByRole("button").allTextContents())
          .map(norm)
          .filter(Boolean);
        return { dialog, labels, title, buttons };
      };
      const design = await fields("design");
      await shot("C-04", drive, "new-design-dialog-light-1280");
      await design.dialog.getByRole("button", { name: "Cancel" }).click();
      await design.dialog.waitFor({ state: "detached" });
      const slides = await fields("slides");
      await shot("C-04", drive, "new-slides-dialog-light-1280");
      for (const label of ["Title", "Save in", "Design system"]) {
        assert(design.labels.includes(label), `New design lacks ${label}: ${design.labels}`);
        assert(slides.labels.includes(label), `New slides lacks ${label}: ${slides.labels}`);
      }
      assert(
        slides.buttons.some((b) => /Import PowerPoint/.test(b)),
        "no Import PowerPoint… in New slides",
      );
      const where = norm(await slides.dialog.getByTestId("new-design-where").textContent());
      measure("C-04", {
        designDialog: design,
        slidesDialog: { labels: slides.labels, title: slides.title, buttons: slides.buttons },
        defaultOwner: where,
      });
      delete row("C-04").measured.designDialog.dialog;
      await slides.dialog.getByLabel("Title").fill("Matchday launch");
      const system = await pickMatchday(slides.dialog, drive);
      measure("C-04", { systemOption: system });
      await slides.dialog.getByTestId("new-design-create").click();
      await drive.waitForURL(/\/design\/pg\./, { timeout: 30000 });
      await editorReady(drive);
      state.deckKey = designKeyFromUrl(drive);
      state.deckId = state.deckKey.split(".").at(-1);
      const document = await getDoc(PLAYGROUND, state.deckId);
      assert(
        document.kind === "slides" && document.designSystem === matchday.systemId,
        `deck ${document.kind} ${document.designSystem}`,
      );
      return {
        design: design.labels,
        slides: slides.labels,
        owner: where,
        system,
        deck: state.deckKey,
      };
    });
    await themedShots("C-04", "new-slides-dialog", async (page) => {
      await page.goto(`${origin}/design`);
      await page.getByTestId("design-gallery").waitFor({ timeout: 30000 });
      await page.locator('[data-testid=design-create][data-kind="slides"]').click();
      await page.locator('[data-testid=new-design-dialog][data-kind="slides"]').waitFor();
    });
  }

  if (state.deckId && (wanted("SL-01") || wanted("SL-02") || wanted("SL-04") || wanted("SL-05"))) {
    const id = "SL-01";
    const check = checkFor(id);
    const deckDoc = () => getDoc(PLAYGROUND, state.deckId);
    step(id, 'Entered from C-04: "Matchday launch" in the Playground on Matchday.');
    step(
      id,
      "Pick the title layout, then New slide > section, title and body, two columns, quote.",
    );
    await check("five slides from the layouts", async () => {
      await drive.getByTestId("slide-layout-prompt").waitFor();
      await drive.getByTestId("slide-layout-prompt").locator('[data-layout="title"]').click();
      await saved(drive);
      for (const layout of ["section", "title-body", "two-columns", "quote"]) {
        await drive.getByTestId("new-slide").first().click();
        const picker = drive.locator(`[data-testid=slide-layout][data-layout="${layout}"]`).last();
        await picker.waitFor();
        await picker.click();
        await saved(drive);
      }
      const document = await deckDoc();
      assert(document.pages.length === 5, `pages ${document.pages.length}`);
      assert((await slideItems(drive).count()) === 5, "the rail does not show five slides");
      const frame = document.pages[0].nodes[0];
      return {
        pages: document.pages.map((p) =>
          p.nodes
            .map((n) => n.name)
            .filter(Boolean)
            .join("|"),
        ),
        frame: `${frame.width}x${frame.height}`,
        fill: frame.fill,
      };
    });
    step(id, "Edit the first slide's title on the canvas: select, Enter, type, Cmd+Enter.");
    await check("edit the title text on the canvas", async () => {
      await slideItems(drive).nth(0).click();
      const document = await deckDoc();
      const title = document.pages[0].nodes.find(
        (node) => node.type === "text" && node.name === "Title",
      );
      assert(title, "no Title text on slide 1");
      const node = drive.getByTestId("design-canvas").locator(`[data-node="${title.id}"]`);
      await node.click();
      const layerName = async () =>
        drive
          .getByLabel("Layer name")
          .inputValue()
          .catch(() => null);
      if ((await layerName()) !== "Title") await node.dblclick();
      await focusCanvas(drive);
      await drive.keyboard.press("Enter");
      const area = drive.locator("[data-testid=design-canvas] textarea");
      await area.waitFor({ timeout: 5000 });
      await area.fill("Matchday launch");
      await drive.keyboard.press("ControlOrMeta+Enter");
      await saved(drive);
      const after = await waitFor(
        async () => {
          const text = (await deckDoc()).pages[0].nodes.find((n) => n.id === title.id)?.text;
          return text === "Matchday launch" ? text : null;
        },
        6000,
        "title text on the server",
      );
      await drive.keyboard.press("Escape");
      return { node: title.id, text: after, selectedByFirstClick: (await layerName()) === "Title" };
    });
    step(id, "Write speaker notes on each of the five slides.");
    await check("speaker notes on every slide", async () => {
      for (let index = 0; index < 5; index += 1) {
        await slideItems(drive).nth(index).click();
        const field = drive.getByTestId("speaker-notes-field");
        await field.click();
        await field.fill(`Matchday note ${index + 1}: say this while slide ${index + 1} shows.`);
        await drive.getByTestId("design-canvas").click({ position: { x: 12, y: 300 } });
        await saved(drive);
      }
      const document = await waitFor(
        async () => {
          const value = await deckDoc();
          return value.pages.every((page) => page.notes?.startsWith("Matchday note"))
            ? value
            : null;
        },
        8000,
        "notes on the server",
      );
      return { notes: document.pages.map((page) => page.notes) };
    });
    step(id, "Reorder: Alt+ArrowDown and Alt+ArrowUp on the rail, then drag slide 5 to the top.");
    await check("reorder by keyboard and by drag", async () => {
      const ids = async () => (await deckDoc()).pages.map((page) => page.id);
      const before = await ids();
      await slideItems(drive).nth(1).click();
      await slideItems(drive).nth(1).focus();
      await drive.keyboard.press("Alt+ArrowDown");
      await saved(drive);
      const down = await waitFor(
        async () => {
          const value = await ids();
          return value[2] === before[1] ? value : null;
        },
        6000,
        "Alt+ArrowDown",
      );
      await slideItems(drive).nth(2).focus();
      await drive.keyboard.press("Alt+ArrowUp");
      await saved(drive);
      await waitFor(async () => (await ids()).join() === before.join(), 6000, "Alt+ArrowUp");
      await slideItems(drive)
        .nth(4)
        .dragTo(slideItems(drive).nth(0), { targetPosition: { x: 30, y: 4 } });
      await saved(drive);
      const dragged = await waitFor(
        async () => {
          const value = await ids();
          return value[0] === before[4] ? value : null;
        },
        6000,
        "drag to the top",
      );
      return { before, down, dragged };
    });
    step(
      id,
      "Slide menu (right-click): Duplicate, Delete, Add slide after, Delete, Move down, Move up, Skip slide.",
    );
    await check("slide menu: Duplicate, Add after, Move, Skip, Delete", async () => {
      const pages = async () => (await deckDoc()).pages;
      await slideMenu(drive, 1, /^Duplicate/);
      await waitFor(async () => (await pages()).length === 6, 6000, "Duplicate");
      await slideMenu(drive, 2, /^Delete/);
      await waitFor(async () => (await pages()).length === 5, 6000, "Delete");
      await slideMenu(drive, 1, "Add slide after");
      await waitFor(async () => (await pages()).length === 6, 6000, "Add slide after");
      const blank = (await pages())[2];
      assert(blank.nodes.length <= 1, `the added slide is not blank: ${blank.nodes.length} nodes`);
      await slideMenu(drive, 2, /^Delete/);
      await waitFor(async () => (await pages()).length === 5, 6000, "Delete the blank slide");
      const order = (await pages()).map((page) => page.id);
      await slideMenu(drive, 1, /^Move down/);
      await waitFor(async () => (await pages())[2].id === order[1], 6000, "Move down");
      await slideMenu(drive, 2, /^Move up/);
      await waitFor(async () => (await pages())[1].id === order[1], 6000, "Move up");
      await slideMenu(drive, 3, "Skip slide");
      await waitFor(async () => (await pages())[3].skipped === true, 6000, "Skip slide");
      assert(
        (await slideItems(drive).nth(3).getAttribute("data-skipped")) === "true",
        "the rail does not mark the skipped slide",
      );
      await slideItems(drive).nth(0).click();
      await drive.waitForTimeout(300);
      await shot(id, drive, "rail-after-menu-light-1280");
      return {
        order: (await pages()).map((page) => ({ id: page.id, skipped: page.skipped === true })),
      };
    });
    step(id, "Present from slide 1: arrows, Space, Page Up/Down, Home/End, 3, F, Esc.");
    await check("Present keys leave out the skipped slide", async () => {
      await slideItems(drive).nth(0).click();
      await drive.getByRole("button", { name: "Present", exact: true }).click();
      const present = drive.getByTestId("present-mode");
      await present.waitFor();
      const position = async () => norm(await drive.getByTestId("present-position").textContent());
      const trail = [await position()];
      for (const key of [
        "ArrowRight",
        " ",
        "PageDown",
        "ArrowRight",
        "PageUp",
        "ArrowLeft",
        "End",
        "Home",
        "3",
        "9",
      ]) {
        await drive.keyboard.press(key);
        await drive.waitForTimeout(120);
        trail.push(`${key === " " ? "Space" : key}:${await position()}`);
      }
      const expected = [
        "1 / 4",
        "ArrowRight:2 / 4",
        "Space:3 / 4",
        "PageDown:4 / 4",
        "ArrowRight:4 / 4",
        "PageUp:3 / 4",
        "ArrowLeft:2 / 4",
        "End:4 / 4",
        "Home:1 / 4",
        "3:3 / 4",
        "9:3 / 4",
      ];
      assert(trail.join() === expected.join(), `trail ${trail.join(", ")}`);
      await shot(id, drive, "present-light-1280");
      await drive.keyboard.press("f");
      await drive.waitForTimeout(400);
      const fullscreen = await drive.evaluate(() => document.fullscreenElement !== null);
      await drive.keyboard.press("Escape");
      let presses = 1;
      if (await present.isVisible().catch(() => false)) {
        await drive.waitForTimeout(300);
        if (await present.isVisible().catch(() => false)) {
          await drive.keyboard.press("Escape");
          presses = 2;
        }
      }
      await present.waitFor({ state: "detached", timeout: 3000 });
      return { trail, fullscreen, escapePresses: presses };
    });
    step(id, "Presenter view: current, next, notes and a running timer.");
    await check("Presenter view shows current, next, notes and timer", async () => {
      await slideItems(drive).nth(0).click();
      await drive.getByRole("button", { name: "Presenter view", exact: true }).click();
      const view = drive.getByTestId("presenter-view");
      await view.waitFor();
      await drive.getByTestId("presenter-current").locator("[data-node]").first().waitFor();
      await drive.getByTestId("presenter-next").locator("[data-node]").first().waitFor();
      const notes = norm(await drive.getByTestId("presenter-notes").textContent());
      const first = (await deckDoc()).pages[0].notes;
      assert(notes === norm(first), `notes "${notes}" against "${first}"`);
      const t0 = await drive.getByTestId("presenter-timer").textContent();
      await drive.waitForTimeout(2200);
      const t1 = await drive.getByTestId("presenter-timer").textContent();
      assert(t0 !== t1, `timer stuck at ${t0}`);
      await drive.keyboard.press("ArrowRight");
      await drive.waitForTimeout(200);
      const nextNotes = norm(await drive.getByTestId("presenter-notes").textContent());
      await shot(id, drive, "presenter-light-1280");
      await drive.keyboard.press("Escape");
      await drive.waitForTimeout(300);
      if (await view.isVisible().catch(() => false)) await drive.keyboard.press("Escape");
      await drive.getByTestId("present-mode").waitFor({ state: "detached", timeout: 3000 });
      return { notes, timer: [t0, t1], notesFollowArrow: nextNotes !== notes };
    });
    step(
      id,
      "Show the skipped slide again, export PDF and PowerPoint, read the PPTX back with python-pptx, reload.",
    );
    await check("PDF and PPTX export; the read-back matches", async () => {
      await slideMenu(drive, 3, "Show slide");
      await waitFor(async () => (await deckDoc()).pages[3].skipped !== true, 6000, "Show slide");
      const pdf = await exportFromMenu(
        drive,
        "PDF of all slides",
        NodePath.join(exportsDir, "SL-01-matchday-launch.pdf"),
      );
      const pptx = await exportFromMenu(
        drive,
        "PowerPoint of all slides",
        NodePath.join(exportsDir, "SL-01-matchday-launch.pptx"),
      );
      state.sl01Pptx = pptx.file;
      const document = await deckDoc();
      const pages = pdfPages(pdf.file);
      assert(pages === 5, `the PDF has ${pages} pages`);
      const back = readBack(pptx.file, document);
      row(id).exports.push(pdf.file, pptx.file);
      assert(back.differences.length === 0, back.differences.join("; "));
      await drive.reload();
      await editorReady(drive);
      assert((await slideItems(drive).count()) === 5, "reload lost slides");
      const reloaded = await deckDoc();
      assert(
        reloaded.pages.every((page) => page.notes?.startsWith("Matchday note")),
        "reload lost notes",
      );
      state.deckOutline = deckOutline(reloaded);
      measure(id, { pdfPages: pages, readBack: back });
      return { pdfPages: pages, pptxSlides: back.slides, differences: back.differences };
    });
    await themedShots(id, "editor", (page) => openDesign(page, state.deckKey));
    if (children["verify-slides"]) {
      step(
        id,
        "Also counted: verify-slides.mjs on its own Harbor deck (layouts, notes, drag and keyboard reorder, menu, Present keys, Presenter view, PDF and PPTX).",
      );
      adopt(id, "verify-slides", /./, /^(04|05|06|07|09)-/);
    }
  }

  // ================================================================ SL-02 =======================
  if (wanted("SL-02")) {
    const id = "SL-02";
    const check = checkFor(id);
    NodeFS.copyFileSync(
      thirdParty,
      NodePath.join(exportsDir, "SL-02-source-third-party-6-slides.pptx"),
    );
    const source = python("read", thirdParty);
    async function importDeck(label, file, via) {
      const before = (await designsOf()).map((design) => design.ref.designId);
      await drive.goto(`${origin}/design`);
      await drive.getByTestId("design-gallery").waitFor({ timeout: 30000 });
      const dialog = drive.locator('[data-testid=new-design-dialog][data-kind="slides"]');
      if (via === "row") {
        await drive.getByTestId("design-import-pptx-input").setInputFiles(file);
        await dialog.waitFor();
      } else {
        await drive.locator('[data-testid=design-create][data-kind="slides"]').click();
        await dialog.waitFor();
        await dialog.getByTestId("import-pptx-input").setInputFiles(file);
      }
      await dialog.getByTestId("import-pptx-file").waitFor();
      const system = await pickMatchday(dialog, drive);
      await shot(id, drive, `${label}-import-dialog-light-1280`);
      await dialog.getByTestId("new-design-create").click();
      const created = await waitFor(
        async () => {
          const alert = dialog.getByRole("alert");
          if (await alert.isVisible().catch(() => false))
            throw new Error(`import refused: ${await alert.innerText()}`);
          return (
            (await designsOf()).find((design) => !before.includes(design.ref.designId)) ?? null
          );
        },
        120000,
        "the imported deck",
      );
      let skipped = [];
      const notImported = drive.getByTestId("deck-not-imported");
      const opened = await Promise.race([
        notImported.waitFor({ timeout: 30000 }).then(() => "list"),
        drive.waitForURL(/\/design\/pg\./, { timeout: 30000 }).then(() => "editor"),
      ]);
      if (opened === "list") {
        skipped = (await notImported.locator("ul ul li").allTextContents()).map(norm);
        await shot(id, drive, `${label}-not-imported-light-1280`);
        await drive.getByTestId("deck-not-imported-open").click();
        await drive.waitForURL(/\/design\/pg\./, { timeout: 30000 });
      }
      await editorReady(drive);
      const key = designKeyFromUrl(drive);
      assert(key.endsWith(created.ref.designId), `opened ${key}, created ${created.ref.designId}`);
      return { designId: created.ref.designId, key, system, skipped };
    }
    async function useDeck(label, imported, expected) {
      const document = await getDoc(PLAYGROUND, imported.designId);
      assert(document.kind === "slides", `kind ${document.kind}`);
      assert(
        document.pages.length === expected.slides.length,
        `slides ${document.pages.length}, source ${expected.slides.length}`,
      );
      const outline = deckOutline(document);
      const missing = [];
      expected.slides.forEach((slide, index) => {
        const have = outline[index].texts.join(" ");
        for (const text of slide.texts)
          for (const part of text.split(/\n/))
            if (norm(part) && !have.includes(norm(part)))
              missing.push(`slide ${index + 1}: ${norm(part)}`);
        if (norm(slide.notes) !== outline[index].notes) missing.push(`slide ${index + 1} notes`);
      });
      const pictures = expected.slides.reduce((sum, slide) => sum + slide.pictures, 0);
      const images = outline.reduce((sum, slide) => sum + slide.images, 0);
      // Edit: nudge the first slide's first text, which must save.
      await slideItems(drive).nth(0).click();
      const text = document.pages[0].nodes.find((node) => node.type === "text");
      const node = drive.getByTestId("design-canvas").locator(`[data-node="${text.id}"]`);
      await node.click();
      if (
        (await drive
          .getByLabel("Layer name")
          .inputValue()
          .catch(() => null)) !== (text.name ?? "")
      )
        await node.dblclick();
      await focusCanvas(drive);
      await drive.keyboard.press("Shift+ArrowRight");
      await saved(drive);
      const moved = await waitFor(
        async () => {
          const value = (await getDoc(PLAYGROUND, imported.designId)).pages[0].nodes.find(
            (n) => n.id === text.id,
          );
          return value.x !== text.x ? value : null;
        },
        6000,
        "the nudge on the server",
      );
      await drive.keyboard.press("Escape");
      await shot(id, drive, `${label}-editor-light-1280`);
      // Present.
      await slideItems(drive).nth(0).click();
      await drive.getByRole("button", { name: "Present", exact: true }).click();
      await drive.getByTestId("present-mode").waitFor();
      const first = norm(await drive.getByTestId("present-position").textContent());
      await drive.keyboard.press("End");
      const last = norm(await drive.getByTestId("present-position").textContent());
      await shot(id, drive, `${label}-present-light-1280`);
      await drive.keyboard.press("Escape");
      await drive.getByTestId("present-mode").waitFor({ state: "detached", timeout: 3000 });
      // Export and read back.
      const pptx = await exportFromMenu(
        drive,
        "PowerPoint of all slides",
        NodePath.join(exportsDir, `SL-02-${label}.pptx`),
      );
      const pdf = await exportFromMenu(
        drive,
        "PDF of all slides",
        NodePath.join(exportsDir, `SL-02-${label}.pdf`),
      );
      row(id).exports.push(pptx.file, pdf.file);
      const back = readBack(pptx.file, await getDoc(PLAYGROUND, imported.designId));
      const result = {
        designId: imported.designId,
        slides: document.pages.length,
        missing,
        pictures: { source: pictures, imageNodes: images, exported: back.pictures },
        notImported: imported.skipped,
        nudge: { from: text.x, to: moved.x },
        present: [first, last],
        pdfPages: pdfPages(pdf.file),
        readBack: back,
      };
      measure(id, { [label]: result });
      // A table is not imported; the list must say so instead of dropping it silently.
      const tables = expected.slides.filter((slide) => slide.tables.length > 0).length;
      const listedTables = imported.skipped.filter((line) => /^Table\b/.test(line)).length;
      result.tables = { source: tables, listed: listedTables };
      assert(missing.length === 0, `missing after import: ${missing.join("; ")}`);
      assert(
        listedTables === tables,
        `${tables} tables in the source, ${listedTables} listed as not imported`,
      );
      assert(images >= pictures, `${images} image nodes for ${pictures} pictures`);
      assert(
        first === `1 / ${expected.slides.length}` &&
          last === `${expected.slides.length} / ${expected.slides.length}`,
        `present ${first} to ${last}`,
      );
      assert(back.differences.length === 0, back.differences.join("; "));
      return result;
    }
    if (state.sl01Pptx) {
      step(
        id,
        "(a) Make something new > Import PowerPoint… with SL-01's own PPTX export (round trip), Playground, Matchday.",
      );
      await check(
        "(a) round trip of SL-01's PPTX: imports, edits, presents and exports",
        async () => {
          const imported = await importDeck("roundtrip", state.sl01Pptx, "row");
          return useDeck("roundtrip", imported, python("read", state.sl01Pptx));
        },
      );
    } else row(id).notes.push("(a) not run: SL-01 produced no PPTX.");
    step(
      id,
      "(b) New slides > Import PowerPoint… with a 6-slide python-pptx deck: title, bullets, two columns, picture, shapes, table, notes.",
    );
    await check(
      "(b) third-party deck: count, text, notes and picture arrive; the rest is listed",
      async () => {
        const imported = await importDeck("third-party", thirdParty, "dialog");
        assert(imported.skipped.length > 0, "nothing was listed as not imported (star and table)");
        return useDeck("third-party", imported, source);
      },
    );
    await themedShots(id, "imported-editor", async (page) => {
      const latest = (await designsOf())
        .filter((d) => d.kind === "slides")
        .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      await openDesign(page, keyOf(latest.ref.owner, latest.ref.designId));
    });
  }

  // ================================================================ SL-03 =======================
  if (wanted("SL-03")) {
    const id = "SL-03";
    const check = checkFor(id);
    step(
      id,
      "No provider turn: design.create (kind slides, Playground, Matchday) and one design.apply, the RPCs an agent's design_create and design_apply call.",
    );
    await check(
      "design.create and design.apply build a 4-slide deck; no thread or turn",
      async () => {
        const threadsBefore = (await shellThreads()).length;
        const created = await rpc("design.create", {
          owner: PLAYGROUND,
          kind: "slides",
          title: "EasyChamp season recap",
          designSystem: matchday.systemId,
        });
        const designId = created.ref.designId;
        const first = created.document.pages[0];
        const frame = first.nodes[0];
        const paint = (token) => ({ token });
        const texts = (frameId, prefix, title, body) => [
          {
            id: `${prefix}_title`,
            parentId: frameId,
            type: "text",
            name: "Title",
            text: title,
            x: 128,
            y: 160,
            width: 1664,
            height: 180,
            fontSize: 96,
            fontWeight: 700,
            color: paint("mx-foreground"),
            fontFamily: paint("mx-font-display"),
          },
          {
            id: `${prefix}_body`,
            parentId: frameId,
            type: "text",
            name: "Body",
            text: body,
            x: 128,
            y: 420,
            width: 1664,
            height: 400,
            fontSize: 44,
            color: paint("mx-muted-foreground"),
            fontFamily: paint("mx-font-sans"),
          },
        ];
        const slides = [
          ["EasyChamp season recap", "Harbor FC, spring season", "Open with the headline numbers."],
          ["38 matches played", "31 on time, 7 moved for weather", "Mention the weather weeks."],
          [
            "Registrations doubled",
            "Online sign-up replaced paper sheets",
            "Credit the volunteers who switched.",
          ],
          ["Next season", "Two new youth teams and a floodlit pitch", "End on the floodlights."],
        ];
        const operations = [
          {
            op: "update_node",
            pageId: first.id,
            id: frame.id,
            patch: { fill: paint("mx-background") },
          },
          ...texts(frame.id, "s1", slides[0][0], slides[0][1]).map((node) => ({
            op: "add_node",
            pageId: first.id,
            node,
          })),
          { op: "update_page", pageId: first.id, notes: slides[0][2] },
          ...slides.slice(1).map(([title, body, notes], index) => {
            const pageId = `p_recap${index + 2}`;
            const frameId = `f_recap${index + 2}`;
            return {
              op: "add_page",
              page: {
                id: pageId,
                name: `Slide ${index + 2}`,
                notes,
                nodes: [
                  {
                    id: frameId,
                    parentId: null,
                    type: "frame",
                    name: `Slide ${index + 2}`,
                    x: 0,
                    y: 0,
                    width: 1920,
                    height: 1080,
                    fill: paint("mx-background"),
                  },
                  ...texts(frameId, `s${index + 2}`, title, body),
                ],
              },
            };
          }),
        ];
        const applied = await rpc("design.apply", {
          owner: PLAYGROUND,
          designId,
          expectedRevision: created.document.revision,
          operations,
        });
        state.recapKey = keyOf(PLAYGROUND, designId);
        state.recapId = designId;
        const threadsAfter = (await shellThreads()).length;
        assert(applied.document.pages.length === 4, `pages ${applied.document.pages.length}`);
        assert(threadsAfter === threadsBefore, `threads ${threadsBefore} -> ${threadsAfter}`);
        return {
          designId,
          operations: operations.length,
          revision: applied.document.revision,
          threads: [threadsBefore, threadsAfter],
        };
      },
    );
    step(
      id,
      "Open it in the editor: the rail, the notes field, Present to the end, then PDF and PPTX export and the python-pptx read-back.",
    );
    await check("the deck opens with a working rail and notes; the read-back matches", async () => {
      assert(state.recapKey, "no deck");
      const page = drive;
      const before = allCommands.reduce((sum, seen) => sum + seen.messageDispatch.length, 0);
      await openDesign(page, state.recapKey);
      assert((await slideItems(page).count()) === 4, "the rail does not show four slides");
      await slideItems(page).nth(2).click();
      const notes = await page.getByTestId("speaker-notes-field").inputValue();
      assert(notes === "Credit the volunteers who switched.", `notes ${notes}`);
      await shot(id, page, "editor-slide3-light-1280");
      await slideItems(page).nth(0).click();
      await page.getByRole("button", { name: "Present", exact: true }).click();
      await page.getByTestId("present-mode").waitFor();
      await page.keyboard.press("End");
      const position = norm(await page.getByTestId("present-position").textContent());
      await page.keyboard.press("Escape");
      assert(position === "4 / 4", `present ${position}`);
      const pdf = await exportFromMenu(
        page,
        "PDF of all slides",
        NodePath.join(exportsDir, "SL-03-easychamp-season-recap.pdf"),
      );
      const pptx = await exportFromMenu(
        page,
        "PowerPoint of all slides",
        NodePath.join(exportsDir, "SL-03-easychamp-season-recap.pptx"),
      );
      row(id).exports.push(pdf.file, pptx.file);
      const back = readBack(pptx.file, await getDoc(PLAYGROUND, state.recapId));
      const pages = pdfPages(pdf.file);
      const after = allCommands.reduce((sum, seen) => sum + seen.messageDispatch.length, 0);
      measure(id, { readBack: back, pdfPages: pages, messageDispatch: after - before });
      assert(pages === 4, `PDF pages ${pages}`);
      assert(back.differences.length === 0, back.differences.join("; "));
      assert(after === before, "a message was dispatched");
      return { notes, present: position, pdfPages: pages, pptxSlides: back.slides };
    });
    if (state.recapKey) await themedShots(id, "editor", (page) => openDesign(page, state.recapKey));
  }

  // ================================================================ SL-04 =======================
  if (wanted("SL-04")) {
    const id = "SL-04";
    const check = checkFor(id);
    step(
      id,
      'Project board (/design?project=) > Make something new > Slides: Save in is the project, Matchday copied in, title "Matchday web deck"; two layouts with notes.',
    );
    await check(
      "a deck made from the project board lands in the repository with its notes",
      async () => {
        await drive.goto(`${origin}/design?project=${encodeURIComponent(projectId)}`);
        await drive.getByTestId("design-gallery").waitFor({ timeout: 30000 });
        await drive.locator('[data-testid=design-create][data-kind="slides"]').click();
        const dialog = drive.locator('[data-testid=new-design-dialog][data-kind="slides"]');
        await dialog.waitFor();
        const where = norm(await dialog.getByTestId("new-design-where").textContent());
        assert(where === "Matchday web", `Save in reads ${where}`);
        await dialog.getByLabel("Title").fill("Matchday web deck");
        const system = await pickMatchday(dialog, drive);
        await dialog.getByTestId("new-design-create").click();
        await drive.waitForURL(new RegExp(`/design/p\\.${projectId}\\.`), { timeout: 30000 });
        await editorReady(drive);
        const designId = designKeyFromUrl(drive).split(".").at(-1);
        await drive.getByTestId("slide-layout-prompt").locator('[data-layout="title"]').click();
        await saved(drive);
        await drive.getByTestId("new-slide").first().click();
        await drive.locator('[data-testid=slide-layout][data-layout="quote"]').last().click();
        await saved(drive);
        for (let index = 0; index < 2; index += 1) {
          await slideItems(drive).nth(index).click();
          await drive.getByTestId("speaker-notes-field").fill(`Project deck note ${index + 1}.`);
          await drive.getByTestId("design-canvas").click({ position: { x: 12, y: 300 } });
          await saved(drive);
        }
        const file = repoDesignFile(designId);
        const json = await waitFor(
          async () => {
            if (!NodeFS.existsSync(file)) return null;
            const value = JSON.parse(NodeFS.readFileSync(file, "utf8"));
            return value.pages?.filter((p) => p.notes?.startsWith("Project deck note")).length === 2
              ? value
              : null;
          },
          8000,
          "notes in the repository file",
        );
        const systemFile = NodePath.join(
          repo,
          ".specweave/design/systems",
          json.designSystem,
          "system.json",
        );
        await shot(id, drive, "project-deck-light-1280");
        return {
          designId,
          file,
          pages: json.pages.length,
          system,
          systemInRepository: NodeFS.existsSync(systemFile),
        };
      },
    );
    step(
      id,
      'Gallery card menu on "Matchday launch": Duplicate; then the copy\'s menu: Connect to a project… > Matchday web > Move.',
    );
    await check(
      "a copy of SL-01 connects to the project with its id, slides and notes",
      async () => {
        assert(state.deckId, "SL-01 made no deck");
        await drive.goto(`${origin}/design?tab=playground`);
        await drive.getByTestId("design-gallery").waitFor({ timeout: 30000 });
        const before = (await designsOf()).map((design) => design.ref.designId);
        await drive
          .getByRole("button", { name: "Actions for Matchday launch", exact: true })
          .first()
          .click();
        await drive.getByRole("menuitem", { name: "Duplicate" }).click();
        // Duplicate copies, then renames the copy "<title> copy": wait for both.
        const copy = await waitFor(
          async () =>
            (await designsOf()).find(
              (d) => !before.includes(d.ref.designId) && d.title === "Matchday launch copy",
            ) ?? null,
          15000,
          "the renamed copy",
        );
        const copiesBefore = await projectCopies();
        assert(copy.ref.owner.kind === "playground", `copy owner ${copy.ref.owner.kind}`);
        const original = await getDoc(PLAYGROUND, copy.ref.designId);
        const history = (
          await rpc("design.history", { owner: PLAYGROUND, designId: copy.ref.designId })
        ).entries.length;
        await drive
          .getByRole("button", { name: `Actions for ${copy.title}`, exact: true })
          .first()
          .click();
        await drive.getByRole("menuitem", { name: "Connect to a project…" }).click();
        const dialog = drive.getByTestId("connect-design-dialog");
        await dialog.waitFor();
        await dialog.getByTestId("connect-design-project").click();
        await pickOption(drive, /^Matchday web$/);
        await shot(id, drive, "connect-dialog-light-1280");
        await dialog.getByTestId("connect-design-move").click();
        const moved = await waitFor(
          async () =>
            (await designsOf()).find(
              (d) => d.ref.designId === copy.ref.designId && d.ref.owner.kind === "project",
            ) ?? null,
          30000,
          "the moved deck",
        );
        const document = await getDoc(projectOwner, copy.ref.designId);
        const sameNotes =
          document.pages.map((p) => p.notes).join("|") ===
          original.pages.map((p) => p.notes).join("|");
        const historyAfter = (
          await rpc("design.history", { owner: projectOwner, designId: copy.ref.designId })
        ).entries.length;
        const file = repoDesignFile(copy.ref.designId);
        assert(
          document.pages.length === original.pages.length && sameNotes,
          "slides or notes changed in the move",
        );
        assert(NodeFS.existsSync(file), `no ${file}`);
        assert(historyAfter >= history, `history ${history} -> ${historyAfter}`);
        const copiesAfter = await projectCopies();
        measure(id, {
          connect: {
            designId: copy.ref.designId,
            slides: document.pages.length,
            history: [history, historyAfter],
            file,
            projectCopiesOfMatchday: [copiesBefore, copiesAfter],
          },
        });
        if (copiesAfter > copiesBefore && copiesBefore > 0)
          row(id).notes.push(
            `Observation: the move copied Matchday into Matchday web under its Playground id although the project already held a copy made by New slides (another id): ${copiesBefore} -> ${copiesAfter} systems named Matchday there. 1046 AC-02 copies a system the project lacks by id, so this is by design, but the picker then lists two Matchday systems.`,
          );
        return {
          designId: copy.ref.designId,
          owner: moved.ref.owner,
          slides: document.pages.length,
          notesKept: sameNotes,
          history: [history, historyAfter],
          file,
        };
      },
    );
    await themedShots(id, "project-board", async (page) => {
      await page.goto(`${origin}/design?project=${encodeURIComponent(projectId)}`);
      await page.getByTestId("design-gallery").waitFor({ timeout: 30000 });
    });
  }

  // ================================================================ SL-05 =======================
  if (wanted("SL-05") && state.deckKey) {
    const id = "SL-05";
    const check = checkFor(id);
    step(
      id,
      "SL-01's editor, Present and Presenter view at 360 and 768 px and at 1280 px with 200% zoom (640 CSS px, scale 2), light and dark.",
    );
    step(
      id,
      "Measure: rail compact and clear of the canvas, header items not overlapping and inside the window, no sideways scroll, the AA contrast scan (theme-contrast-scan.js) of the editor.",
    );
    const sizes = [
      { label: "360", width: 360, height: 780 },
      { label: "768", width: 768, height: 900 },
      { label: "1280-zoom200", width: 640, height: 400, scale: 2 },
    ];
    for (const size of sizes)
      for (const theme of ["light", "dark"])
        await check(
          `${size.label} ${theme}: rail, header, overflow, contrast, Present`,
          async () => {
            const sized = await context({
              colorScheme: theme,
              viewport: { width: size.width, height: size.height },
              ...(size.scale ? { deviceScaleFactor: size.scale } : {}),
            });
            const page = await sized.newPage();
            current = page;
            watchErrors(page, `SL-05-${size.label}-${theme}`, errors);
            allCommands.push(watchCommands(page));
            try {
              await openDesign(page, state.deckKey);
              await page.waitForTimeout(600);
              await shot(id, page, `editor-${theme}-${size.label}`);
              const layout = await page.evaluate(() => {
                const rect = (el) => {
                  if (!el) return null;
                  const r = el.getBoundingClientRect();
                  return {
                    x: Math.round(r.x),
                    y: Math.round(r.y),
                    w: Math.round(r.width),
                    h: Math.round(r.height),
                  };
                };
                const header = document.querySelector(
                  "[data-testid=design-editor] header, [data-testid=design-editor] > div > *:first-child",
                );
                const items = header
                  ? [...header.querySelectorAll("button, input, [data-testid=save-state], h1")]
                      .filter((el) => {
                        const r = el.getBoundingClientRect();
                        const style = getComputedStyle(el);
                        return (
                          r.width > 0 &&
                          r.height > 0 &&
                          style.visibility !== "hidden" &&
                          !el.closest("[hidden]") &&
                          el.parentElement?.closest("button") === null
                        );
                      })
                      .map((el) => ({
                        name: el.getAttribute("aria-label") ?? el.textContent.trim().slice(0, 24),
                        ...rect(el),
                      }))
                  : [];
                const overlaps = [];
                for (let i = 0; i < items.length; i += 1)
                  for (let j = i + 1; j < items.length; j += 1) {
                    const a = items[i];
                    const b = items[j];
                    if (
                      a.x < b.x + b.w - 1 &&
                      b.x < a.x + a.w - 1 &&
                      a.y < b.y + b.h - 1 &&
                      b.y < a.y + a.h - 1
                    )
                      overlaps.push(`${a.name} / ${b.name}`);
                  }
                const share = document.querySelector('[aria-label="Share"]');
                const railEl = document.querySelector("[data-testid=slide-rail]");
                const canvasEl = document.querySelector("[data-testid=design-canvas]");
                return {
                  viewport: { w: innerWidth, h: innerHeight },
                  scrollWidth: document.documentElement.scrollWidth,
                  share: rect(share),
                  rail: rect(railEl),
                  railCompact: railEl?.getAttribute("data-compact") ?? null,
                  canvas: rect(canvasEl),
                  headerItems: items.length,
                  overlaps,
                };
              });
              const scan = await page.evaluate(contrastScan);
              const problems = [];
              if (layout.scrollWidth > layout.viewport.w + 1)
                problems.push(
                  `page scrolls sideways (${layout.scrollWidth} > ${layout.viewport.w})`,
                );
              if (layout.share && layout.share.x + layout.share.w > layout.viewport.w + 1)
                problems.push(`Share ends at ${layout.share.x + layout.share.w}`);
              if (
                layout.rail &&
                layout.canvas &&
                layout.rail.x + layout.rail.w > layout.canvas.x + 1 &&
                layout.rail.y < layout.canvas.y + layout.canvas.h
              )
                problems.push(
                  `rail ${JSON.stringify(layout.rail)} overlaps the canvas ${JSON.stringify(layout.canvas)}`,
                );
              if (layout.overlaps.length > 0)
                problems.push(`header overlaps: ${layout.overlaps.join(", ")}`);
              if (scan.failures.length > 0)
                problems.push(
                  `contrast below AA: ${scan.failures
                    .slice(0, 6)
                    .map((f) => `${f.text ?? f.selector ?? ""} ${f.ratio ?? ""}`.trim())
                    .join("; ")}`,
                );
              // Present and the Presenter view at this size.
              // Narrow headers move Present into More; wide ones show the button.
              const presentButton = page.getByRole("button", { name: "Present", exact: true });
              const presentFrom = (await presentButton.isVisible().catch(() => false))
                ? "header"
                : "More menu";
              if (presentFrom === "header") await presentButton.click();
              else {
                await page.getByTestId("design-header-more").click();
                await page.getByRole("menuitem", { name: "Present", exact: true }).click();
              }
              await page.getByTestId("present-mode").waitFor();
              await page.waitForTimeout(400);
              const stage = await page.evaluate(() => {
                const frame = document.querySelector("[data-testid=present-mode] [data-node]");
                const r = frame?.getBoundingClientRect();
                return r
                  ? {
                      x: Math.round(r.x),
                      y: Math.round(r.y),
                      w: Math.round(r.width),
                      h: Math.round(r.height),
                      vw: innerWidth,
                      vh: innerHeight,
                    }
                  : null;
              });
              await shot(id, page, `present-${theme}-${size.label}`);
              if (
                !stage ||
                stage.x < -1 ||
                stage.y < -1 ||
                stage.x + stage.w > stage.vw + 1 ||
                stage.y + stage.h > stage.vh + 1
              )
                problems.push(`Present slide outside the window: ${JSON.stringify(stage)}`);
              await page.keyboard.press("p");
              await page.getByTestId("presenter-view").waitFor({ timeout: 5000 });
              await page.waitForTimeout(400);
              const presenter = await page.evaluate(() => {
                const box = (sel) => {
                  const r = document.querySelector(sel)?.getBoundingClientRect();
                  return r ? { w: Math.round(r.width), h: Math.round(r.height) } : null;
                };
                return {
                  current: box("[data-testid=presenter-current-box]"),
                  notes: box("[data-testid=presenter-notes]"),
                };
              });
              await shot(id, page, `presenter-${theme}-${size.label}`);
              if (!presenter.current || presenter.current.w < Math.min(240, size.width * 0.5))
                problems.push(`Presenter current slide is ${presenter.current?.w ?? 0} px wide`);
              await page.keyboard.press("Escape");
              const result = {
                presentFrom,
                layout,
                contrast: { checked: scan.checked, failures: scan.failures.slice(0, 20) },
                present: stage,
                presenter,
                problems,
              };
              measure(id, { [`${size.label}-${theme}`]: result });
              assert(problems.length === 0, problems.join(" | "));
              return { checked: scan.checked, rail: layout.railCompact, problems: problems.length };
            } finally {
              current = null;
              await sized.close();
            }
          },
        );
    if (children["verify-slides"])
      adopt(id, "verify-slides", /^(1280x800|1024x768):/, /^02[bc]-narrow/);
  }

  // ================================================================ C-01 ========================
  if (wanted("C-01") || wanted("B-08") || wanted("B-07")) {
    const id = "C-01";
    const check = checkFor(id);
    /** New design from `url`, drawn with a frame, a rectangle and text, each set to tokens. */
    async function blankDesign(url, title, expectOwner) {
      await drive.goto(url);
      await drive.getByTestId("design-gallery").waitFor({ timeout: 30000 });
      await drive.locator('[data-testid=design-create][data-kind="design"]').click();
      const dialog = drive.locator('[data-testid=new-design-dialog][data-kind="design"]');
      await dialog.waitFor();
      const where = norm(await dialog.getByTestId("new-design-where").textContent());
      assert(where === expectOwner, `Save in reads ${where}`);
      await dialog.getByLabel("Title").fill(title);
      const system = await pickMatchday(dialog, drive);
      await dialog.getByTestId("new-design-create").click();
      await drive.waitForURL(/\/design\/p/, { timeout: 30000 });
      await editorReady(drive);
      const key = designKeyFromUrl(drive);
      const owner = ownerOfKey(key);
      const designId = key.split(".").at(-1);
      const doc = () => getDoc(owner, designId);
      const nodesBefore = new Set((await doc()).pages[0].nodes.map((n) => n.id));
      const added = async (type) =>
        waitFor(
          async () =>
            (await doc()).pages[0].nodes.find((n) => n.type === type && !nodesBefore.has(n.id)) ??
            null,
          6000,
          `new ${type}`,
        );
      const tokenPick = async (label, token) => {
        await drive
          .getByTestId("properties-panel")
          .getByRole("button", { name: new RegExp(`^${label}`) })
          .first()
          .click();
        await drive
          .getByRole("option", { name: new RegExp(`^${token}\\b`) })
          .first()
          .click();
        await saved(drive);
      };
      await focusCanvas(drive);
      await drive.keyboard.press("Escape");
      await drive.keyboard.press("f");
      await drive.keyboard.press("Enter");
      await saved(drive);
      const frame = await added("frame");
      await tokenPick("Fill:", "mx-card");
      await focusCanvas(drive);
      await drive.keyboard.press("Escape");
      await drive.keyboard.press("r");
      await drive.keyboard.press("Enter");
      await saved(drive);
      const rect = await added("rect");
      await tokenPick("Fill:", "mx-primary");
      await focusCanvas(drive);
      await drive.keyboard.press("Escape");
      await drive.keyboard.press("t");
      await drive.keyboard.press("Enter");
      await drive.locator("[data-testid=design-canvas] textarea").fill("Kickoff 19:30");
      await drive.keyboard.press("ControlOrMeta+Enter");
      await saved(drive);
      const text = await added("text");
      await tokenPick("Color:", "mx-foreground");
      await drive
        .getByTestId("properties-panel")
        .getByRole("button", { name: /^Font family:/ })
        .click();
      await drive
        .getByRole("option", { name: /^mx-font-display\b/ })
        .first()
        .click();
      await saved(drive);
      const before = await doc();
      const nodes = (document) => JSON.stringify(document.pages.map((page) => page.nodes));
      await drive.reload();
      await editorReady(drive);
      const after = await doc();
      const picker = norm(
        await drive.getByTestId("design-system-picker").getByRole("combobox").textContent(),
      );
      const fill = await drive
        .locator(`[data-node="${rect.id}"]`)
        .first()
        .evaluate((el) => getComputedStyle(el).backgroundColor);
      const final = after.pages[0].nodes;
      const byId = (nodeId) => final.find((n) => n.id === nodeId);
      assert(
        after.revision === before.revision && nodes(after) === nodes(before),
        "the reload changed the design",
      );
      assert(
        byId(rect.id).fill?.token === "mx-primary",
        `rect fill ${JSON.stringify(byId(rect.id).fill)}`,
      );
      assert(
        byId(frame.id).fill?.token === "mx-card",
        `frame fill ${JSON.stringify(byId(frame.id).fill)}`,
      );
      assert(
        byId(text.id).color?.token === "mx-foreground" &&
          byId(text.id).fontFamily?.token === "mx-font-display",
        "text tokens",
      );
      assert(fill === rgb("#0a6b3d"), `rect renders ${fill}`);
      assert(picker.startsWith("Matchday"), `the picker reads ${picker}`);
      return {
        key,
        owner,
        system,
        systemId: after.designSystem,
        revision: after.revision,
        nodes: { frame: frame.id, rect: rect.id, text: text.id },
        renderedFill: fill,
        picker,
      };
    }
    step(
      id,
      'Playground: Make something new > Design, Matchday, "Matchday board". Keyboard F, R, T: a frame (fill mx-card), a rectangle (fill mx-primary), text "Kickoff 19:30" (color mx-foreground, font mx-font-display). Reload.',
    );
    const pg = await check(
      "Playground: create on Matchday, draw, apply tokens, reload unchanged",
      async () => {
        const result = await blankDesign(`${origin}/design`, "Matchday board", "Playground");
        assert(result.systemId === matchday.systemId, `system ${result.systemId}`);
        state.pgBoard = result;
        await shot(id, drive, "playground-after-reload-light-1280");
        return result;
      },
    );
    step(
      id,
      "Project board: /design?project= > Make something new > Design: Save in Matchday web, Matchday copied in, the same drawing and tokens. Reload, then read the repository.",
    );
    await check(
      "project: the same in the project; the files land in .specweave/design",
      async () => {
        const result = await blankDesign(
          `${origin}/design?project=${encodeURIComponent(projectId)}`,
          "Matchday board (project)",
          "Matchday web",
        );
        const designId = result.key.split(".").at(-1);
        const file = repoDesignFile(designId);
        assert(NodeFS.existsSync(file), `no ${file}`);
        const json = JSON.parse(NodeFS.readFileSync(file, "utf8"));
        assert(
          JSON.stringify(json).includes(result.nodes.rect),
          "the repository file lacks the rectangle",
        );
        const systemFile = NodePath.join(
          repo,
          ".specweave/design/systems",
          result.systemId,
          "system.json",
        );
        assert(
          NodeFS.existsSync(systemFile),
          `the copied system is not in the repository: ${systemFile}`,
        );
        state.projectBoard = result;
        await shot(id, drive, "project-after-reload-light-1280");
        return { ...result, file, systemFile };
      },
    );
    if (pg)
      await themedShots(id, "playground-editor", (page) => openDesign(page, state.pgBoard.key));
  }

  // ================================================================ B-01, B-02, B-05 ==========
  if (wanted("B-01") || wanted("B-02") || wanted("B-05") || wanted("B-08") || wanted("B-07")) {
    const id = "B-01";
    const check = checkFor(id);
    step(
      id,
      'A Playground design "Board basics" on Matchday (design.create). Keyboard frame, rectangle, ellipse and text; an uploaded PNG; select and drag; resize from a corner; rename a layer and bring it forward; Cmd+Z and Shift+Cmd+Z; reload.',
    );
    const created = await rpc("design.create", {
      owner: PLAYGROUND,
      kind: "design",
      title: "Board basics",
      designSystem: matchday.systemId,
    });
    state.basicsId = created.ref.designId;
    state.basicsKey = keyOf(PLAYGROUND, state.basicsId);
    const doc = () => getDoc(PLAYGROUND, state.basicsId);
    const node = async (nodeId) => (await doc()).pages[0].nodes.find((n) => n.id === nodeId);
    const firstFrame = created.document.pages[0].nodes.find((n) => n.type === "frame").id;
    await openDesign(drive, state.basicsKey);
    const made = {};
    await check("frames, shapes, text and an image from the tools", async () => {
      const before = new Set((await doc()).pages[0].nodes.map((n) => n.id));
      // Each tool places its shape in the middle of the view; nudge it aside (Shift+Arrow is
      // 10 px) while it is still selected, so no shape covers another.
      const spread = async (key, times) => {
        await focusCanvas(drive);
        for (let n = 0; n < times; n += 1) await drive.keyboard.press(`Shift+${key}`);
        await saved(drive);
      };
      // The frame comes last: shapes drawn after it would land inside it and be clipped there.
      for (const [key, away, times] of [
        ["r", "ArrowLeft", 30],
        ["o", "ArrowRight", 30],
      ]) {
        await focusCanvas(drive);
        await drive.keyboard.press("Escape");
        await drive.keyboard.press(key);
        await drive.keyboard.press("Enter");
        await saved(drive);
        if (times > 0) await spread(away, times);
      }
      await focusCanvas(drive);
      await drive.keyboard.press("Escape");
      await drive.keyboard.press("t");
      await drive.keyboard.press("Enter");
      await drive.locator("[data-testid=design-canvas] textarea").fill("Line-ups at 18:45");
      await drive.keyboard.press("ControlOrMeta+Enter");
      await saved(drive);
      await spread("ArrowDown", 25);
      await focusCanvas(drive);
      await drive.keyboard.press("Escape");
      await drive.keyboard.press("f");
      await drive.keyboard.press("Enter");
      await saved(drive);
      await spread("ArrowUp", 30);
      const png = NodeFS.readFileSync(NodePath.join(fixtures, "ground.png"));
      await drive
        .getByTestId("image-input")
        .setInputFiles({ name: "ground.png", mimeType: "image/png", buffer: png });
      const nodes = await waitFor(
        async () => {
          const list = (await doc()).pages[0].nodes.filter((n) => !before.has(n.id));
          return list.some((n) => n.type === "image") ? list : null;
        },
        10000,
        "the image node",
      );
      await saved(drive);
      for (const n of nodes) made[n.type] ??= n.id;
      for (const type of ["frame", "rect", "ellipse", "text", "image"])
        assert(made[type], `no ${type}`);
      const image = nodes.find((n) => n.type === "image");
      assert(typeof image.asset === "string", "the image has no asset");
      await shot(id, drive, "drawn-light-1280");
      return { created: made, asset: image.asset };
    });
    await check("select and drag, resize from a corner", async () => {
      const before = await node(made.rect);
      await focusCanvas(drive);
      await drive.keyboard.press("Escape");
      await drive.keyboard.press("v");
      const box = await boxOf(drive, made.rect);
      await drive.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await drive.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await drive.mouse.down();
      await drive.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 20, { steps: 6 });
      await drive.mouse.up();
      await saved(drive);
      const moved = await waitFor(
        async () => {
          const value = await node(made.rect);
          return value.x !== before.x || value.y !== before.y ? value : null;
        },
        6000,
        "the drag on the server",
      );
      const handle = await drive.locator('[data-handle="se"]').first().boundingBox();
      assert(handle, "no corner handle on the selection");
      await drive.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
      await drive.mouse.down();
      await drive.mouse.move(handle.x + 40, handle.y + 30, { steps: 6 });
      await drive.mouse.up();
      await saved(drive);
      const resized = await waitFor(
        async () => {
          const value = await node(made.rect);
          return value.width > moved.width && value.height > moved.height ? value : null;
        },
        6000,
        "the resize on the server",
      );
      return {
        from: [before.x, before.y, before.width, before.height],
        moved: [moved.x, moved.y],
        resized: [resized.width, resized.height],
      };
    });
    await check("layers: rename and bring forward", async () => {
      const name = drive.getByLabel("Layer name");
      await name.fill("Kickoff banner");
      await name.press("Enter");
      await saved(drive);
      const order = async () => (await doc()).pages[0].nodes.map((n) => n.id);
      const before = await order();
      await focusCanvas(drive);
      await drive.keyboard.press("}");
      await saved(drive);
      const after = await waitFor(
        async () => {
          const value = await order();
          return value.join() !== before.join() ? value : null;
        },
        6000,
        "the layer order",
      );
      const renamed = (await node(made.rect)).name;
      assert(renamed === "Kickoff banner", `name ${renamed}`);
      return { name: renamed, index: [before.indexOf(made.rect), after.indexOf(made.rect)] };
    });
    await check("undo and redo; the save state reads Saved; reload keeps every edit", async () => {
      await focusCanvas(drive);
      const start = (await node(made.rect)).x;
      await drive.keyboard.press("Shift+ArrowRight");
      await saved(drive);
      await waitFor(async () => (await node(made.rect)).x === start + 10, 6000, "nudge");
      await drive.keyboard.press("ControlOrMeta+z");
      await saved(drive);
      const undone = await waitFor(
        async () => ((await node(made.rect)).x === start ? start : null),
        6000,
        "undo",
      );
      await drive.keyboard.press("ControlOrMeta+Shift+z");
      await saved(drive);
      const redone = await waitFor(
        async () => {
          const x = (await node(made.rect)).x;
          return x === start + 10 ? x : null;
        },
        6000,
        "redo",
      );
      const state_ = norm(await drive.getByTestId("save-state").textContent());
      const before = await doc();
      await drive.reload();
      await editorReady(drive);
      const after = await doc();
      assert(
        after.revision === before.revision &&
          JSON.stringify(after.pages) === JSON.stringify(before.pages),
        "the reload changed the design",
      );
      for (const nodeId of Object.values(made))
        assert(
          await drive.locator(`[data-node="${nodeId}"]`).count(),
          `${nodeId} is not drawn after the reload`,
        );
      return { start, undone, redone, saveState: state_, revision: after.revision };
    });
    if (children["verify-canvas"]) {
      step(
        id,
        "Also counted: verify-canvas.mjs draws, moves and nudges on its Marina board and reloads it.",
      );
      adopt(
        id,
        "verify-canvas",
        /^(opens the design|draw a rectangle|draw text|move the headline|autosave survives)/,
        /^0[12]-/,
      );
    }
    await themedShots(id, "editor", (page) => openDesign(page, state.basicsKey));

    // ---- B-02 pages
    if (wanted("B-02") || wanted("B-05")) {
      const id2 = "B-02";
      const check2 = checkFor(id2);
      step(
        id2,
        'On "Board basics": Page menu > Add page, rename it "Checkout", two frames on it; Add page (Page 3) and Move up; Add page (Page 4) and Delete page; reload.',
      );
      await check2(
        "add, rename, reorder and delete pages; several frames on one page; reload keeps them",
        async () => {
          const pageMenu = async (item) => {
            await drive.getByTestId("page-menu").click();
            if (typeof item === "string")
              await drive.getByRole("menuitem", { name: item, exact: true }).click();
            else await drive.getByTestId(item.testId).click();
            await saved(drive);
          };
          await pageMenu("Add page");
          await pageMenu("Rename page");
          await drive.getByLabel("Page name").fill("Checkout");
          await drive.getByRole("button", { name: "Rename", exact: true }).click();
          await saved(drive);
          for (let i = 0; i < 2; i += 1) {
            await focusCanvas(drive);
            await drive.keyboard.press("Escape");
            await drive.keyboard.press("f");
            await drive.keyboard.press("Enter");
            await saved(drive);
            if (i === 0) {
              await focusCanvas(drive);
              for (let n = 0; n < 6; n += 1) await drive.keyboard.press("Shift+ArrowDown");
              await saved(drive);
            }
          }
          await pageMenu("Add page");
          await pageMenu({ testId: "page-move-up" });
          await pageMenu("Add page");
          await pageMenu("Delete page");
          const names = async () => (await doc()).pages.map((p) => p.name);
          const expected = ["Page 1", "Page 3", "Checkout"];
          await waitFor(
            async () => (await names()).join() === expected.join(),
            6000,
            `pages ${expected}`,
          );
          const checkout = (await doc()).pages.find((p) => p.name === "Checkout");
          const frames = checkout.nodes.filter(
            (n) => n.type === "frame" && n.parentId === null,
          ).length;
          assert(frames >= 2, `Checkout has ${frames} frames`);
          await drive.reload();
          await editorReady(drive);
          const after = await names();
          assert(after.join() === expected.join(), `after reload ${after}`);
          await drive.getByTestId("page-menu").click();
          await drive.waitForTimeout(200);
          await shot(id2, drive, "page-menu-light-1280");
          await drive.keyboard.press("Escape");
          return { pages: after, checkoutFrames: frames };
        },
      );
      await themedShots(id2, "page-menu", async (page) => {
        await openDesign(page, state.basicsKey);
        await page.getByTestId("page-menu").click();
      });
    }

    // ---- B-05 export
    if (wanted("B-05")) {
      const id5 = "B-05";
      const check5 = checkFor(id5);
      step(
        id5,
        'On "Board basics" (page 1 with the drawn frames, "Checkout" with two): Export > PNG, SVG and Standalone HTML of the first frame; PDF of all frames.',
      );
      step(
        id5,
        "Open each file: PNG decoded by sips; SVG through xmllint --noout and as an image in Chromium; HTML in Chromium; PDF through pdfinfo, one page per top-level frame.",
      );
      await check5(
        "PNG, SVG and HTML of a frame and a PDF of all frames; the files open",
        async () => {
          await openDesign(drive, state.basicsKey);
          const document = await doc();
          const frame = document.pages[0].nodes.find((n) => n.id === firstFrame);
          await drive
            .locator(`[data-node="${frame.id}"]`)
            .first()
            .click({ position: { x: 4, y: 4 } });
          const files = {};
          for (const [item, ext] of [
            [/^PNG of /, "png"],
            ["SVG", "svg"],
            ["Standalone HTML", "html"],
            ["PDF of all frames", "pdf"],
          ]) {
            const result = await exportFromMenu(
              drive,
              item,
              NodePath.join(exportsDir, `B-05-board-basics.${ext}`),
              120000,
            );
            files[ext] = result;
            row(id5).exports.push(result.file);
          }
          const sips = NodeChildProcess.execFileSync(
            "/usr/bin/sips",
            ["-g", "pixelWidth", "-g", "pixelHeight", files.png.file],
            { encoding: "utf8" },
          );
          const png = {
            width: Number(sips.match(/pixelWidth: (\d+)/)?.[1]),
            height: Number(sips.match(/pixelHeight: (\d+)/)?.[1]),
          };
          const xmllint = NodeChildProcess.spawnSync(
            "/usr/bin/xmllint",
            ["--noout", files.svg.file],
            { encoding: "utf8" },
          );
          const viewer = await newPage("light", "B-05-viewer");
          await viewer.setContent(
            `<img id="svg" src="data:image/svg+xml;base64,${NodeFS.readFileSync(files.svg.file).toString("base64")}">`,
          );
          const svg = await viewer.locator("#svg").evaluate(async (img) => {
            await img.decode().catch(() => undefined);
            return { width: img.naturalWidth, height: img.naturalHeight };
          });
          await viewer.goto(NodeURL.pathToFileURL(files.html.file).href);
          const html = {
            title: await viewer.title(),
            nodes: await viewer.locator("[data-node]").count(),
          };
          await viewer.screenshot({ path: shotPath(id5, "html-export-opened") });
          row(id5).screenshots.push(shotPath(id5, "html-export-opened"));
          await viewer.close();
          const pages = pdfPages(files.pdf.file);
          const sheets = expectedSheets(await doc());
          measure(id5, {
            png,
            svg: {
              ...svg,
              xmllint: xmllint.status,
              foreignObject: NodeFS.readFileSync(files.svg.file, "utf8").includes("<foreignObject"),
            },
            html,
            pdf: { pages, expected: sheets },
            bytes: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, v.bytes])),
          });
          assert(png.width > 0 && png.height > 0, "the PNG does not decode");
          assert(xmllint.status === 0, `xmllint: ${xmllint.stderr}`);
          assert(svg.width > 0, "the SVG does not load as an image");
          assert(html.nodes > 0, "the HTML shows no layers");
          assert(pages === sheets, `the PDF has ${pages} pages for ${sheets} frames`);
          return { png, svg, html, pdf: { pages, frames: sheets } };
        },
      );
      if (children["verify-canvas"]) {
        step(
          id5,
          "Also counted: verify-canvas.mjs exports PNG, SVG, HTML and PDF of its Marina board from the Export menu.",
        );
        adopt(id5, "verify-canvas", /^export PNG, SVG, HTML and PDF/);
        const dir = NodePath.join(children["verify-canvas"].dir, "downloads");
        const svg = NodePath.join(dir, "booking.svg");
        if (NodeFS.existsSync(svg)) {
          const lint = NodeChildProcess.spawnSync("/usr/bin/xmllint", ["--noout", svg], {
            encoding: "utf8",
          });
          row(id5).checks.push({
            name: "verify-canvas booking.svg passes xmllint",
            ok: lint.status === 0,
            ...(lint.status === 0 ? {} : { error: lint.stderr }),
          });
          const pdf = NodePath.join(dir, "booking.pdf");
          const pages = pdfPages(pdf);
          row(id5).checks.push({
            name: "verify-canvas booking.pdf has one page for its one frame",
            ok: pages === 1,
            ...(pages === 1 ? {} : { error: `${pages} pages` }),
          });
        }
      }
      await themedShots(id5, "export-menu", async (page) => {
        await openDesign(page, state.basicsKey);
        await page.getByRole("button", { name: "Export", exact: true }).click();
      });
    }
  }

  // ================================================================ B-03 ========================
  if (wanted("B-03")) {
    const id = "B-03";
    const check = checkFor(id);
    step(
      id,
      'A Playground design "System binding" on Matchday (design.create) with a rectangle filled mx-primary.',
    );
    step(
      id,
      "Insert component (toolbar) > Join button; read the frame's srcdoc and the button's computed colors; switch the header picker to Matchday Night; read them again.",
    );
    const created = await rpc("design.create", {
      owner: PLAYGROUND,
      kind: "design",
      title: "System binding",
      designSystem: matchday.systemId,
    });
    const designId = created.ref.designId;
    const page0 = created.document.pages[0];
    const frameId = page0.nodes.find((n) => n.type === "frame").id;
    await rpc("design.apply", {
      owner: PLAYGROUND,
      designId,
      expectedRevision: created.document.revision,
      operations: [
        {
          op: "add_node",
          pageId: page0.id,
          node: {
            id: "n_brand",
            parentId: frameId,
            type: "rect",
            name: "Brand bar",
            x: 40,
            y: 40,
            width: 400,
            height: 80,
            fill: { token: "mx-primary" },
          },
        },
      ],
    });
    state.bindingKey = keyOf(PLAYGROUND, designId);
    await check("insert a component; it renders with the system's token CSS", async () => {
      await openDesign(drive, state.bindingKey);
      await drive
        .locator(`[data-node="${frameId}"]`)
        .first()
        .click({ position: { x: 4, y: 4 } });
      await drive.getByTestId("insert-component").click();
      await drive.getByTestId("component-picker").waitFor();
      await shot(id, drive, "component-picker-light-1280");
      await drive.locator('[data-testid=component-option][data-component="join-button"]').click();
      await saved(drive);
      const component = await waitFor(
        async () =>
          (await getDoc(PLAYGROUND, designId)).pages[0].nodes.find((n) => n.type === "component") ??
          null,
        6000,
        "the component node",
      );
      state.componentId = component.id;
      const frame = drive.locator(`[data-node="${component.id}"] iframe`).first();
      await frame.waitFor();
      const srcdoc = (await frame.getAttribute("srcdoc")) ?? "";
      const sandbox = await frame.getAttribute("sandbox");
      const button = drive
        .frameLocator(`[data-node="${component.id}"] iframe`)
        .locator("button.mx-join");
      await button.waitFor({ timeout: 10000 });
      const colors = await button.evaluate((el) => ({
        background: getComputedStyle(el).backgroundColor,
        color: getComputedStyle(el).color,
      }));
      await shot(id, drive, "component-inserted-light-1280");
      measure(id, {
        inserted: {
          node: component.id,
          componentId: component.componentId,
          srcdocHasTokens: srcdoc.includes("--mx-primary:#0a6b3d"),
          sandbox,
          colors,
        },
      });
      assert(component.componentId === "join-button", `component ${component.componentId}`);
      assert(srcdoc.includes("--mx-primary:#0a6b3d"), "the srcdoc lacks the token CSS");
      assert(sandbox !== null && !sandbox.includes("allow-same-origin"), `sandbox ${sandbox}`);
      assert(
        colors.background === rgb("#0a6b3d") && colors.color === rgb("#ffffff"),
        `button ${JSON.stringify(colors)}`,
      );
      return { component: component.id, colors };
    });
    await check(
      "switching the system re-resolves the tokens on the canvas and in the component",
      async () => {
        const picker = drive.getByTestId("design-system-picker").getByRole("combobox");
        await picker.click();
        await pickOption(drive, /^Matchday Night/);
        await saved(drive);
        await waitFor(
          async () => (await getDoc(PLAYGROUND, designId)).designSystem === night.systemId,
          6000,
          "the switch on the server",
        );
        const bar = await waitFor(
          async () => {
            const value = await drive
              .locator('[data-node="n_brand"]')
              .first()
              .evaluate((el) => getComputedStyle(el).backgroundColor);
            return value === rgb("#7c3aed") ? value : null;
          },
          6000,
          "the bar in Matchday Night's primary",
        );
        const button = drive
          .frameLocator(`[data-node="${state.componentId}"] iframe`)
          .locator("button.mx-join");
        const component = await waitFor(
          async () => {
            const value = await button
              .evaluate((el) => getComputedStyle(el).backgroundColor)
              .catch(() => null);
            return value === rgb("#7c3aed") ? value : null;
          },
          8000,
          "the component in Matchday Night's primary",
        );
        await shot(id, drive, "switched-light-1280");
        return { system: "Matchday Night", bar, component };
      },
    );
    step(
      id,
      "A Matchday web design that reuses the repository's src/styles/tokens.css (design.create with a reuse record, no system): open the reuse chip.",
    );
    await check("the reuse chip shows what the design reuses", async () => {
      const reuse = await rpc("design.create", {
        owner: projectOwner,
        kind: "design",
        title: "Reuse probe",
        reuse: {
          name: "matchday-web",
          paths: ["src/styles/tokens.css"],
          tokens: 3,
          components: 0,
          modes: ["default"],
          foundAt: new Date().toISOString(),
        },
      });
      state.reuseKey = keyOf(projectOwner, reuse.ref.designId);
      await openDesign(drive, state.reuseKey);
      const chip = drive.getByTestId("design-reuse-chip");
      await chip.waitFor();
      await chip.click();
      const details = drive.getByTestId("design-reuse-details");
      await details.waitFor();
      const text = norm(await details.textContent());
      await shot(id, drive, "reuse-chip-light-1280");
      await drive.keyboard.press("Escape");
      assert(
        text.includes("matchday-web") && text.includes("src/styles/tokens.css"),
        `details: ${text}`,
      );
      return { chip: await chip.getAttribute("aria-label"), details: text.slice(0, 300) };
    });
    await themedShots(id, "component-switched", (page) => openDesign(page, state.bindingKey));
  }

  // ================================================================ B-04 ========================
  if (wanted("B-04")) {
    const id = "B-04";
    const check = checkFor(id);
    if (children["verify-canvas"]) {
      step(
        id,
        "Comments: verify-canvas.mjs places a comment, replies to it and resolves the thread on its Marina board (adopted below).",
      );
      adopt(id, "verify-canvas", /^(place a comment|reply to the comment)/, /^04/);
    }
    step(
      id,
      'Versions, on "System binding": Version history > Save version "Before the nudge"; nudge the bar; Restore that version and confirm; reload.',
    );
    await check("save a named version; restore brings the content back", async () => {
      assert(state.bindingKey, "B-03 made no design");
      const owner = PLAYGROUND;
      const designId = state.bindingKey.split(".").at(-1);
      const bar = async () =>
        (await getDoc(owner, designId)).pages[0].nodes.find((n) => n.id === "n_brand");
      await openDesign(drive, state.bindingKey);
      const x0 = (await bar()).x;
      await drive.getByRole("button", { name: "Version history" }).click();
      const panel = drive.getByTestId("design-version-history");
      await panel.waitFor();
      await panel.getByRole("button", { name: "Save version" }).click();
      await panel.getByLabel("Version name").fill("Before the nudge");
      await panel.getByRole("button", { name: "Save version" }).click();
      const versionRow = panel
        .locator('[data-testid=design-version-row][data-kind="version"]')
        .filter({ hasText: "Before the nudge" });
      await versionRow.waitFor({ timeout: 10000 });
      await drive.locator('[data-node="n_brand"]').first().click();
      await focusCanvas(drive);
      await drive.keyboard.press("Shift+ArrowRight");
      await saved(drive);
      await waitFor(async () => (await bar()).x === x0 + 10, 6000, "the nudge");
      await shot(id, drive, "version-history-light-1280");
      await versionRow.getByRole("button", { name: "Restore" }).click();
      await drive.getByTestId("design-restore-dialog").waitFor();
      await shot(id, drive, "restore-confirm-light-1280");
      await drive.getByTestId("design-restore-confirm").click();
      await waitFor(async () => (await bar()).x === x0, 10000, "the restored position");
      await drive.reload();
      await editorReady(drive);
      const after = (await bar()).x;
      const history = (await rpc("design.history", { owner, designId })).entries;
      const versions = history
        .filter((entry) => entry.kind === "version")
        .map((entry) => entry.name);
      assert(after === x0, `after reload x ${after}`);
      assert(versions.includes("Before the nudge"), `versions ${versions}`);
      return { x: [x0, x0 + 10, after], versions, entries: history.length };
    });
    await themedShots(id, "version-history", async (page) => {
      await openDesign(page, state.bindingKey);
      await page.getByRole("button", { name: "Version history" }).click();
      await page.getByTestId("design-version-history").waitFor();
    });
  }

  // ================================================================ B-06 and C-02 ===============
  if (children["verify-canvas"]) {
    if (wanted("B-06")) {
      step(
        "B-06",
        "verify-canvas.mjs --no-agent: Implement this frame > New coding thread > Create thread; open the thread from the toast; reload it.",
      );
      const [found] = adopt(
        "B-06",
        "verify-canvas",
        /^implement this frame without a provider/,
        /^08/,
      );
      if (found?.detail) measure("B-06", found.detail);
      adopt("B-06", "verify-canvas", /^the server's export browser renders/);
    }
    if (wanted("C-02")) {
      step(
        "C-02",
        "verify-canvas.mjs --no-agent: Make something new > Design from code > Marina, a brief, Create design; then the same from the project board (/design?project=). Reload each.",
      );
      for (const found of adopt("C-02", "verify-canvas", /^design from code from/, /^09-/))
        if (found.detail)
          measure("C-02", { [found.name.includes("board") ? "board" : "gallery"]: found.detail });
    }
  } else
    for (const id of ["B-06", "C-02"])
      if (wanted(id)) row(id).notes.push("verify-canvas.mjs did not run (--skip-children).");
  if (wanted("C-02") && row("C-02").measured.gallery?.designKey) {
    const designKey = row("C-02").measured.gallery.designKey;
    const seen = {};
    await themedShots("C-02", "design-with-held-thread", async (page, { theme, width }) => {
      await openDesign(page, designKey);
      // At 1600 px the thread is a column (the child checked it there); at 1280 px it opens
      // over the canvas from "Show thread" in the header.
      const notice = page.getByTestId("bound-thread-notice");
      const shown = async () =>
        notice.waitFor({ timeout: 8000 }).then(
          () => true,
          () => false,
        );
      let how = (await shown()) ? "open" : null;
      if (how === null) {
        await page.getByRole("button", { name: "Show thread" }).click();
        how = (await shown()) ? "after Show thread" : "not shown";
      }
      seen[`${theme}-${width}`] = how;
    });
    measure("C-02", { noticeAt1280: seen });
    const missing = Object.entries(seen).filter(([, how]) => how === "not shown");
    row("C-02").checks.push({
      name: "at 1280 px the held thread's notice opens from Show thread",
      ok: Object.keys(seen).length > 0 && missing.length === 0,
      ...(missing.length === 0
        ? { detail: seen }
        : { error: `not shown: ${missing.map(([key]) => key).join(", ")}` }),
    });
  }
  if (wanted("B-06") && row("B-06").measured.thread) {
    const url = row("B-06").measured.thread.replace(/^http:\/\/127\.0\.0\.1:\d+/, origin);
    await themedShots("B-06", "held-thread", async (page) => {
      await page.goto(url);
      await waitFor(
        async () => (await composerText(page)).includes("Booking"),
        20000,
        "the handoff in the composer",
      );
    });
  }

  // ================================================================ B-07 ========================
  if (wanted("B-07")) {
    const id = "B-07";
    const check = checkFor(id);
    step(
      id,
      "Home > Matchday web in the sidebar > the project's Designs button > Open in Designs: the board (/design?project=).",
    );
    await check("the project's Designs leads to its board", async () => {
      await drive.goto(`${origin}/`);
      await drive.getByText("Matchday web", { exact: true }).first().click();
      await drive.getByTestId("project-designs-button").click();
      await drive.getByTestId("project-designs").waitFor();
      await shot(id, drive, "project-designs-pane-light-1280");
      await drive.getByRole("link", { name: /Open in Designs/ }).click();
      await drive.waitForURL(/\/design\?/, { timeout: 15000 });
      await drive.getByTestId("design-gallery").waitFor();
      const scope = norm(
        await drive
          .getByTestId("design-scope")
          .textContent()
          .catch(() => ""),
      );
      const url = drive.url();
      assert(
        url.includes(encodeURIComponent(projectId)) || url.includes(projectId),
        `board ${url}`,
      );
      return { url, scope };
    });
    step(
      id,
      "Scoped creates: C-01 (design) and SL-04 (slides) made from this board saved into Matchday web.",
    );
    row(id).checks.push({
      name: "scoped creates (C-01 project design, SL-04 project deck)",
      ok: Boolean(state.projectBoard) && row("SL-04").checks.some((c) => c.ok),
      ...(state.projectBoard
        ? { detail: { design: state.projectBoard.key } }
        : { error: "C-01's project create did not pass" }),
    });
    step(
      id,
      'A Playground design "Connect me" with a named version (design.saveVersion); board > Add from Playground… > Connect me > Move; then its old Playground link.',
    );
    await check(
      "Add from Playground moves a design with its id, history and versions",
      async () => {
        const created = await rpc("design.create", {
          owner: PLAYGROUND,
          kind: "design",
          title: "Connect me",
          designSystem: matchday.systemId,
        });
        const designId = created.ref.designId;
        const page0 = created.document.pages[0];
        await rpc("design.apply", {
          owner: PLAYGROUND,
          designId,
          expectedRevision: created.document.revision,
          operations: [
            {
              op: "add_node",
              pageId: page0.id,
              node: {
                id: "n_move",
                parentId: page0.nodes[0].id,
                type: "rect",
                name: "Moved rect",
                x: 20,
                y: 20,
                width: 200,
                height: 120,
                fill: { token: "mx-primary" },
              },
            },
          ],
        });
        await rpc("design.saveVersion", { owner: PLAYGROUND, designId, name: "Before the move" });
        const historyBefore = (await rpc("design.history", { owner: PLAYGROUND, designId }))
          .entries;
        const copiesBefore = await projectCopies();
        await drive.goto(`${origin}/design?project=${encodeURIComponent(projectId)}`);
        await drive.getByTestId("design-gallery").waitFor({ timeout: 30000 });
        await drive.getByTestId("design-add-from-playground").click();
        await drive
          .getByTestId("design-add-from-playground-item")
          .filter({ hasText: "Connect me" })
          .first()
          .click();
        const dialog = drive.getByTestId("connect-design-dialog");
        await dialog.waitFor();
        const target = norm(await dialog.getByTestId("connect-design-project").textContent());
        await shot(id, drive, "add-from-playground-connect-light-1280");
        if (target !== "Matchday web") {
          await dialog.getByTestId("connect-design-project").click();
          await pickOption(drive, /^Matchday web$/);
        }
        await dialog.getByTestId("connect-design-move").click();
        await waitFor(
          async () =>
            (await designsOf()).some(
              (d) => d.ref.designId === designId && d.ref.owner.kind === "project",
            ),
          30000,
          "the move",
        );
        const historyAfter = (await rpc("design.history", { owner: projectOwner, designId }))
          .entries;
        const versions = historyAfter.filter((e) => e.kind === "version").map((e) => e.name);
        const doc = await getDoc(projectOwner, designId);
        await drive.goto(`${origin}/design/${keyOf(PLAYGROUND, designId)}`);
        await drive.waitForURL(new RegExp(`/design/p\\.${projectId}\\.${designId}`), {
          timeout: 20000,
        });
        await editorReady(drive);
        await shot(id, drive, "moved-design-light-1280");
        const copiesAfter = await projectCopies();
        measure(id, {
          move: {
            designId,
            target,
            history: [historyBefore.length, historyAfter.length],
            versions,
            file: repoDesignFile(designId),
            projectCopiesOfMatchday: [copiesBefore, copiesAfter],
          },
        });
        if (copiesAfter > copiesBefore && copiesBefore > 0)
          row(id).notes.push(
            `Observation: the move copied Matchday into Matchday web under its Playground id although the project already held a copy under another id: ${copiesBefore} -> ${copiesAfter} systems named Matchday there (1046 AC-02 copies by id).`,
          );
        assert(
          doc.pages[0].nodes.some((n) => n.id === "n_move"),
          "the content did not move",
        );
        assert(
          historyAfter.length >= historyBefore.length,
          `history ${historyBefore.length} -> ${historyAfter.length}`,
        );
        assert(versions.includes("Before the move"), `versions ${versions}`);
        assert(NodeFS.existsSync(repoDesignFile(designId)), "not in the repository");
        return {
          designId,
          target,
          history: [historyBefore.length, historyAfter.length],
          versions,
          redirect: drive.url(),
        };
      },
    );
    step(id, "Connect to a project… from a Playground card menu: SL-04's deck copy.");
    row(id).checks.push({
      name: "Connect to a project… from the card menu (SL-04)",
      ok: row("SL-04").checks.some((c) => /connects to the project/.test(c.name) && c.ok),
      ...(row("SL-04").measured.connect
        ? { detail: row("SL-04").measured.connect }
        : { error: "SL-04's connect did not pass" }),
    });
    await themedShots(id, "board", async (page) => {
      await page.goto(`${origin}/design?project=${encodeURIComponent(projectId)}`);
      await page.getByTestId("design-gallery").waitFor({ timeout: 30000 });
    });
  }

  // ================================================================ B-08 ========================
  if (wanted("B-08")) {
    const id = "B-08";
    const check = checkFor(id);
    async function shareFacts(page, key) {
      await openDesign(page, key);
      await page.getByRole("button", { name: "Share" }).click();
      const dialog = page.getByTestId("share-dialog");
      await dialog.waitFor();
      const text = norm(await dialog.textContent());
      const owner = norm(await dialog.getByTestId("share-owner").textContent());
      const reach = norm(
        await dialog
          .getByTestId("share-link-reach")
          .textContent()
          .catch(() => ""),
      );
      const exports = (await dialog.getByTestId("share-export").allTextContents()).map(norm);
      await dialog.getByTestId("share-copy-link").hover();
      await page.waitForTimeout(700);
      const link = norm(
        await page
          .getByText(new RegExp(`/design/${key.replace(/\./g, "\\.")}`))
          .first()
          .textContent()
          .catch(() => ""),
      );
      return { dialog, text, owner, reach, exports, link };
    }
    const cases = [
      ["Playground design", state.basicsKey, "Playground"],
      ["project design", state.projectBoard?.key ?? state.reuseKey, "Matchday web"],
    ];
    for (const [label, key, owner] of cases) {
      step(
        id,
        `Share on the ${label}: owner, who can open it, Copy link with its reach, the Export row, the public-link note.`,
      );
      await check(
        `Share dialog on the ${label} states what is local and offers the local equivalent`,
        async () => {
          assert(key, `no ${label}`);
          const facts = await shareFacts(drive, key);
          await shot(id, drive, `${label.split(" ")[0].toLowerCase()}-share-light-1280`);
          await drive.keyboard.press("Escape");
          const result = {
            owner: facts.owner,
            reach: facts.reach,
            exports: facts.exports,
            link: facts.link,
            publicNote: facts.text.includes("Public web links aren't available"),
          };
          measure(id, { [label]: result });
          assert(facts.owner.includes(owner), `owner ${facts.owner}`);
          assert(
            facts.text.includes("Who can open this") && /You on /.test(facts.text),
            "who can open it is not stated",
          );
          assert(facts.reach !== "", "Copy link does not say where the link works");
          assert(facts.exports.length >= 3, `exports ${facts.exports}`);
          assert(result.publicNote, "the public-link note is missing");
          assert(facts.link.includes(`/design/${key}`), `link ${facts.link}`);
          return result;
        },
      );
      if (key)
        await themedShots(id, `${label.split(" ")[0].toLowerCase()}-share`, async (page) => {
          await openDesign(page, key);
          await page.getByRole("button", { name: "Share" }).click();
          await page.getByTestId("share-dialog").waitFor();
        });
    }
  }

  // ================================================================ C-03 ========================
  if (wanted("C-03")) {
    const id = "C-03";
    const check = checkFor(id);
    const systemsMd =
      "/Users/you/.specwithcode/m4/evidence/design-system-claude-compare-1046/ours/systems.md";
    step(
      id,
      "Reference: 1046 rows S1 to S8 in design-system-claude-compare-1046/ours/systems.md (1046 owns design systems).",
    );
    step(
      id,
      "Smoke on this build: Settings > Design systems > New design system; list the ways to make one; Start from scratch shows the name field.",
    );
    await check("New design system offers every way to make one", async () => {
      await drive.goto(`${origin}/settings/design-systems`);
      const settings = drive.getByTestId("design-systems-settings");
      await settings.waitFor({ timeout: 30000 });
      await settings.getByText("Matchday Night").first().waitFor({ timeout: 15000 });
      const list = norm(await settings.textContent());
      await drive.getByTestId("new-design-system").first().click();
      const dialog = drive.getByTestId("new-design-system-dialog");
      await drive.getByRole("menuitem").first().waitFor({ timeout: 10000 });
      const menuItems = (await drive.getByRole("menuitem").allTextContents())
        .map(norm)
        .filter(Boolean);
      await shot(id, drive, "new-menu-light-1280");
      await drive.getByRole("menuitem", { name: "Start from scratch" }).click();
      await dialog.waitFor({ timeout: 10000 });
      const text = norm(await dialog.textContent());
      await shot(id, drive, "new-design-system-dialog-light-1280");
      await drive.keyboard.press("Escape");
      const listed = ["Matchday", "Matchday Night"].filter((name) => list.includes(name));
      measure(id, { settingsList: listed, newMenu: menuItems, dialog: text.slice(0, 600) });
      assert(listed.length === 2, `Settings lists ${listed}`);
      for (const way of [
        "Start from scratch",
        "From this project's code",
        "From a tokens file",
        "Describe it",
      ])
        assert(menuItems.includes(way), `New design system lacks "${way}": ${menuItems}`);
      return { listed, newMenu: menuItems, dialog: text.slice(0, 200) };
    });
    const reference = NodeFS.existsSync(systemsMd) ? NodeFS.readFileSync(systemsMd, "utf8") : "";
    const sRows = [...reference.matchAll(/^\| (S\d) ([^|]+)\|[^|]*\|[^|]*\| ([^|]+)\|/gm)].map(
      (m) => ({ row: m[1], what: norm(m[2]), result: norm(m[3]) }),
    );
    measure(id, {
      reference: {
        file: systemsMd,
        run: "1046 comparison, build 6e4196666d, October 24, 2026",
        rows: sRows,
      },
    });
    row(id).notes.push(
      `1046 reference: ${sRows.map((r) => `${r.row} ${r.result.split(/[,:]/)[0]}`).join("; ")}. Design systems are 1046's scope; its failures (S4 D1, S8 D2/D3) are not re-judged here.`,
    );
    await themedShots(id, "settings-design-systems", async (page) => {
      await page.goto(`${origin}/settings/design-systems`);
      await page.getByTestId("design-systems-settings").waitFor({ timeout: 30000 });
    });
  }
} catch (error) {
  summary.fatal = String(error?.stack ?? error).slice(0, 4000);
  console.log(`FATAL ${error?.stack ?? error}`);
} finally {
  for (const value of Object.values(contexts)) await value.close().catch(() => undefined);
  await browser.close().catch(() => undefined);
  // Turns: no page sent message.dispatch, and no thread the server lists has run anything.
  try {
    const threads = await shellThreads();
    const activity = [];
    for (const thread of threads)
      activity.push({
        id: thread.id ?? thread.threadId,
        title: thread.title,
        ...(await threadActivity(server, thread.id ?? thread.threadId)),
      });
    summary.threads = activity;
  } catch (error) {
    summary.threads = `unread: ${error?.message ?? error}`;
  }
  summary.commands = {
    threadCreate: allCommands.reduce((sum, seen) => sum + seen.threadCreate.length, 0),
    messageDispatch: allCommands.reduce((sum, seen) => sum + seen.messageDispatch.length, 0),
    childMessageDispatch: Object.fromEntries(
      Object.entries(children).map(([name, child]) => [
        name,
        child.report?.commands?.messageDispatch ?? null,
      ]),
    ),
  };
  summary.stopped = await server.stop();
  summary.stopped.pidGone = !pidAlive(server.pid);
  summary.stopped.portFree = await portIsFree(server.port);
  summary.finishedAt = new Date().toISOString();
  summary.consoleErrors = errors;
  summary.children = Object.fromEntries(
    Object.entries(children).map(([name, child]) => [
      name,
      {
        script: child.script,
        exit: child.exit,
        summary: child.summary,
        dir: child.dir,
        ms: child.ms,
      },
    ]),
  );
  if (!keepHome) {
    // The private home holds only this run's fixtures; evidence is already in the report dir.
    NodeFS.rmSync(privateRoot, { recursive: true, force: true });
    summary.privateHomeRemoved = true;
  }
  writeMatrix();
}

/** "October 24, 2026 at 3:36 PM PDT": this machine's time zone. */
function when(iso) {
  const date = new Date(iso);
  const zone = new Intl.DateTimeFormat("en-US", { timeZoneName: "short" })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value;
  return `${date.toLocaleString("en-US", { dateStyle: "long", timeStyle: "short" })}${zone ? ` ${zone}` : ""}`;
}

function writeMatrix() {
  const turnsRan =
    Array.isArray(summary.threads) &&
    summary.threads.some((t) => (t.messages ?? 0) + (t.runs ?? 0) + (t.providerTurns ?? 0) > 0);
  for (const value of rows.values()) {
    if (!wanted(value.id)) value.verdict = "skip";
    else if (value.checks.length === 0) value.verdict = "skip";
    else value.verdict = value.checks.every((c) => c.ok) ? "pass" : "fail";
    if (value.verdict === "skip" && value.notes.length === 0)
      value.notes.push(wanted(value.id) ? "No check ran." : "Not selected with --rows.");
  }
  const list = [...rows.values()];
  const counts = {
    pass: list.filter((r) => r.verdict === "pass").length,
    fail: list.filter((r) => r.verdict === "fail").length,
    skip: list.filter((r) => r.verdict === "skip").length,
  };
  const matrix = {
    ...summary,
    counts,
    noProviderTurn: !turnsRan && summary.commands.messageDispatch === 0,
    rows: list,
  };
  NodeFS.writeFileSync(NodePath.join(out, "matrix.json"), JSON.stringify(matrix, null, 2) + "\n");
  const rel = (file) => (file.startsWith(out) ? NodePath.relative(out, file) : file);
  const cell = (text) => String(text).replace(/\|/g, "\\|").replace(/\n/g, " ");
  const lines = [
    "# 1051 scenario matrix",
    "",
    `Run ${when(summary.startedAt)} to ${when(summary.finishedAt)} by \`scripts/studio-verify/design-boards-slides.mjs\` on \`${sha}\`${summary.dirty ? " (worktree had local changes, listed in matrix.json)" : ""}, ${summary.node}. One private server (\`${summary.server.origin}\`, PID ${summary.server.pid}) with home \`${summary.privateHome}\`, every provider off, export browser sandbox off. Headless Chromium (\`headless: true\`, \`PWDEBUG=0\`, \`PLAYWRIGHT_HTML_OPEN=never\`, \`${summary.browser.executable}\`). Server stopped by PID: PID gone ${summary.stopped?.pidGone}, port free ${summary.stopped?.portFree}.`,
    "",
    `**Totals:** ${counts.pass} pass, ${counts.fail} fail, ${counts.skip} skip. No provider turn: ${matrix.noProviderTurn} (message.dispatch from pages ${summary.commands.messageDispatch}, threads with activity ${Array.isArray(summary.threads) ? summary.threads.filter((t) => (t.messages ?? 0) + (t.runs ?? 0) + (t.providerTurns ?? 0) > 0).length : "unread"} of ${Array.isArray(summary.threads) ? summary.threads.length : "?"}).`,
    "",
    "Children against the same server:",
    ...Object.entries(summary.children).map(
      ([name, child]) =>
        `- \`${child.script}\`: exit ${child.exit}, ${child.summary}; report \`${rel(NodePath.join(child.dir, "report.json"))}\``,
    ),
    "",
    "| Row | Flow | Verdict | Claude reference | Pass when | Checks |",
    "| --- | --- | --- | --- | --- | --- |",
    ...list.map(
      (r) =>
        `| ${r.id} | ${cell(r.flow)} | ${r.verdict} | ${cell(r.claudeReference)} | ${cell(r.passWhen)} | ${r.checks.filter((c) => c.ok).length}/${r.checks.length} |`,
    ),
    "",
  ];
  for (const r of list) {
    lines.push(`## ${r.id} ${r.flow}: ${r.verdict}`, "");
    if (r.steps.length) lines.push("Steps:", ...r.steps.map((s, i) => `${i + 1}. ${s}`), "");
    if (r.checks.length)
      lines.push(
        "Checks:",
        ...r.checks.map(
          (c) =>
            `- ${c.ok ? "pass" : "FAIL"}: ${c.name}${c.ok ? "" : ` — ${cell(c.error ?? "").slice(0, 600)}`}`,
        ),
        "",
      );
    const measured = JSON.stringify(r.measured);
    if (measured !== "{}")
      lines.push(
        "Measured:",
        "",
        "```json",
        JSON.stringify(r.measured, null, 2).slice(0, 6000),
        "```",
        "",
      );
    if (r.notes.length) lines.push("Notes:", ...r.notes.map((n) => `- ${n}`), "");
    if (r.exports.length) lines.push("Exports:", ...r.exports.map((f) => `- \`${rel(f)}\``), "");
    if (r.screenshots.length)
      lines.push("Screenshots:", ...r.screenshots.map((f) => `- \`${rel(f)}\``), "");
  }
  if (summary.consoleErrors.length)
    lines.push(
      "## Console errors",
      "",
      ...summary.consoleErrors.slice(0, 40).map((e) => `- ${cell(e).slice(0, 300)}`),
      "",
    );
  if (summary.fatal) lines.push("## Fatal", "", "```", summary.fatal, "```", "");
  NodeFS.writeFileSync(NodePath.join(out, "matrix.md"), lines.join("\n"));
  console.log(
    `matrix: ${counts.pass} pass, ${counts.fail} fail, ${counts.skip} skip; ${NodePath.join(out, "matrix.md")}`,
  );
  process.exitCode = counts.fail === 0 && !summary.fatal ? 0 : 1;
}
