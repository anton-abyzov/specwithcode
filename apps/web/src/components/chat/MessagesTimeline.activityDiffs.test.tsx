// @vitest-environment jsdom

import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  MessageId,
  NodeId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ProjectedTurnItem,
  type OrchestrationV2Subagent,
  OrchestrationV2TurnItem,
} from "@specweave-studio/contracts";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { act, createRef, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { LegendListRef } from "@legendapp/list/react";

// Timeline modules read matchMedia while loading.
vi.hoisted(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: () => ({ matches: false, addEventListener: () => {}, removeEventListener: () => {} }),
  });
});

/** Item detail reads answer with the fixture item itself, as the server would for a small item. */
const detail = vi.hoisted(() => ({ items: new Map<string, unknown>() }));

vi.mock("../../state/queries", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../state/queries")>();
  const read = (target: { itemId: string } | null) =>
    target === null ? null : { item: detail.items.get(target.itemId) ?? null };
  return {
    ...original,
    useTurnItemDetail: (target: { itemId: string } | null) => ({
      data: read(target),
      isPending: false,
      error: null,
    }),
    fetchTurnItemDetail: async (target: { itemId: string }) => read(target),
  };
});

vi.mock("../DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => children,
}));

vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ fileDiff }: { fileDiff: { name: string } }) => (
    <div data-file-diff={fileDiff.name} />
  ),
}));

// Every row mounts, as a list scrolled through end to end would.
vi.mock("@legendapp/list/react", () => ({
  LegendList: (props: {
    data: Array<{ id: string }>;
    keyExtractor: (item: { id: string }) => string;
    renderItem: (args: { item: { id: string } }) => ReactNode;
    ListHeaderComponent?: ReactNode;
    ListFooterComponent?: ReactNode;
  }) => (
    <div>
      {props.ListHeaderComponent}
      {props.data.map((item) => (
        <div key={props.keyExtractor(item)}>{props.renderItem({ item })}</div>
      ))}
      {props.ListFooterComponent}
    </div>
  ),
}));

const { MessagesTimeline } = await import("./MessagesTimeline");
const { __setClientSettingsForTests } = await import("../../hooks/useSettings");
const { deriveTimelineEntriesFromVisibleTurnItems } = await import("../../session-logic");

type TimelineProps = ComponentProps<typeof MessagesTimeline>;
type Level = "concise" | "normal" | "verbose";

const ENVIRONMENT = EnvironmentId.make("environment-local");
const THREAD = ThreadId.make("thread-main");
const CHILD = ThreadId.make("thread-explorer");
const PARENT = ThreadId.make("thread-parent");
const RUN = RunId.make("run-main");
const AT = DateTime.makeUnsafe("2026-10-24T12:00:00.000Z");
const CREATED_AT = DateTime.formatIso(AT);
const ROOT = "/repo";

function turnItem(
  id: string,
  fields: Record<string, unknown>,
  scope: { readonly threadId?: ThreadId; readonly runId?: RunId | null } = {},
): OrchestrationV2TurnItem {
  const item = {
    id: TurnItemId.make(id),
    threadId: scope.threadId ?? THREAD,
    runId: scope.runId === undefined ? RUN : scope.runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: null,
    startedAt: AT,
    completedAt: AT,
    updatedAt: AT,
    ...fields,
  } as unknown as OrchestrationV2TurnItem;
  detail.items.set(item.id, item);
  return item;
}

const patch = (path: string) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1,2 @@\n-old\n+new\n+more\n`;

function fileChange(
  id: string,
  paths: ReadonlyArray<string>,
  scope?: Parameters<typeof turnItem>[2],
  fields: Record<string, unknown> = {},
) {
  return turnItem(
    id,
    {
      type: "file_change",
      fileName: `${ROOT}/${paths[0]}`,
      changes: paths.map((path) => ({
        operation: "update",
        path: `${ROOT}/${path}`,
        diffStr: patch(path),
        additions: 2,
        deletions: 1,
      })),
      ...fields,
    },
    scope,
  );
}

const command = (id: string, input: string, fields: Record<string, unknown> = {}) =>
  turnItem(id, { type: "command_execution", input, output: "", ...fields });

const userMessage = (id: string, text: string, scope?: Parameters<typeof turnItem>[2]) =>
  turnItem(
    id,
    {
      type: "user_message",
      messageId: MessageId.make(id),
      inputIntent: "turn_start",
      text,
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    },
    scope,
  );

const assistantMessage = (id: string, text: string, scope?: Parameters<typeof turnItem>[2]) =>
  turnItem(
    id,
    { type: "assistant_message", messageId: MessageId.make(id), text, streaming: false },
    scope,
  );

function project(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  sourceThreadId: (item: OrchestrationV2TurnItem) => ThreadId = (item) => item.threadId,
): ReadonlyArray<OrchestrationV2ProjectedTurnItem> {
  return items.map((item, position) => {
    const source = sourceThreadId(item);
    return {
      position,
      visibility: source === item.threadId ? "local" : "inherited",
      sourceThreadId: source,
      sourceItemId: item.id,
      item,
    } as OrchestrationV2ProjectedTurnItem;
  });
}

const entriesOf = (items: ReadonlyArray<OrchestrationV2TurnItem>) =>
  deriveTimelineEntriesFromVisibleTurnItems({
    visibleTurnItems: project(items),
    optimisticMessages: [],
  });

const OWN_FILES = [
  "apps/web/src/build.ts",
  "apps/web/src/config.ts",
  "apps/web/src/routes.ts",
  "apps/web/src/theme.css",
];
const SUBAGENT_FILE = "apps/web/src/imports.ts";
const SHELL_FILE = "scripts/generated.json";

function subagentRecord(
  fields: Partial<Pick<OrchestrationV2Subagent, "origin" | "status" | "runId">> = {},
): OrchestrationV2Subagent {
  return {
    id: NodeId.make("node-explorer"),
    threadId: THREAD,
    runId: RUN,
    parentNodeId: NodeId.make("node-main"),
    origin: "provider_native",
    driver: "codex",
    providerInstanceId: "codex",
    providerThreadId: null,
    childThreadId: CHILD,
    nativeTaskRef: null,
    prompt: "Find stale imports",
    title: "Explorer",
    model: null,
    status: "completed",
    ...fields,
  } as unknown as OrchestrationV2Subagent;
}

/** One finished turn: a 4-file edit, four outcomes, a subagent, a shell-written file. */
function mainThread() {
  const items = [
    userMessage("prompt", "Fix the build"),
    assistantMessage("commentary", "Fixing the build first."),
    fileChange("edit-own", OWN_FILES),
    command("command-failed", "npm run build", { status: "failed", exitCode: 2 }),
    command("command-possible", "grep -r TODO src", { outputIndicatesFailure: true }),
    command("command-declined", "rm -rf dist", { status: "cancelled", declined: true }),
    command("command-stopped", "npm test", { status: "interrupted" }),
    turnItem("subagent-explorer", {
      type: "subagent",
      subagentId: NodeId.make("node-explorer"),
      origin: "provider_native",
      driver: "codex",
      providerInstanceId: "codex",
      childThreadId: CHILD,
      title: "Explorer",
      prompt: "Find stale imports",
      result: "Removed one import.",
    }),
    assistantMessage("final", "The build passes."),
  ];
  return {
    timelineEntries: entriesOf(items),
    turnDiffSummaries: [
      {
        runId: RUN,
        checkpointTurnCount: 1,
        checkpointRef: "checkpoint-main" as never,
        status: "ready" as const,
        files: [...OWN_FILES, SUBAGENT_FILE, SHELL_FILE].map((path) => ({
          path,
          kind: "modified",
          additions: 2,
          deletions: 1,
        })),
        assistantMessageId: MessageId.make("final"),
        completedAt: CREATED_AT,
        repoRoot: ROOT,
        cwd: ROOT,
      },
    ],
    runs: [run(RUN, "completed")],
  } satisfies Partial<TimelineProps>;
}

const childEditItems = () => [
  fileChange("edit-subagent", [SUBAGENT_FILE], { threadId: CHILD, runId: null }),
];

function run(id: RunId, status: string) {
  return {
    id,
    ordinal: 1,
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5.5" },
    status,
  } as unknown as TimelineProps["runs"][number];
}

const onOpenTurnDiff = vi.fn();
const clipboard = vi.fn();

function props(overrides: Partial<TimelineProps>): TimelineProps {
  return {
    isWorking: false,
    activeTurnInProgress: false,
    listRef: createRef<LegendListRef | null>(),
    latestRun: null,
    turnDiffSummaries: [],
    providerStatuses: [],
    runs: [],
    routeThreadKey: `${ENVIRONMENT}:${THREAD}`,
    onOpenTurnDiff,
    onOpenThread: () => {},
    onForkFromRun: async () => {},
    onRollbackCheckpoint: () => {},
    supportsConversationRollback: false,
    onRevertToTurnCount: () => {},
    isRevertingCheckpoint: false,
    openingVideoAttachmentId: null,
    onImageExpand: () => {},
    activeThreadEnvironmentId: ENVIRONMENT,
    markdownCwd: undefined,
    resolvedTheme: "light",
    timestampFormat: "locale",
    workspaceRoot: ROOT,
    anchorMessageId: null,
    onAnchorReady: () => {},
    onAnchorSizeChanged: () => {},
    contentInsetEndAdjustment: 0,
    liveFollowEnabled: true,
    onIsAtEndChange: () => {},
    onManualNavigation: () => {},
    timelineEntries: [],
    ...overrides,
  } as TimelineProps;
}

let root: Root | undefined;
let container: HTMLDivElement | undefined;

async function mount(level: Level, overrides: Partial<TimelineProps>) {
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, timelineDetail: level });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<MessagesTimeline {...props(overrides)} />));
  return container;
}

/** Mounts, then opens the folded turn and its groups, as a reader reaching a row would. */
async function mountOpen(level: Level, overrides: Partial<TimelineProps>) {
  const element = await mount(level, overrides);
  await unfoldEverything(element);
  return element;
}

async function click(element: Element | null | undefined) {
  expect(element).toBeTruthy();
  await act(async () => {
    (element as HTMLElement).click();
  });
}

const text = (element: Element | null | undefined) =>
  element?.textContent?.replace(/\s+/g, " ").trim() ?? "";

/** The settled row of one projected item. */
const itemRow = (scope: ParentNode, type: string, label: string) =>
  [...scope.querySelectorAll(`[data-v2-item-type="${type}"]`)].find((row) =>
    text(row).includes(label),
  );

const openDiffIn = (scope: Element | undefined) =>
  scope?.querySelector<HTMLButtonElement>('button[aria-label^="Open diff"]') ?? null;

const turnFold = (scope: ParentNode) =>
  scope.querySelector<HTMLButtonElement>(
    '[data-timeline-row-kind="turn-fold"] button[aria-expanded]',
  );

function failureCounts(scope: Element | null | undefined) {
  const counts = scope?.querySelector("[data-failure-counts]");
  return {
    failed: text(counts?.querySelector("[data-failed-count]")),
    faint: [...(counts?.querySelectorAll("[data-faint-count]") ?? [])].map(text),
  };
}

const EXPECTED_COUNTS = { failed: "1 failed", faint: ["1 possible failure", "1 declined"] };

/** Opens the folded turn and every collapsed tool group, as a reader would. */
async function unfoldEverything(scope: HTMLElement) {
  const fold = turnFold(scope);
  if (fold?.getAttribute("aria-expanded") === "false") await click(fold);
  for (const header of scope.querySelectorAll('[data-tool-group-header][aria-expanded="false"]')) {
    await click(header);
  }
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  clipboard.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: clipboard },
  });
  onOpenTurnDiff.mockReset();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  vi.unstubAllGlobals();
});

describe.each(["concise", "normal", "verbose"] as const)("one thread in %s", (level) => {
  it.each([true, false])(
    "keeps Open diff, failure counts, chips and attribution (subagent loaded: %s)",
    async (loaded) => {
      const fixture = mainThread();
      const element = await mount(level, {
        ...fixture,
        ...(loaded ? { loadedSubagentEditItems: new Map([[CHILD, childEditItems()]]) } : {}),
      });

      // AC-10: the fold names every failure it hides, collapsed or open.
      const fold = turnFold(element);
      expect(fold?.getAttribute("aria-expanded")).toBe(level === "verbose" ? "true" : "false");
      expect(failureCounts(fold)).toEqual(EXPECTED_COUNTS);
      expect(fold?.querySelector("[data-failed-count]")?.className).toContain(
        "text-tool-error-icon",
      );
      for (const faint of fold?.querySelectorAll("[data-faint-count]") ?? []) {
        expect(faint.className).toContain("text-muted-foreground");
      }

      await unfoldEverything(element);
      const headers = [...element.querySelectorAll("[data-tool-group-header]")];
      expect(headers.length).toBeGreaterThan(0);
      const failingHeaders = headers.filter((header) => failureCounts(header).failed !== "");
      expect(failingHeaders).toHaveLength(1);
      expect(failureCounts(failingHeaders[0])).toEqual(EXPECTED_COUNTS);

      // Failed, declined and stopped rows keep their chip.
      const chips = [...element.querySelectorAll("[data-outcome-chip]")].map((chip) => [
        chip.getAttribute("data-outcome-chip"),
        text(chip),
      ]);
      expect(chips).toEqual([
        ["failed", "exit 2"],
        ["declined", "declined"],
        ["stopped", "stopped"],
      ]);
      const declinedRow = itemRow(element, "command_execution", "rm -rf dist");
      expect(text(declinedRow)).toMatch(/^Declined\b/);
      expect(text(declinedRow)).not.toContain("Stopped");

      // AC-03: the edit row leads with its path, the other files and the counts.
      const editRow = itemRow(element, "file_change", "build.ts");
      expect(text(editRow?.querySelector("[data-row-path]"))).toBe("repo/apps/web/src/build.ts");
      expect(text(editRow)).toContain("+3 more");
      expect(text(editRow)).not.toContain("Changed 4 files");

      // AC-04: the row's link carries its thread, run and path.
      await click(openDiffIn(editRow));
      expect(onOpenTurnDiff).toHaveBeenLastCalledWith(RUN, `${ROOT}/${OWN_FILES[0]}`, {
        sourceThreadId: THREAD,
      });

      // So does the card's.
      const card = element.querySelector("[data-changed-files-state]");
      expect(card?.getAttribute("data-changed-files-state")).toBe(
        level === "concise" ? "summary" : "tree",
      );
      await click(openDiffIn(card?.querySelector("[data-changed-files-header]") ?? undefined));
      expect(onOpenTurnDiff).toHaveBeenLastCalledWith(RUN, `${ROOT}/${OWN_FILES[0]}`, {
        sourceThreadId: THREAD,
      });

      // AC-19: a loaded subagent's file lists under it; otherwise it stays unattributed.
      const header = text(card?.querySelector("[data-changed-files-header]"));
      if (level === "concise") {
        expect(header).toContain("1 failed");
        expect(header).toContain(loaded ? "+1 not from edit tools" : "+2 not from edit tools");
        if (loaded) expect(header).toContain("1 by subagent Explorer");
        else expect(header).not.toContain("by subagent");
      } else {
        const expandFolders = card?.querySelector('button[aria-label="Expand all folders"]');
        if (expandFolders) await click(expandFolders);
        const subagentSection = card?.querySelector('[data-changed-files-section="subagent"]');
        const notReported = card?.querySelector('[data-changed-files-section="not-reported"]');
        expect(text(notReported)).toContain("generated.json");
        if (loaded) {
          expect(text(subagentSection)).toContain("Edited by subagent Explorer");
          expect(text(subagentSection)).toContain("imports.ts");
          expect(text(notReported)).not.toContain("imports.ts");
        } else {
          expect(subagentSection).toBeNull();
          expect(text(notReported)).toContain("imports.ts");
          expect(text(notReported)).toContain(
            "May include edits by subagent Explorer, whose activity is not loaded here.",
          );
        }
      }

      // Verbose opens every row; a multi-file edit opens its first 3 file sections.
      const patches = editRow?.querySelectorAll("[data-file-diff]") ?? [];
      expect(patches).toHaveLength(level === "verbose" ? 3 : 0);
    },
  );
});

describe("the changed-files card", () => {
  const checkpoint = (files: ReadonlyArray<string>, cwd: string) => ({
    runId: RUN,
    checkpointTurnCount: 1,
    checkpointRef: "checkpoint-moved" as never,
    status: "ready" as const,
    files: files.map((path) => ({ path, kind: "modified", additions: 1, deletions: 0 })),
    assistantMessageId: MessageId.make("final"),
    completedAt: CREATED_AT,
    repoRoot: ROOT,
    cwd,
  });

  it("names a card file by its repository path, never relative to the turn's folder", async () => {
    // Both names exist; read relative to packages/app, the first would reveal the second.
    const files = ["packages/app/file.ts", "packages/app/packages/app/file.ts"];
    const element = await mount("normal", {
      timelineEntries: entriesOf([
        userMessage("prompt", "Edit it"),
        assistantMessage("final", "Done."),
      ]),
      turnDiffSummaries: [checkpoint(files, `${ROOT}/packages/app`)],
      runs: [run(RUN, "completed")],
    });
    const card = element.querySelector("[data-changed-files-state]");
    await click(openDiffIn(card?.querySelector("[data-changed-files-header]") ?? undefined));
    expect(onOpenTurnDiff).toHaveBeenLastCalledWith(RUN, `${ROOT}/${files[0]}`, {
      sourceThreadId: THREAD,
    });
  });

  it("attributes a relative edit path to the folder the turn ran in, not today's", async () => {
    const edit = fileChange("edit-moved", ["file.ts"], undefined, {
      fileName: "file.ts",
      changes: [{ operation: "update", path: "file.ts", additions: 1, deletions: 0 }],
    });
    const element = await mountOpen("normal", {
      workspaceRoot: `${ROOT}/app2`,
      timelineEntries: entriesOf([
        userMessage("prompt", "Edit it"),
        edit,
        assistantMessage("final", "Done."),
      ]),
      turnDiffSummaries: [checkpoint(["app1/file.ts", "app1/other.ts"], `${ROOT}/app1`)],
      runs: [run(RUN, "completed")],
    });
    const card = element.querySelector("[data-changed-files-state]");
    const expandFolders = card?.querySelector('button[aria-label="Expand all folders"]');
    if (expandFolders) await click(expandFolders);
    const notReported = card?.querySelector('[data-changed-files-section="not-reported"]');
    expect(text(notReported)).toContain("other.ts");
    expect(text(notReported)).not.toContain("file.ts");
  });
});

describe("edit and read rows", () => {
  it("shows a lone edit's path and counts and copies the exact full path", async () => {
    const element = await mountOpen("normal", {
      timelineEntries: entriesOf([
        userMessage("prompt", "Rename the helper"),
        fileChange("edit-one", ["packages/core/src/chat/streaming.ts"], undefined, {
          changes: [
            {
              operation: "update",
              path: `${ROOT}/packages/core/src/chat/streaming.ts`,
              additions: 12,
              deletions: 4,
            },
          ],
        }),
      ]),
      runs: [run(RUN, "completed")],
    });
    const row = itemRow(element, "file_change", "streaming.ts");
    expect(text(row?.querySelector("[data-row-path]"))).toBe(
      "repo/packages/core/src/chat/streaming.ts",
    );
    expect(row?.querySelector("[title]")?.getAttribute("title")).toBe(
      `${ROOT}/packages/core/src/chat/streaming.ts`,
    );
    expect(text(row)).toMatch(/Edited.*\+12.*4/);
    await click(row?.querySelector('button[aria-label="Copy path"]'));
    expect(clipboard).toHaveBeenCalledWith(`${ROOT}/packages/core/src/chat/streaming.ts`);
  });

  it("lets a narrow row cut its labels only where hover gives the full text", async () => {
    const element = await mountOpen("normal", mainThread());
    // A tool group's summary truncates, and its tooltip is the whole summary.
    const header = element.querySelector('[data-tool-group-header="settled"]');
    const summary = header?.querySelector("span.truncate");
    expect(text(summary)).not.toBe("");
    expect(summary?.getAttribute("title")).toBe(text(summary));
    // The folders give way first; the file name truncates last, under the row's title.
    const editRow = itemRow(element, "file_change", "build.ts");
    const path = editRow?.querySelector("[data-row-path]");
    expect(path?.className).toContain("[&>span:first-child]:shrink-[1000000]");
    expect(path?.className).toContain("[&>span:last-child]:truncate");
    expect(path?.closest("[title]")?.getAttribute("title")).toContain(`${ROOT}/${OWN_FILES[0]}`);
  });

  it("shows a read outside the workspace by its absolute path", async () => {
    const element = await mountOpen("normal", {
      timelineEntries: entriesOf([
        userMessage("prompt", "Read the brief"),
        turnItem("read-brief", {
          type: "dynamic_tool",
          toolName: "Read",
          input: { file_path: "/tmp/sk-cost-arch/brief.md" },
          output: "# Brief",
        }),
      ]),
      runs: [run(RUN, "completed")],
    });
    const row = itemRow(element, "dynamic_tool", "brief.md");
    expect(text(row?.querySelector("[data-row-path]"))).toBe("/tmp/sk-cost-arch/brief.md");
    await click(row?.querySelector('button[aria-label="Copy path"]'));
    expect(clipboard).toHaveBeenCalledWith("/tmp/sk-cost-arch/brief.md");
  });

  it("copies an edited path with a trailing no-break space as the provider sent it", async () => {
    const path = `${ROOT}/notes.txt\u00a0`;
    const sent = fileChange("edit-notes", ["notes.txt"], undefined, {
      fileName: path,
      changes: [{ operation: "update", path, additions: 1, deletions: 0 }],
    });
    // Through the wire contract, as the client receives it.
    const received = Schema.decodeSync(OrchestrationV2TurnItem)(
      Schema.encodeSync(OrchestrationV2TurnItem)(sent),
    );
    expect(received).toMatchObject({ fileName: path, changes: [{ path }] });
    const element = await mountOpen("normal", {
      timelineEntries: entriesOf([userMessage("prompt", "Edit the notes"), received]),
      runs: [run(RUN, "completed")],
    });
    const row = itemRow(element, "file_change", "notes.txt");
    await click(row?.querySelector('button[aria-label="Copy path"]'));
    expect(clipboard).toHaveBeenCalledWith(path);
  });

  it("joins a relative edited path that starts with a space to the root without trimming it", async () => {
    const path = " ./notes.txt";
    const sent = fileChange("edit-spaced", ["notes.txt"], undefined, {
      fileName: path,
      changes: [{ operation: "update", path, additions: 1, deletions: 0 }],
    });
    const received = Schema.decodeSync(OrchestrationV2TurnItem)(
      Schema.encodeSync(OrchestrationV2TurnItem)(sent),
    );
    const element = await mountOpen("normal", {
      timelineEntries: entriesOf([userMessage("prompt", "Edit the notes"), received]),
      runs: [run(RUN, "completed")],
    });
    const row = itemRow(element, "file_change", "notes.txt");
    await click(row?.querySelector('button[aria-label="Copy path"]'));
    expect(clipboard).toHaveBeenCalledWith(`${ROOT}/ ./notes.txt`);
  });

  it("copies a long command exactly and keeps its first line whole in the tooltip", async () => {
    // A quoted no-break space and the trailing newline are part of the command.
    const input =
      "pnpm --filter @specweave-studio/web exec vitest run src/components/chat/MessagesTimeline.activityDiffs.test.tsx --reporter=verbose\necho 'done\u00a0now'\n";
    const element = await mountOpen("normal", {
      timelineEntries: entriesOf([
        userMessage("prompt", "Run the test"),
        command("command-long", input, { exitCode: 0 }),
      ]),
      runs: [run(RUN, "completed")],
    });
    const row = itemRow(element, "command_execution", "pnpm");
    expect(row?.querySelector("[title]")?.getAttribute("title")).toContain(input.split("\n")[0]);
    await click(
      row?.querySelector('button[aria-label="Copy command"], button[aria-label="Copy script"]'),
    );
    expect(clipboard).toHaveBeenCalledWith(input);
  });

  it("disables Open diff while the turn runs, with the reason", async () => {
    const live = RunId.make("run-live");
    const element = await mountOpen("normal", {
      isWorking: true,
      activeTurnInProgress: true,
      timelineEntries: entriesOf([
        userMessage("prompt", "Edit the config", { runId: live }),
        fileChange("edit-live", ["apps/web/src/config.ts"], { runId: live }),
      ]),
      runs: [run(live, "running")],
    });
    const button = openDiffIn(itemRow(element, "file_change", "config.ts"));
    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute("aria-label")).toBe("Open diff. Diff available when the turn ends");
    expect(button?.parentElement?.getAttribute("title")).toBe("Diff available when the turn ends");
  });

  it("opens an inherited row's diff in its source thread", async () => {
    const parentRun = RunId.make("run-parent");
    const inherited = fileChange("edit-inherited", ["apps/web/src/legacy.ts"], {
      threadId: PARENT,
      runId: parentRun,
    });
    const element = await mountOpen("normal", {
      timelineEntries: deriveTimelineEntriesFromVisibleTurnItems({
        visibleTurnItems: project([userMessage("prompt", "Continue"), inherited]),
        optimisticMessages: [],
      }),
      runs: [run(RUN, "completed")],
    });
    await click(openDiffIn(itemRow(element, "file_change", "legacy.ts")));
    expect(onOpenTurnDiff).toHaveBeenCalledWith(parentRun, `${ROOT}/apps/web/src/legacy.ts`, {
      sourceThreadId: PARENT,
    });
  });
});

describe("subagent thread rows", () => {
  const childThread = (runId: RunId | null) =>
    entriesOf([
      userMessage("child-prompt", "Find stale imports", { threadId: CHILD, runId }),
      fileChange("edit-subagent", [SUBAGENT_FILE], { threadId: CHILD, runId }),
    ]);

  it("opens a provider-native subagent's edit in the parent run, attributed", async () => {
    const element = await mountOpen("normal", {
      routeThreadKey: `${ENVIRONMENT}:${CHILD}`,
      timelineEntries: childThread(null),
      subagentParent: {
        threadId: THREAD,
        subagents: [subagentRecord()],
        runs: [{ id: RUN, status: "completed" }],
      },
    });
    await click(openDiffIn(itemRow(element, "file_change", "imports.ts")));
    expect(onOpenTurnDiff).toHaveBeenCalledWith(RUN, `${ROOT}/${SUBAGENT_FILE}`, {
      sourceThreadId: THREAD,
      attributedTo: { title: "Explorer", running: false },
    });
  });

  it("waits for the parent turn to end while it runs", async () => {
    const element = await mountOpen("normal", {
      routeThreadKey: `${ENVIRONMENT}:${CHILD}`,
      timelineEntries: childThread(null),
      subagentParent: {
        threadId: THREAD,
        subagents: [subagentRecord({ status: "running" })],
        runs: [{ id: RUN, status: "running" }],
      },
    });
    const button = openDiffIn(itemRow(element, "file_change", "imports.ts"));
    expect(button?.disabled).toBe(true);
    expect(button?.getAttribute("aria-label")).toBe("Open diff. Diff available when the turn ends");
  });

  it("opens an app-owned delegate's edit in its own thread", async () => {
    const delegateRun = RunId.make("run-delegate");
    const element = await mountOpen("normal", {
      routeThreadKey: `${ENVIRONMENT}:${CHILD}`,
      timelineEntries: childThread(delegateRun),
      runs: [run(delegateRun, "completed")],
      subagentParent: {
        threadId: THREAD,
        subagents: [subagentRecord({ origin: "app_owned", runId: RUN })],
        runs: [{ id: RUN, status: "completed" }],
      },
    });
    await click(openDiffIn(itemRow(element, "file_change", "imports.ts")));
    expect(onOpenTurnDiff).toHaveBeenCalledWith(delegateRun, `${ROOT}/${SUBAGENT_FILE}`, {
      sourceThreadId: CHILD,
    });
  });
});
