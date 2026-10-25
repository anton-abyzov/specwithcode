// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import type {
  EnvironmentId,
  OrchestrationV2GetTurnItemResult,
  OrchestrationV2ProjectedTurnItem,
  OrchestrationV2TurnItem,
  OrchestrationV2TurnItemDetailField,
  OrchestrationV2TurnItemPageInfo,
  RunId,
  ThreadId,
} from "@specweave-studio/contracts";
import { LIVE_DETAIL_REFRESH_MS } from "@specweave-studio/client-runtime/work-log/item-detail";
import { sliceTextPage, TRANSPORT_TRUNCATION_MARKER } from "@specweave-studio/shared/toolOutput";
import * as DateTime from "effect/DateTime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { TurnItemDetailTarget } from "../../state/queries";
import { V2ItemInspector } from "./V2ItemInspector";

/** A fake server: every read is answered from these stored texts, paged like the real one. */
const server = vi.hoisted(() => ({
  theme: "light" as "light" | "dark",
  targets: [] as Array<unknown>,
  fetches: [] as Array<unknown>,
  read: (_target: unknown): unknown => ({ item: null }),
}));

vi.mock("../../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: server.theme }) }));
vi.mock("./HighlightedTokens", () => ({
  HighlightedTokens: ({ code }: { code: string }) => <span>{code}</span>,
}));
vi.mock("../../state/v2ItemSupport", () => ({ useV2ItemSupport: () => ({}) }));
vi.mock("../DiffWorkerPoolProvider", () => ({
  DiffWorkerPoolProvider: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({
    fileDiff,
    options,
  }: {
    fileDiff: {
      name: string;
      hunks: Array<{ additionLines: number; deletionLines: number }>;
    };
    options?: { theme?: string; unsafeCSS?: string };
  }) => (
    <div
      data-file-diff={fileDiff.name}
      data-theme={options?.theme}
      data-unsafe-css={options?.unsafeCSS}
      data-additions={fileDiff.hunks.reduce((total, hunk) => total + hunk.additionLines, 0)}
      data-deletions={fileDiff.hunks.reduce((total, hunk) => total + hunk.deletionLines, 0)}
    />
  ),
}));
vi.mock("../../state/queries", () => ({
  useTurnItemDetail: (target: unknown) => {
    server.targets.push(target);
    return target === null
      ? { data: null, isPending: false, error: null }
      : { data: server.read(target), isPending: false, error: null };
  },
  fetchTurnItemDetail: async (target: unknown) => {
    server.fetches.push(target);
    return server.read(target);
  },
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const ENVIRONMENT = "fixture" as EnvironmentId;
const THREAD = "thread-1" as ThreadId;
const RUN = "run-1" as RunId;
const updatedAt = DateTime.makeUnsafe("2026-10-24T12:00:00.000Z");
const REVISION = DateTime.formatIso(updatedAt);

function turnItem(fields: Record<string, unknown>): OrchestrationV2TurnItem {
  return {
    id: "item-1",
    threadId: THREAD,
    runId: RUN,
    nodeId: "node-1",
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    status: "completed",
    title: null,
    startedAt: updatedAt,
    completedAt: updatedAt,
    updatedAt,
    ...fields,
  } as unknown as OrchestrationV2TurnItem;
}

/** Answers field reads from `texts` (keyed `field` or `body:<changeIndex>`), and others with `detail`. */
function serve(input: {
  readonly wire: OrchestrationV2TurnItem;
  readonly texts?: Record<string, string>;
  /** The answer to a read without a field; items may carry the bodies the timeline withholds. */
  readonly detail?: {
    readonly item: OrchestrationV2TurnItem | Record<string, unknown>;
    readonly truncated?: ReadonlyArray<OrchestrationV2TurnItemPageInfo>;
  };
  readonly revision?: () => string;
  /** The item a field read returns beside its page, when it differs from the timeline's. */
  readonly pageItem?: OrchestrationV2TurnItem;
}) {
  server.read = (raw) => {
    const target = raw as TurnItemDetailTarget;
    if (target.field === undefined) return input.detail ?? { item: input.wire };
    const key =
      target.changeIndex === undefined ? target.field : `${target.field}:${target.changeIndex}`;
    const text = input.texts?.[key];
    if (text === undefined) return { item: input.pageItem ?? input.wire };
    const page = sliceTextPage(text, {
      offset: target.offset,
      before: target.before,
      anchor: target.anchor,
    });
    return {
      item: input.pageItem ?? input.wire,
      page: {
        field: target.field,
        ...(target.changeIndex === undefined ? {} : { changeIndex: target.changeIndex }),
        offset: page.offset,
        end: page.end,
        totalLength: page.totalLength,
        nextOffset: page.nextOffset,
        revision: input.revision?.() ?? REVISION,
        text: page.text,
      },
    } satisfies OrchestrationV2GetTurnItemResult;
  };
}

/** What a read without a field returns for a cut text: its first page, the marker and the entry. */
function firstPage(
  text: string,
  field: OrchestrationV2TurnItemDetailField,
  changeIndex?: number,
): { readonly text: string; readonly info: OrchestrationV2TurnItemPageInfo } {
  const page = sliceTextPage(text);
  return {
    text: `${page.text}${TRANSPORT_TRUNCATION_MARKER}`,
    info: {
      field,
      ...(changeIndex === undefined ? {} : { changeIndex }),
      offset: page.offset,
      end: page.end,
      totalLength: page.totalLength,
      nextOffset: page.nextOffset,
      revision: REVISION,
    },
  };
}

const sha256 = async (text: string) =>
  Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text))),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
const count = (value: number) => new Intl.NumberFormat("en-US").format(value);

let root: Root | undefined;
let container: HTMLDivElement | undefined;
let clipboard: ReturnType<typeof vi.fn>;
const onOpenTurnDiff = vi.fn();
const onOpenThread = vi.fn();

function inspector(
  item: OrchestrationV2TurnItem,
  props: Partial<Parameters<typeof V2ItemInspector>[0]> = {},
  sourceThreadId: ThreadId = THREAD,
) {
  const projectedItem = {
    position: 0,
    visibility: sourceThreadId === THREAD ? "local" : "inherited",
    sourceThreadId,
    sourceItemId: item.id,
    item,
  } as OrchestrationV2ProjectedTurnItem;
  return (
    <V2ItemInspector
      environmentId={ENVIRONMENT}
      projectedItem={projectedItem}
      onOpenThread={onOpenThread}
      onOpenTurnDiff={onOpenTurnDiff}
      {...props}
    />
  );
}

async function mount(children: ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(children));
  return container;
}

async function rerender(children: ReactNode) {
  await act(async () => root!.render(children));
}

async function click(element: Element | null | undefined) {
  expect(element).toBeTruthy();
  await act(async () => {
    (element as HTMLElement).click();
  });
  // Page reads resolve on later microtasks.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function button(scope: ParentNode, text: string): HTMLButtonElement | undefined {
  return [...scope.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === text,
  );
}

const panel = (scope: ParentNode, label: string) =>
  scope.querySelector(`[data-tool-code-panel="${label}"]`)!;
const panelText = (scope: ParentNode, label: string) =>
  panel(scope, label).querySelector("code")!.textContent;

beforeEach(() => {
  server.theme = "light";
  server.targets = [];
  server.fetches = [];
  clipboard = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: clipboard },
  });
  onOpenTurnDiff.mockReset();
  onOpenThread.mockReset();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// Emoji and two-byte letters land on page boundaries; pages must never split them.
const longOutput = Array.from(
  { length: 30_000 },
  (_, line) => `line ${line} ${line % 3 === 0 ? "🚀" : "é".repeat(line % 5)} ok`,
).join("\n");

describe("command output, one page at a time", () => {
  const command = turnItem({
    type: "command_execution",
    input: "npm test",
    outputOmitted: true,
  });

  it("opens on the last page, loads earlier pages and copies every byte", async () => {
    serve({ wire: command, texts: { output: longOutput } });
    const element = await mount(inspector(command));
    expect(server.targets.at(-1)).toMatchObject({ field: "output", anchor: "end" });
    const last = sliceTextPage(longOutput, { anchor: "end" });
    expect(last.offset).toBeGreaterThan(0);
    expect(panel(element, "output").textContent).toContain(
      `Showing last ${count(last.end - last.offset)} of ${count(longOutput.length)} characters`,
    );
    expect(panelText(element, "output")).toBe(last.text);
    expect(button(element, "Load more")).toBeUndefined();

    await click(button(element, "Load earlier"));
    expect(server.fetches.at(-1)).toMatchObject({ field: "output", before: last.offset });
    const earlier = sliceTextPage(longOutput, { before: last.offset });
    expect(panelText(element, "output")).toBe(`${earlier.text}${last.text}`);

    await click(element.querySelector('[aria-label="Copy full output"]'));
    const copied = clipboard.mock.calls.at(-1)![0] as string;
    expect(copied).not.toContain(TRANSPORT_TRUNCATION_MARKER);
    expect(await sha256(copied)).toBe(await sha256(longOutput));
  });

  it("restarts Copy full when the running item changes part way", async () => {
    let stored = longOutput;
    let revision = "live-1";
    const running = turnItem({
      type: "command_execution",
      status: "running",
      input: "npm test",
      outputOmitted: true,
    });
    server.read = (raw) => {
      const target = raw as TurnItemDetailTarget;
      const page = sliceTextPage(stored, {
        offset: target.offset,
        before: target.before,
        anchor: target.anchor,
      });
      const result = {
        item: running,
        page: { ...page, field: "output" as const, revision, text: page.text },
      };
      // The command prints more right after the first page of the copy is read.
      if (target.offset === 0 && revision === "live-1" && server.fetches.length > 0) {
        stored = `${longOutput}\nmore output`;
        revision = "live-2";
      }
      return result;
    };
    const element = await mount(inspector(running, { streamsToolOutput: true }));
    await click(element.querySelector('[aria-label="Copy full output"]'));
    expect(clipboard.mock.calls.at(-1)![0]).toBe(`${longOutput}\nmore output`);
  });

  it("falls back to the bounded text, without the marker, against an older server", async () => {
    const bounded = sliceTextPage(longOutput).text;
    // An older server ignores the page fields and returns its bounded item to every read.
    server.read = () => ({
      item: { ...command, output: `${bounded}${TRANSPORT_TRUNCATION_MARKER}` },
    });
    const element = await mount(inspector(command));
    expect(panelText(element, "output")).toBe(bounded);
    expect(panel(element, "output").textContent).toContain("Cut for transport");
    await click(element.querySelector('[aria-label="Copy full output"]'));
    expect(clipboard.mock.calls.at(-1)![0]).toBe(bounded);
  });

  it("says when SpecWithCode's ingestion kept only the tail", async () => {
    const acp = turnItem({
      type: "command_execution",
      input: "cat big.log",
      outputOmitted: true,
      outputKeptTailChars: 8_000,
    });
    serve({ wire: acp, texts: { output: "tail of the log\n" } });
    const element = await mount(inspector(acp));
    expect(panel(element, "output").textContent).toContain(
      "SpecWithCode kept only the last 8,000 characters of this output",
    );
  });

  it("shows ANSI output stripped with a Raw toggle, and copies the exact bytes", async () => {
    const colored = "\u001b[31mFAIL\u001b[0m src/a.test.ts\n";
    serve({ wire: command, texts: { output: colored } });
    const element = await mount(inspector(command));
    expect(panelText(element, "output")).toBe("FAIL src/a.test.ts\n");
    await click(element.querySelector('[aria-label="Show raw output"]'));
    expect(panelText(element, "output")).toContain("␛[31mFAIL");
    await click(element.querySelector('[aria-label="Copy output"]'));
    expect(clipboard.mock.calls.at(-1)![0]).toBe(colored);
  });
});

describe("tool output and input, first page first", () => {
  it("opens tool output on its first page with Load more", async () => {
    const tool = turnItem({
      type: "dynamic_tool",
      toolName: "mcp.read_logs",
      input: { name: "server" },
      outputOmitted: true,
    });
    const cut = firstPage(longOutput, "output");
    serve({
      wire: tool,
      texts: { output: longOutput },
      detail: { item: { ...tool, output: cut.text, outputOmitted: false }, truncated: [cut.info] },
    });
    const element = await mount(inspector(tool));
    expect(server.targets.at(-1)).not.toHaveProperty("field");
    expect(panelText(element, "output")).toBe(longOutput.slice(0, cut.info.end));
    expect(panel(element, "output").textContent).toContain(
      `Showing ${count(cut.info.end)} of ${count(longOutput.length)} characters`,
    );
    for (let page = 0; page < 3 && button(element, "Load more"); page += 1) {
      await click(button(element, "Load more"));
    }
    expect(panelText(element, "output")).toBe(longOutput);
    expect(button(element, "Load more")).toBeUndefined();
    expect(panel(element, "output").textContent).not.toContain("Showing");
  });

  it("pages a command longer than one page and copies all of it", async () => {
    const heredoc = `cat > notes.txt <<'EOF'\n${longOutput}\nEOF`;
    const long = turnItem({ type: "command_execution", input: heredoc, outputOmitted: true });
    // A page read bounds the command it returns; the timeline item keeps it whole.
    serve({
      wire: long,
      texts: { output: "done\n" },
      pageItem: {
        ...long,
        input: `${heredoc.slice(0, 1_000)}${TRANSPORT_TRUNCATION_MARKER}`,
      } as OrchestrationV2TurnItem,
    });
    const element = await mount(inspector(long));
    const first = sliceTextPage(heredoc);
    expect(panelText(element, "command")).toBe(first.text);
    expect(panel(element, "command").textContent).toContain(
      `Showing ${count(first.end)} of ${count(heredoc.length)} characters`,
    );
    await click(element.querySelector('[aria-label="Copy full command"]'));
    expect(await sha256(clipboard.mock.calls.at(-1)![0] as string)).toBe(await sha256(heredoc));
    for (let page = 0; page < 3 && button(panel(element, "command"), "Load more"); page += 1) {
      await click(button(panel(element, "command"), "Load more"));
    }
    expect(panelText(element, "command")).toBe(heredoc);
    await click(element.querySelector('[aria-label="Copy command"]'));
    expect(await sha256(clipboard.mock.calls.at(-1)![0] as string)).toBe(await sha256(heredoc));
  });

  it("pages a large structured input and indents it once whole", async () => {
    const input = { files: Array.from({ length: 20_000 }, (_, index) => `src/file-${index}.ts`) };
    const json = JSON.stringify(input);
    const cut = firstPage(json, "input");
    const tool = turnItem({
      type: "dynamic_tool",
      toolName: "mcp.batch",
      input: { summary: "{", truncated: true },
    });
    serve({
      wire: tool,
      texts: { input: json },
      detail: {
        item: { ...tool, input: cut.text },
        truncated: [{ ...cut.info, structured: true }],
      },
    });
    const element = await mount(inspector(tool));
    expect(panelText(element, "input")).toBe(json.slice(0, cut.info.end));
    await click(button(panel(element, "input"), "Load more"));
    expect(panelText(element, "input")).toBe(JSON.stringify(input, null, 2));
    await click(element.querySelector('[aria-label="Copy full input"]'));
    expect(await sha256(clipboard.mock.calls.at(-1)![0] as string)).toBe(await sha256(json));
  });
});

describe("live refresh of an open running row", () => {
  const running = turnItem({
    type: "command_execution",
    status: "running",
    input: "npm run build",
    outputOmitted: true,
  });

  it("refetches every 2 seconds while open, stops when closed and reads once more at the end", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    serve({ wire: running, texts: { output: "building\n" } });
    await mount(inspector(running, { streamsToolOutput: true }));
    const keys: Array<{ readonly at: number; readonly revision: string }> = [];
    const record = () => {
      const target = server.targets.at(-1) as TurnItemDetailTarget;
      if (keys.at(-1)?.revision !== target.revision) {
        keys.push({ at: Date.now(), revision: target.revision });
      }
    };
    record();
    for (let second = 0; second < 7; second += 1) {
      await act(async () => {
        vi.advanceTimersByTime(1_000);
      });
      record();
    }
    expect(keys.map((key) => key.at)).toEqual([0, 2_000, 4_000, 6_000]);
    const gaps = keys.slice(1).map((key, index) => key.at - keys[index]!.at);
    expect(gaps.every((gap) => gap >= LIVE_DETAIL_REFRESH_MS && gap <= 3_000)).toBe(true);

    const finishedAt = DateTime.makeUnsafe("2026-10-24T12:05:00.000Z");
    await rerender(
      inspector(
        { ...running, status: "completed", updatedAt: finishedAt },
        { streamsToolOutput: true },
      ),
    );
    expect((server.targets.at(-1) as TurnItemDetailTarget).revision).toBe(
      DateTime.formatIso(finishedAt),
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops its timer when the row closes", async () => {
    vi.useFakeTimers();
    serve({ wire: running, texts: { output: "building\n" } });
    await mount(inspector(running, { streamsToolOutput: true }));
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    await act(async () => root!.unmount());
    root = undefined;
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps one read for a provider that does not stream, and says when output appears", async () => {
    vi.useFakeTimers();
    serve({ wire: running, texts: { output: "building\n" } });
    await mount(inspector(running, { streamsToolOutput: false }));
    expect(vi.getTimerCount()).toBe(0);
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(
      new Set(server.targets.map((target) => (target as TurnItemDetailTarget).revision)),
    ).toEqual(new Set(["live"]));

    const quiet = turnItem({ type: "command_execution", status: "running", input: "sleep 60" });
    await rerender(inspector(quiet));
    expect(container!.textContent).toContain("Output appears when the command ends");
  });
});

const patchFor = (path: string, before = "a", after = "b") =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${before}\n+${after}\n`;

describe("inline edit patches", () => {
  const files = ["src/one.ts", "src/two.ts", "src/three.ts", "src/four.ts", "src/five.ts"];
  const codexEdit = turnItem({
    type: "file_change",
    fileName: `/repo/${files[0]}`,
    changes: files.map((path) => ({
      operation: "update",
      path: `/repo/${path}`,
      diffStr: patchFor(path),
      additions: 1,
      deletions: 1,
    })),
  });

  it("splits a multi-file edit per file and opens the first three in Verbose", async () => {
    serve({ wire: codexEdit });
    const element = await mount(
      inspector(codexEdit, {
        providerLabel: "Codex",
        defaultOpenFileSections: 3,
        workspaceRoot: "/repo",
      }),
    );
    expect(element.querySelectorAll("[data-edit-file-section]")).toHaveLength(3);
    expect(element.querySelectorAll("[data-file-diff]")).toHaveLength(3);
    expect(element.textContent).toContain("From Codex");
    await click(button(element, "Show all 5 files"));
    expect(element.querySelectorAll("[data-edit-file-section]")).toHaveLength(5);
    expect(element.querySelectorAll("[data-file-diff]")).toHaveLength(3);
    const fourth = element.querySelector('[data-edit-file-section="/repo/src/four.ts"]')!;
    await click(fourth.querySelector("button[aria-expanded]"));
    expect(element.querySelectorAll("[data-file-diff]")).toHaveLength(4);
  });

  it("keeps file sections closed in Normal until one is opened", async () => {
    serve({ wire: codexEdit });
    const element = await mount(inspector(codexEdit, { workspaceRoot: "/repo" }));
    expect(element.querySelectorAll("[data-edit-file-section]")).toHaveLength(5);
    expect(element.querySelectorAll("[data-file-diff]")).toHaveLength(0);
    expect(element.textContent).toContain("src/two.ts");
    const second = element.querySelector('[data-edit-file-section="/repo/src/two.ts"]')!;
    await click(second.querySelector("button[aria-expanded]"));
    expect(element.querySelector("[data-file-diff]")?.getAttribute("data-file-diff")).toBe(
      "src/two.ts",
    );
  });

  it("splits a single combined patch at its files", async () => {
    const combined = turnItem({
      type: "file_change",
      fileName: "/repo/src/one.ts",
      diffOmitted: true,
    });
    serve({
      wire: combined,
      detail: {
        item: { ...combined, diffStr: `${patchFor("src/one.ts")}${patchFor("src/two.ts")}` },
      },
    });
    const element = await mount(inspector(combined, { defaultOpenFileSections: 3 }));
    expect(
      [...element.querySelectorAll("[data-file-diff]")].map((node) =>
        node.getAttribute("data-file-diff"),
      ),
    ).toEqual(["src/one.ts", "src/two.ts"]);
  });

  it("fetches a withheld Claude patch on expand and labels its source", async () => {
    const claude = turnItem({
      type: "file_change",
      fileName: "/repo/src/app.ts",
      additions: 1,
      deletions: 1,
      diffOmitted: true,
      diffNote: "git_patch",
    });
    serve({ wire: claude, detail: { item: { ...claude, diffStr: patchFor("src/app.ts") } } });
    const element = await mount(inspector(claude, { providerLabel: "Claude" }));
    expect(server.targets.at(-1)).toMatchObject({ itemId: "item-1", revision: REVISION });
    expect(server.targets.at(-1)).not.toHaveProperty("field");
    expect(element.querySelector("[data-file-diff]")?.getAttribute("data-file-diff")).toBe(
      "src/app.ts",
    );
    expect(element.textContent).toContain("From Claude");
    expect(element.textContent).toContain(
      "Git diff of the file; may include changes this edit did not make",
    );
  });

  it.each(["light", "dark"] as const)("renders in the %s theme", async (theme) => {
    server.theme = theme;
    serve({ wire: codexEdit });
    const single = turnItem({
      type: "file_change",
      fileName: "/repo/src/app.ts",
      changes: [{ operation: "update", path: "/repo/src/app.ts", diffStr: patchFor("src/app.ts") }],
    });
    const element = await mount(inspector(single));
    expect(element.querySelector("[data-file-diff]")?.getAttribute("data-theme")).toBe(
      `pierre-${theme}`,
    );
    // The code surface's colors reach the renderer's separators and gutters, as in DiffPanel,
    // and "N unmodified lines" takes its text color from that surface too.
    expect(element.querySelector("[data-inline-patch]")?.className).toContain(
      "diff-render-surface",
    );
    expect(element.querySelector("[data-file-diff]")?.getAttribute("data-unsafe-css")).toMatch(
      /\[data-separator-content\] \{\s*color: color-mix\(in srgb, var\(--code-foreground\)/,
    );
  });

  it("renders OpenCode's old and new text through the same renderer", async () => {
    const openCode = turnItem({
      type: "file_change",
      fileName: "/repo/src/app.ts",
      diffOmitted: true,
    });
    serve({
      wire: openCode,
      detail: {
        item: {
          ...openCode,
          oldStr: "const a = 1;\nconst b = 2;\n",
          newStr: "const a = 1;\nconst b = 3;\nconst c = 4;\n",
        },
      },
    });
    const element = await mount(inspector(openCode, { providerLabel: "OpenCode" }));
    const diff = element.querySelector("[data-file-diff]")!;
    expect(diff.getAttribute("data-file-diff")).toBe("/repo/src/app.ts");
    expect(diff.getAttribute("data-additions")).toBe("2");
    expect(diff.getAttribute("data-deletions")).toBe("1");
    expect(element.textContent).toContain("From OpenCode");
  });

  it.each([
    ["input_snippet", "Edit snippet", true],
    ["line_numbers_synthesized", "Line numbers not reported by the provider", true],
    ["too_large_to_compute", "Provider diff too large to compute", false],
    ["overwrite_without_diff", "No diff from the provider for this overwrite", false],
  ] as const)("labels the %s note", async (diffNote, label, hasPatch) => {
    const edit = turnItem({
      type: "file_change",
      fileName: "/repo/src/app.ts",
      diffNote,
      ...(hasPatch ? { diffOmitted: true } : {}),
    });
    serve({ wire: edit, detail: { item: { ...edit, diffStr: patchFor("src/app.ts") } } });
    const element = await mount(inspector(edit));
    expect(element.textContent).toContain(label);
    expect(element.querySelectorAll("[data-file-diff]")).toHaveLength(hasPatch ? 1 : 0);
    expect(button(element, "Open diff")).toBeTruthy();
  });

  it("gives a header-less hunk file headers and says its line numbers were not reported", async () => {
    const legacy = turnItem({
      type: "file_change",
      fileName: "/repo/src/app.ts",
      changes: [{ operation: "update", path: "/repo/src/app.ts", diffStr: "@@\n-old\n+new\n" }],
    });
    serve({ wire: legacy });
    const element = await mount(inspector(legacy));
    expect(element.querySelector("[data-file-diff]")?.getAttribute("data-additions")).toBe("1");
    expect(element.textContent).toContain("Line numbers not reported by the provider");
  });

  it("renders an older Claude item whose patch is the stored structured result", async () => {
    const result = JSON.stringify({
      filePath: "/repo/src/app.ts",
      structuredPatch: [
        { oldStart: 3, oldLines: 1, newStart: 3, newLines: 2, lines: ["-a", "+b", "+c"] },
      ],
    });
    const old = turnItem({ type: "file_change", fileName: "/repo/src/app.ts", diffOmitted: true });
    serve({ wire: old, detail: { item: { ...old, diffStr: result } } });
    const element = await mount(inspector(old));
    const diff = element.querySelector("[data-file-diff]")!;
    expect(diff.getAttribute("data-additions")).toBe("2");
    expect(diff.getAttribute("data-deletions")).toBe("1");
  });

  it("shows stored text that is not a patch as it is, with the reason", async () => {
    const odd = turnItem({ type: "file_change", fileName: "/repo/src/app.ts", diffOmitted: true });
    serve({ wire: odd, detail: { item: { ...odd, diffStr: "The file was updated." } } });
    const element = await mount(inspector(odd));
    expect(element.querySelector("[data-file-diff]")).toBeNull();
    expect(element.textContent).toContain(
      "Not a patch the viewer can read. Showing the stored text.",
    );
    expect(panelText(element, "patch")).toBe("The file was updated.");
  });

  it("shows a failed edit's full error text and never parses it as a patch", async () => {
    const error = `Error: old_string not found\n@@ -1 +1 @@\n-a\n+b\n${"context ".repeat(5_000)}`;
    const failed = turnItem({
      type: "file_change",
      status: "failed",
      fileName: "/repo/src/app.ts",
      diffOmitted: true,
    });
    expect(error.length).toBeGreaterThan(32 * 1024);
    serve({
      wire: failed,
      texts: { body: error },
      detail: { item: { ...failed, diffStr: error } },
    });
    const element = await mount(inspector(failed));
    expect(element.querySelector("[data-file-diff]")).toBeNull();
    expect(panelText(element, "error")).toBe(error);
  });

  it("wraps a long edit path inside the row instead of running past it", async () => {
    const path = `/repo/apps/web/src/components/chat/streaming/indicators/${"Streaming".repeat(8)}.tsx`;
    const edit = turnItem({
      type: "file_change",
      fileName: path,
      diffStr: `--- a${path}\n+++ b${path}\n@@ -1 +1 @@\n-a\n+b\n`,
    });
    serve({ wire: edit });
    const element = await mount(inspector(edit));
    const shown = element.querySelector("[data-edit-path]");
    expect(shown?.textContent).toContain("Streaming".repeat(8));
    expect(shown?.className).toContain("min-w-0");
    expect(shown?.className).toContain("wrap-anywhere");
  });

  it("stops at 5,000 lines with a placeholder that keeps Open diff and Copy full", async () => {
    const lines = Array.from({ length: 5_001 }, (_, index) => `+line ${index}`).join("\n");
    const patch = `--- /dev/null\n+++ b/src/big.ts\n@@ -0,0 +1,5001 @@\n${lines}\n`;
    const big = turnItem({ type: "file_change", fileName: "/repo/src/big.ts", diffOmitted: true });
    serve({ wire: big, detail: { item: { ...big, diffStr: patch } } });
    const element = await mount(inspector(big));
    const placeholder = element.querySelector("[data-inline-patch-placeholder]")!;
    expect(placeholder.textContent).toContain("Too large to show here");
    expect(element.querySelector("[data-file-diff]")).toBeNull();
    await click(button(placeholder, "Open diff"));
    expect(onOpenTurnDiff).toHaveBeenCalledWith(RUN, "/repo/src/big.ts", {
      sourceThreadId: THREAD,
    });
    await click(element.querySelector('[aria-label="Copy full patch"]'));
    expect(clipboard.mock.calls.at(-1)![0]).toBe(patch);
  });

  it("pages a patch over one page and copies all of it", async () => {
    const body = Array.from(
      { length: 4_000 },
      (_, index) => `+${`${index} `.padEnd(90, "x")}`,
    ).join("\n");
    const patch = `--- /dev/null\n+++ b/src/wide.ts\n@@ -0,0 +1,4000 @@\n${body}\n`;
    const cut = firstPage(patch, "body", 0);
    const wide = turnItem({
      type: "file_change",
      fileName: "/repo/src/wide.ts",
      diffOmitted: true,
      changes: [{ operation: "add", path: "/repo/src/wide.ts", diffStr: "bounded" }],
    });
    serve({
      wire: wide,
      texts: { "body:0": patch },
      detail: {
        item: {
          ...wide,
          changes: [{ operation: "add", path: "/repo/src/wide.ts", diffStr: cut.text }],
        },
        truncated: [cut.info],
      },
    });
    const element = await mount(inspector(wide));
    expect(element.textContent).toContain(
      `Showing ${count(cut.info.end)} of ${count(patch.length)} characters`,
    );
    const partial = Number(
      element.querySelector("[data-file-diff]")?.getAttribute("data-additions"),
    );
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(4_000);

    await click(element.querySelector('[aria-label="Copy full patch"]'));
    expect(await sha256(clipboard.mock.calls.at(-1)![0] as string)).toBe(await sha256(patch));

    await click(button(element, "Load more"));
    expect(server.fetches.at(-1)).toMatchObject({
      field: "body",
      changeIndex: 0,
      offset: cut.info.end,
    });
    expect(element.querySelector("[data-file-diff]")?.getAttribute("data-additions")).toBe("4000");
    expect(element.textContent).not.toContain("Showing");
  });

  it("stops a paged patch whose counts pass 5,000 lines before the rest loads", async () => {
    // About 360,000 characters: under 1 MiB, and the first page holds under 5,000 lines.
    const body = Array.from(
      { length: 6_000 },
      (_, index) => `${index % 2 ? "-" : "+"}${`${index} `.padEnd(59, "x")}`,
    ).join("\n");
    const patch = `--- a/pnpm-lock.yaml\n+++ b/pnpm-lock.yaml\n@@ -1,3000 +1,3000 @@\n${body}\n`;
    const cut = firstPage(patch, "body", 0);
    const change = {
      operation: "update",
      path: "/repo/pnpm-lock.yaml",
      additions: 3_000,
      deletions: 3_000,
    };
    const lock = turnItem({
      type: "file_change",
      fileName: "/repo/pnpm-lock.yaml",
      diffOmitted: true,
      changes: [{ ...change, diffStr: "bounded" }],
    });
    expect(patch.length).toBeLessThan(1024 * 1024);
    expect(cut.info.end).toBeLessThan(patch.length);
    expect(cut.text.split("\n").length).toBeLessThan(5_000);
    serve({
      wire: lock,
      texts: { "body:0": patch },
      detail: {
        item: { ...lock, changes: [{ ...change, diffStr: cut.text }] },
        truncated: [cut.info],
      },
    });
    const element = await mount(inspector(lock));
    const placeholder = element.querySelector("[data-inline-patch-placeholder]")!;
    expect(placeholder.textContent).toContain("Too large to show here");
    expect(element.querySelector("[data-file-diff]")).toBeNull();
    expect(button(placeholder, "Open diff")).toBeTruthy();
    // Nothing is drawn, so there is nothing to page through.
    expect(element.textContent).not.toContain("Showing");
    expect(button(element, "Load more")).toBeUndefined();
    await click(element.querySelector('[aria-label="Copy full patch"]'));
    expect(await sha256(clipboard.mock.calls.at(-1)![0] as string)).toBe(await sha256(patch));
  });
});

describe("Open diff from an edit", () => {
  const edit = turnItem({
    type: "file_change",
    fileName: "/repo/src/app.ts",
    changes: [
      { operation: "update", path: "/repo/src/app.ts", diffStr: patchFor("src/app.ts") },
      { operation: "add", path: "/repo/src/new.ts", diffStr: patchFor("src/new.ts") },
    ],
  });

  it("opens the run's diff at the row's file and at each section's file", async () => {
    serve({ wire: edit });
    const element = await mount(inspector(edit));
    const buttons = [...element.querySelectorAll("button")].filter(
      (candidate) => candidate.textContent === "Open diff",
    );
    expect(buttons).toHaveLength(3);
    await click(buttons[0]);
    await click(buttons[2]);
    expect(onOpenTurnDiff.mock.calls).toEqual([
      [RUN, "/repo/src/app.ts", { sourceThreadId: THREAD }],
      [RUN, "/repo/src/new.ts", { sourceThreadId: THREAD }],
    ]);
  });

  it("names the source thread for an inherited row", async () => {
    serve({ wire: edit });
    const element = await mount(inspector(edit, {}, "source-thread" as ThreadId));
    await click(button(element, "Open diff"));
    expect(onOpenTurnDiff).toHaveBeenCalledWith(RUN, "/repo/src/app.ts", {
      sourceThreadId: "source-thread",
    });
  });

  it("routes a subagent's edit to the parent run that launched it", async () => {
    const child = { ...edit, runId: null } as OrchestrationV2TurnItem;
    serve({ wire: child });
    const element = await mount(
      inspector(child, {
        subagentDiffTarget: {
          parentThreadId: "parent" as ThreadId,
          runId: "parent-run" as RunId,
          title: "Explore",
          running: true,
        },
      }),
    );
    await click(button(element, "Open diff"));
    expect(onOpenTurnDiff).toHaveBeenCalledWith("parent-run", "/repo/src/app.ts", {
      sourceThreadId: "parent",
      attributedTo: { title: "Explore", running: true },
    });
  });

  it("opens the parent thread when its launching run is not loaded", async () => {
    const child = { ...edit, runId: null } as OrchestrationV2TurnItem;
    serve({ wire: child });
    const element = await mount(
      inspector(child, {
        subagentDiffTarget: {
          parentThreadId: "parent" as ThreadId,
          runId: null,
          title: "Subagent",
          running: false,
        },
      }),
    );
    expect(button(element, "Open diff")).toBeUndefined();
    await click(button(element, "Open parent thread"));
    expect(onOpenThread).toHaveBeenCalledWith("parent");
  });

  it("is disabled with its reason while the turn runs", async () => {
    serve({ wire: edit });
    const element = await mount(
      inspector(edit, { diffUnavailableReason: "Diff available when the turn ends" }),
    );
    const disabled = button(element, "Diff available when the turn ends")!;
    expect(disabled.disabled).toBe(true);
    expect(button(element, "Open diff")).toBeUndefined();
    await click(disabled);
    expect(onOpenTurnDiff).not.toHaveBeenCalled();
  });
});
