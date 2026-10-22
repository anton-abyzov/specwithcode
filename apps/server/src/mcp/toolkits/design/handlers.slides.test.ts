// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Writes exported files and a design system fixture.
/**
 * 0975 AC-07 and AC-08: an agent builds a slide deck through the MCP handlers
 * with design_create and design_apply only, and the deck exports to a PPTX
 * that an independent reader (python-pptx) opens with the expected slides,
 * text and notes, and to a PDF with one page per slide that is not skipped.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import {
  DESIGN_SYSTEM_SCHEMA,
  EnvironmentId,
  PROJECT_DESIGN_DIR,
  ProviderInstanceId,
  ThreadId,
  type DesignGetResult,
  type DesignTokenValue,
} from "@specweave-studio/contracts";
import { HostProcessEnvironment } from "@specweave-studio/shared/hostProcess";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as DesignService from "../../../design/DesignService.ts";
import {
  layerDesignDependencies,
  makeDesignFixture,
  PROJECT_A,
  TEST_BROWSER_ENV,
  type DesignFixture,
} from "../../../design/DesignService.testkit.ts";
import { writeDesignSystem } from "../../../design/DesignStore.ts";
import {
  EVIDENCE_DIR_ENV,
  PYTHON_PPTX_ENV,
  pptxReadBack,
  readZipText,
  slideXml,
  textRuns,
} from "../../../design/export/pptx.testkit.ts";
import { DesignSystemProposals } from "../../../design/systems/DesignSystemService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";

const agentThread = ThreadId.make("thread-deck-author");

const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("env-here"),
  requestNamespace: "design-slides",
  thread: {
    threadId: agentThread,
    providerSessionId: "session-deck",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  issuedAt: 0,
  capabilities: new Set(["orchestration"]),
};

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "slides-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "slides-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

/** Every agent call in these tests goes through this, and only to the two authoring tools. */
const agentCalls: string[] = [];
const call = (name: "design_create" | "design_apply", args: Record<string, unknown>) =>
  Effect.gen(function* () {
    agentCalls.push(name);
    const server = yield* McpServer.McpServer;
    const result = yield* server
      .callTool({ name, arguments: args })
      .pipe(
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, client),
      );
    expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
    return result.structuredContent as DesignGetResult;
  });

const withServer = <A, E>(
  run: (
    fixture: DesignFixture,
  ) => Effect.Effect<A, E, McpServer.McpServer | DesignService.DesignService>,
  executable?: string,
) =>
  Effect.acquireUseRelease(
    Effect.sync(makeDesignFixture),
    (fixture) =>
      run(fixture).pipe(
        Effect.provide(
          Layer.mergeAll(McpHttpServer.layerDesignToolkit, DesignService.layerWithRender).pipe(
            Layer.provideMerge(McpServer.McpServer.layer),
            Layer.provide(DesignSystemProposals.layer),
            Layer.provide(layerDesignDependencies(fixture, executable)),
            Layer.provide(
              Layer.mock(ThreadManagement.ThreadManagementService)({
                getThreadShell: (threadId) =>
                  Effect.succeed({
                    ...liveThreadShell(threadId),
                    projectId: PROJECT_A,
                    modelSelection: {
                      instanceId: ProviderInstanceId.make("codex"),
                      model: "gpt-5",
                    },
                  }),
              }),
            ),
          ),
        ),
      ),
    (fixture) => Effect.sync(fixture.cleanup),
  );

const value = (raw: string): DesignTokenValue => ({
  raw,
  resolved: raw,
  provenance: { source: "agent", location: "deck", extractor: "test" },
});

/** The project's design system, as design_system_list would offer it to the agent. */
const writeDeckSystem = (fixture: DesignFixture) =>
  Effect.promise(() => {
    const root = NodePath.join(fixture.roots[PROJECT_A]!, PROJECT_DESIGN_DIR);
    NodeFS.mkdirSync(root, { recursive: true });
    return writeDesignSystem(
      root,
      {
        schema: DESIGN_SYSTEM_SCHEMA,
        id: "s_deck",
        name: "Deck",
        revision: 0,
        createdAt: "2026-10-20T10:00:00.000Z",
        updatedAt: "2026-10-20T10:00:00.000Z",
        modes: [{ id: "light", name: "Light" }],
        tokens: [
          {
            name: "deck-bg",
            type: "color",
            values: { light: value("oklch(0.208 0.042 265.755)") },
          },
          { name: "deck-ink", type: "color", values: { light: value("#f8fafc") } },
          { name: "deck-accent", type: "color", values: { light: value("rgb(234 88 12)") } },
          { name: "deck-title", type: "dimension", values: { light: value("5rem") } },
          { name: "deck-body", type: "dimension", values: { light: value("40px") } },
        ],
        components: [],
        sources: [],
        copiedFrom: null,
      },
      { expectedRevision: null, actor: { kind: "user" } },
    );
  });

const text = (id: string, parentId: string, body: string, y: number, size: string) => ({
  id,
  parentId,
  type: "text",
  name: id,
  text: body,
  x: 160,
  y,
  width: 1600,
  height: size === "deck-title" ? 200 : 300,
  color: { token: "deck-ink" },
  fontSize: { token: size },
  fontWeight: size === "deck-title" ? 700 : 400,
});
const slideFrame = (id: string) => ({
  id,
  parentId: null,
  type: "frame",
  name: id,
  x: 0,
  y: 0,
  width: 1920,
  height: 1080,
  fill: { token: "deck-bg" },
  clip: true,
});

/** The agent's whole authoring session: create the deck, then edit it in two applies. */
const authorDeck = (withHtml: boolean) =>
  Effect.gen(function* () {
    const created = yield* call("design_create", { kind: "slides", title: "Launch plan" });
    expect(created.document.kind).toBe("slides");
    const designId = created.document.id;
    const first = created.document.pages[0]!;
    const firstFrame = first.nodes[0]!;
    expect(firstFrame).toMatchObject({ type: "frame", width: 1920, height: 1080 });

    const styled = yield* call("design_apply", {
      designId,
      expectedRevision: 0,
      operations: [
        { op: "set_design_system", systemId: "s_deck" },
        {
          op: "update_node",
          pageId: first.id,
          id: firstFrame.id,
          patch: { fill: { token: "deck-bg" } },
        },
        {
          op: "add_node",
          pageId: first.id,
          node: text("n_title", firstFrame.id, "Launch plan", 380, "deck-title"),
        },
        {
          op: "add_node",
          pageId: first.id,
          node: {
            id: "n_rule",
            parentId: firstFrame.id,
            type: "rect",
            name: "Accent",
            x: 160,
            y: 620,
            width: 240,
            height: 16,
            fill: { token: "deck-accent" },
            radius: 8,
          },
        },
        {
          op: "update_page",
          pageId: first.id,
          name: "Title",
          notes: "Welcome everyone. Today: the launch plan.",
        },
      ],
    });
    expect(styled.document.designSystem).toBe("s_deck");

    const built = yield* call("design_apply", {
      designId,
      expectedRevision: styled.document.revision,
      operations: [
        {
          op: "add_page",
          page: {
            id: "p_goals",
            name: "Goals",
            notes: "Three goals, one per quarter.",
            nodes: [
              slideFrame("n_goals"),
              text("n_goals_title", "n_goals", "Goals", 120, "deck-title"),
              text(
                "n_goals_body",
                "n_goals",
                "Ship the beta\nGrow to 10k users\nHire two engineers",
                360,
                "deck-body",
              ),
              {
                id: "n_badge",
                parentId: "n_goals",
                type: "ellipse",
                name: "Badge",
                x: 1600,
                y: 120,
                width: 160,
                height: 160,
                fill: { token: "deck-accent" },
              },
              ...(withHtml
                ? [
                    {
                      id: "n_chart",
                      parentId: "n_goals",
                      type: "html",
                      name: "Chart",
                      x: 1100,
                      y: 420,
                      width: 640,
                      height: 400,
                      html: '<div style="font:600 48px system-ui;color:#f8fafc;display:flex;gap:24px;align-items:flex-end;height:360px"><div style="background:#ea580c;width:120px;height:120px"></div><div style="background:#ea580c;width:120px;height:240px"></div><div style="background:#ea580c;width:120px;height:340px"></div></div>',
                    },
                  ]
                : []),
            ],
          },
        },
        {
          op: "add_page",
          page: {
            id: "p_backup",
            name: "Backup",
            nodes: [
              slideFrame("n_backup"),
              text("n_backup_title", "n_backup", "Backup numbers", 120, "deck-title"),
            ],
          },
        },
        { op: "update_page", pageId: "p_backup", skipped: true, notes: "Only if asked." },
        {
          op: "add_page",
          page: {
            id: "p_thanks",
            name: "Thanks",
            nodes: [
              slideFrame("n_thanks"),
              text("n_thanks_title", "n_thanks", "Questions?", 440, "deck-title"),
            ],
          },
        },
      ],
    });
    expect(built.document.pages.map((page) => [page.name, page.skipped === true])).toEqual([
      ["Title", false],
      ["Goals", false],
      ["Backup", true],
      ["Thanks", false],
    ]);
    return built.document;
  });

const exportDeck = (designId: string, pageId: string, format: "pptx" | "pdf") =>
  Effect.gen(function* () {
    const designs = yield* DesignService.DesignService;
    const exported = yield* designs.export(DesignService.ownerCaller, {
      owner: { kind: "project", projectId: PROJECT_A },
      designId,
      pageId,
      format,
    });
    return { ...exported, bytes: Buffer.from(exported.data, "base64") };
  });

/** Writes an export to the evidence folder when one is configured, else to a temp file. */
const saveExport = (directory: string | undefined, name: string, bytes: Uint8Array) => {
  const folder =
    directory ?? NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "studio-slides-export-"));
  NodeFS.mkdirSync(folder, { recursive: true });
  const file = NodePath.join(folder, name);
  NodeFS.writeFileSync(file, bytes);
  return file;
};

const EXPECTED_TEXT = [
  ["Launch plan"],
  ["Goals", "Ship the beta\nGrow to 10k users\nHire two engineers"],
  ["Questions?"],
];
const EXPECTED_NOTES = [
  "Welcome everyone. Today: the launch plan.",
  "Three goals, one per quarter.",
  "",
];

it.live(
  "an agent authors a deck with design_create and design_apply; it exports to PPTX (AC-07)",
  () =>
    withServer((fixture) =>
      Effect.gen(function* () {
        agentCalls.length = 0;
        yield* writeDeckSystem(fixture);
        const document = yield* authorDeck(false);
        expect(new Set(agentCalls)).toEqual(new Set(["design_create", "design_apply"]));

        // No HTML in this deck, so no browser is needed: everything is native.
        const pptx = yield* exportDeck(document.id, document.pages[0]!.id, "pptx");
        expect(pptx).toMatchObject({
          fileName: "launch-plan.pptx",
          mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          width: 1920,
          height: 1080,
        });
        const entries = yield* Effect.promise(() => readZipText(pptx.bytes));
        const slides = slideXml(entries);
        expect(slides.map(textRuns)).toEqual(
          EXPECTED_TEXT.map((runs) => runs.flatMap((run) => run.split("\n"))),
        );
        // Token values are resolved: the slate background and the orange accent.
        expect(slides[0]).toContain('<a:srgbClr val="0F172B"');
        expect(slides[0]).toContain('<a:srgbClr val="EA580C"');
        expect(slides[0]).toContain('sz="4000"');
        expect(slides.join("")).not.toContain("<p:pic>");

        const env = yield* HostProcessEnvironment;
        const file = saveExport(env[EVIDENCE_DIR_ENV], "launch-plan-native.pptx", pptx.bytes);
        // The independent read-back runs where python-pptx is available (AC-08).
        const python = env[PYTHON_PPTX_ENV];
        if (!python) return;
        const read = pptxReadBack(python, file);
        expect(read.slideWidth).toBe(12192000);
        expect(read.slideHeight).toBe(6858000);
        expect(read.slides.map((slide) => slide.texts)).toEqual(EXPECTED_TEXT);
        expect(read.slides.map((slide) => slide.notes)).toEqual(EXPECTED_NOTES);
        expect(read.slides[1]!.shapes.map((shape) => shape.name)).toEqual([
          "n_goals_title",
          "n_goals_body",
          "Badge",
        ]);
      }),
    ),
);

it.live(
  "renders HTML parts as pictures in the PPTX and prints one PDF page per slide (AC-06, AC-08)",
  (ctx) =>
    Effect.gen(function* () {
      const env = yield* HostProcessEnvironment;
      const executable = env[TEST_BROWSER_ENV];
      if (!executable) return ctx.skip(`Set ${TEST_BROWSER_ENV} to run this test.`);
      yield* withServer(
        (fixture) =>
          Effect.gen(function* () {
            yield* writeDeckSystem(fixture);
            const document = yield* authorDeck(true);
            const pptx = yield* exportDeck(document.id, document.pages[0]!.id, "pptx");
            const slides = slideXml(yield* Effect.promise(() => readZipText(pptx.bytes)));
            expect(slides).toHaveLength(3);
            expect(slides[1]!.match(/<p:pic>/g)).toHaveLength(1);
            expect(slides[1]).toContain('name="Chart"');
            const pptxFile = saveExport(env[EVIDENCE_DIR_ENV], "launch-plan.pptx", pptx.bytes);

            const pdf = yield* exportDeck(document.id, document.pages[0]!.id, "pdf");
            expect(pdf).toMatchObject({ fileName: "launch-plan.pdf", width: 1920, height: 1080 });
            const pdfText = pdf.bytes.toString("latin1");
            expect(pdfText.startsWith("%PDF-")).toBe(true);
            // One page per slide that is not skipped, each at the slide's size (CSS px are 0.75 pt).
            expect(pdfText.match(/\/Type\s*\/Page(?![s\w])/g)).toHaveLength(3);
            const boxes = [...pdfText.matchAll(/\/MediaBox\s*\[\s*0 0 ([\d.]+) ([\d.]+)\s*\]/g)];
            expect(boxes.map((box) => [Number(box[1]), Number(box[2])])).toEqual([
              [1440, 810],
              [1440, 810],
              [1440, 810],
            ]);
            saveExport(env[EVIDENCE_DIR_ENV], "launch-plan.pdf", pdf.bytes);

            const python = env[PYTHON_PPTX_ENV];
            if (!python) return;
            const read = pptxReadBack(python, pptxFile);
            expect(read.slides.map((slide) => slide.texts)).toEqual(EXPECTED_TEXT);
            expect(read.slides.map((slide) => slide.notes)).toEqual(EXPECTED_NOTES);
            expect(read.slides[1]!.shapes.find((shape) => shape.name === "Chart")).toEqual({
              name: "Chart",
              kind: "picture",
            });
          }),
        executable,
      );
    }),
);
