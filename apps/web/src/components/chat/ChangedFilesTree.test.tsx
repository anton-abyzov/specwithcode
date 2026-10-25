// @vitest-environment jsdom
import { type ChangedFilesAttribution } from "@specweave-studio/client-runtime/work-log/presentation";
import { RunId, ThreadId } from "@specweave-studio/contracts";
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  ChangedFilesCard,
  ChangedFilesTree,
  NOT_REPORTED_BY_EDIT_TOOL_LABEL,
} from "./ChangedFilesTree";

describe("ChangedFilesCard", () => {
  it("keeps its compact header sticky while preserving singular labels", () => {
    const markup = renderToStaticMarkup(
      <ChangedFilesCard
        runId={RunId.make("run-1")}
        files={[{ path: "README.md", kind: "modified", additions: 2, deletions: 1 }]}
        allDirectoriesExpanded
        resolvedTheme="light"
        onToggleAllDirectories={() => {}}
        onOpenTurnDiff={() => {}}
      />,
    );

    expect(markup).toContain('data-changed-files-state="tree"');
    expect(markup).toContain('aria-label="Open diff"');
    expect(markup).toContain('role="group" aria-label="2 additions, 1 deletions"');
    expect(markup).toContain("1 changed file");
    expect(markup).not.toContain("1 changed files");
  });

  it("shows one summary line without the tree under concise timeline detail", () => {
    const markup = renderToStaticMarkup(
      <ChangedFilesCard
        runId={RunId.make("run-1")}
        files={[
          { path: "extension/manifest.json", kind: "modified", additions: 4, deletions: 1 },
          { path: "docs-site/privacy.md", kind: "modified", additions: 30, deletions: 0 },
        ]}
        allDirectoriesExpanded
        resolvedTheme="light"
        onToggleAllDirectories={() => {}}
        onOpenTurnDiff={() => {}}
        summaryOnly
      />,
    );

    expect(markup).toContain('data-changed-files-state="summary"');
    expect(markup).toContain("2 changed files");
    expect(markup).toContain('aria-label="Open diff"');
    expect(markup).not.toContain("manifest.json");
    expect(markup).not.toContain("docs-site");
    expect(markup).not.toContain("Collapse all folders");
  });

  it("shows collapsed folders and root files together", () => {
    const markup = renderToStaticMarkup(
      <ChangedFilesCard
        runId={RunId.make("run-1")}
        files={[
          { path: "apps/web/src/App.tsx", kind: "modified", additions: 120, deletions: 20 },
          { path: "apps/web/src/App.test.tsx", kind: "modified", additions: 30, deletions: 2 },
          {
            path: "packages/shared/src/git.ts",
            kind: "modified",
            additions: 15,
            deletions: 4,
          },
          { path: "README.md", kind: "modified", additions: 3, deletions: 0 },
        ]}
        allDirectoriesExpanded={false}
        resolvedTheme="light"
        onToggleAllDirectories={() => {}}
        onOpenTurnDiff={() => {}}
      />,
    );

    expect(markup).toContain('data-changed-files-state="tree"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("apps/web/src");
    expect(markup).not.toContain("App.tsx");
    expect(markup).toContain("packages/shared/src");
    expect(markup).not.toContain("git.ts");
    expect(markup).toContain("README.md");
    expect(markup).not.toContain("Show all");
    expect(markup).not.toContain("App.test.tsx");
  });

  it("keeps the folder tree visible when folders are collapsed", () => {
    const markup = renderToStaticMarkup(
      <ChangedFilesCard
        runId={RunId.make("run-1")}
        files={[{ path: "apps/web/src/App.tsx", kind: "modified", additions: 120, deletions: 20 }]}
        allDirectoriesExpanded={false}
        resolvedTheme="light"
        onToggleAllDirectories={() => {}}
        onOpenTurnDiff={() => {}}
      />,
    );

    expect(markup).toContain('data-changed-files-state="tree"');
    expect(markup).toContain("1 changed file");
    expect(markup).toContain("apps/web/src");
    expect(markup).not.toContain("Show all");
    expect(markup).not.toContain("App.tsx");
  });
});

describe("ChangedFilesTree", () => {
  it.each([
    {
      name: "a compacted single-chain directory",
      files: [
        { path: "apps/web/src/index.ts", kind: "modified", additions: 2, deletions: 1 },
        { path: "apps/web/src/main.ts", kind: "modified", additions: 3, deletions: 0 },
      ],
      visibleLabels: ["apps/web/src"],
      hiddenLabels: ["index.ts", "main.ts"],
    },
    {
      name: "a branch point after a compacted prefix",
      files: [
        {
          path: "apps/server/src/git/Layers/GitCore.ts",
          kind: "modified",
          additions: 4,
          deletions: 3,
        },
        {
          path: "apps/server/src/provider/Layers/CodexAdapter.ts",
          kind: "modified",
          additions: 7,
          deletions: 2,
        },
      ],
      visibleLabels: ["apps/server/src"],
      hiddenLabels: ["git", "provider", "GitCore.ts", "CodexAdapter.ts"],
    },
    {
      name: "mixed root files and nested compacted directories",
      files: [
        { path: "README.md", kind: "modified", additions: 1, deletions: 0 },
        { path: "packages/shared/src/git.ts", kind: "modified", additions: 8, deletions: 2 },
        {
          path: "packages/contracts/src/orchestration.ts",
          kind: "modified",
          additions: 13,
          deletions: 3,
        },
      ],
      visibleLabels: ["README.md", "packages"],
      hiddenLabels: ["shared/src", "contracts/src", "git.ts", "orchestration.ts"],
    },
  ])(
    "renders $name collapsed on the first render when collapse-all is active",
    ({ files, visibleLabels, hiddenLabels }) => {
      const markup = renderToStaticMarkup(
        <ChangedFilesTree
          runId={RunId.make("turn-1")}
          files={files}
          allDirectoriesExpanded={false}
          resolvedTheme="light"
          onOpenTurnDiff={() => {}}
        />,
      );

      for (const label of visibleLabels) {
        expect(markup).toContain(label);
      }
      for (const label of hiddenLabels) {
        expect(markup).not.toContain(label);
      }
    },
  );

  it.each([
    {
      name: "a compacted single-chain directory",
      files: [
        { path: "apps/web/src/index.ts", kind: "modified", additions: 2, deletions: 1 },
        { path: "apps/web/src/main.ts", kind: "modified", additions: 3, deletions: 0 },
      ],
      visibleLabels: ["apps/web/src", "index.ts", "main.ts"],
    },
    {
      name: "a branch point after a compacted prefix",
      files: [
        {
          path: "apps/server/src/git/Layers/GitCore.ts",
          kind: "modified",
          additions: 4,
          deletions: 3,
        },
        {
          path: "apps/server/src/provider/Layers/CodexAdapter.ts",
          kind: "modified",
          additions: 7,
          deletions: 2,
        },
      ],
      visibleLabels: [
        "apps/server/src",
        "git/Layers",
        "provider/Layers",
        "GitCore.ts",
        "CodexAdapter.ts",
      ],
    },
    {
      name: "mixed root files and nested compacted directories",
      files: [
        { path: "README.md", kind: "modified", additions: 1, deletions: 0 },
        { path: "packages/shared/src/git.ts", kind: "modified", additions: 8, deletions: 2 },
        {
          path: "packages/contracts/src/orchestration.ts",
          kind: "modified",
          additions: 13,
          deletions: 3,
        },
      ],
      visibleLabels: [
        "README.md",
        "packages",
        "shared/src",
        "contracts/src",
        "git.ts",
        "orchestration.ts",
      ],
    },
  ])(
    "renders $name expanded on the first render when expand-all is active",
    ({ files, visibleLabels }) => {
      const markup = renderToStaticMarkup(
        <ChangedFilesTree
          runId={RunId.make("turn-1")}
          files={files}
          allDirectoriesExpanded
          resolvedTheme="light"
          onOpenTurnDiff={() => {}}
        />,
      );

      for (const label of visibleLabels) {
        expect(markup).toContain(label);
      }
    },
  );
});

describe("ChangedFilesCard attribution", () => {
  const runId = RunId.make("run-7");
  const threadId = ThreadId.make("thread-parent");
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function renderCard(props: Partial<ComponentProps<typeof ChangedFilesCard>>) {
    const onOpenTurnDiff = vi.fn();
    await act(async () =>
      root.render(
        <ChangedFilesCard
          runId={runId}
          files={[]}
          allDirectoriesExpanded={false}
          resolvedTheme="dark"
          onToggleAllDirectories={() => {}}
          onOpenTurnDiff={onOpenTurnDiff}
          {...props}
        />,
      ),
    );
    return onOpenTurnDiff;
  }

  function sectionLabelled(text: string): HTMLElement | null {
    return (
      Array.from(container.querySelectorAll<HTMLElement>("section")).find((section) => {
        const ids = section.getAttribute("aria-labelledby")?.split(" ") ?? [];
        return ids.some((id) => document.getElementById(id)?.textContent === text);
      }) ?? null
    );
  }

  function buttonNamed(scope: ParentNode, text: string): HTMLButtonElement {
    const button = Array.from(scope.querySelectorAll("button")).find(
      (candidate) => candidate.textContent?.trim().startsWith(text) ?? false,
    );
    if (!button) throw new Error(`No button "${text}"`);
    return button;
  }

  async function click(element: HTMLElement) {
    await act(async () => element.click());
  }

  const attribution = (value: Partial<ChangedFilesAttribution>): ChangedFilesAttribution => ({
    notReported: [],
    bySubagent: [],
    unloadedSubagentTitles: [],
    ...value,
  });

  it("lists a file a concurrent writer changed during a read-only turn under the not-reported label", async () => {
    const onOpenTurnDiff = await renderCard({
      files: [{ path: "config/app.json", kind: "modified", additions: 1, deletions: 1 }],
      attribution: attribution({ notReported: ["config/app.json"] }),
      sourceThreadId: threadId,
    });

    const section = sectionLabelled(NOT_REPORTED_BY_EDIT_TOOL_LABEL);
    expect(section).not.toBeNull();
    expect(container.textContent).toContain(
      "Changed in this folder during the turn, not reported by an edit tool (commands, other tools or other agents in this checkout)",
    );
    expect(container.textContent).not.toContain("Edited by");
    // The folder is the only top-level entry, and it sits inside the section.
    const folders = container.querySelectorAll("button[aria-expanded]");
    expect(folders).toHaveLength(1);
    expect(section!.contains(folders[0]!)).toBe(true);
    // A long folder name truncates in a narrow card; its tooltip has the folder's path.
    expect(folders[0]!.querySelector("span[title]")?.getAttribute("title")).toBe("config");

    await click(buttonNamed(section!, "config"));
    await click(buttonNamed(section!, "app.json"));

    expect(onOpenTurnDiff.mock.calls).toEqual([
      [runId, "config/app.json", { sourceThreadId: threadId }],
    ]);
  });

  it("keeps the turn's own edits, a subagent's edits and shell edits apart, each opening its own file", async () => {
    const onOpenTurnDiff = await renderCard({
      files: [
        { path: "src/own.ts", kind: "modified", additions: 3, deletions: 1 },
        { path: "src/child.ts", kind: "added", additions: 12, deletions: 0 },
        { path: "package-lock.json", kind: "modified", additions: 40, deletions: 38 },
      ],
      allDirectoriesExpanded: true,
      attribution: attribution({
        notReported: ["package-lock.json"],
        bySubagent: [{ title: "Reviewer", files: ["src/child.ts"] }],
      }),
      sourceThreadId: threadId,
    });

    const subagent = sectionLabelled("Edited by subagent Reviewer");
    const notReported = sectionLabelled(NOT_REPORTED_BY_EDIT_TOOL_LABEL);
    expect(subagent?.textContent).toContain("child.ts");
    expect(subagent?.textContent).not.toContain("own.ts");
    expect(subagent?.textContent).not.toContain("package-lock.json");
    expect(notReported?.textContent).toContain("package-lock.json");
    expect(notReported?.textContent).not.toContain("child.ts");
    expect(container.textContent?.match(/child\.ts/g)).toHaveLength(1);
    expect(container.textContent).toContain("3 changed files");

    const ownRow = buttonNamed(container, "own.ts");
    expect(subagent!.contains(ownRow) || notReported!.contains(ownRow)).toBe(false);
    await click(ownRow);
    await click(buttonNamed(subagent!, "child.ts"));
    await click(buttonNamed(notReported!, "package-lock.json"));

    expect(onOpenTurnDiff.mock.calls).toEqual([
      [runId, "src/own.ts", { sourceThreadId: threadId }],
      [runId, "src/child.ts", { sourceThreadId: threadId, attributedTo: { title: "Reviewer" } }],
      [runId, "package-lock.json", { sourceThreadId: threadId }],
    ]);
  });

  it("names the run's unloaded subagents on the not-reported label", async () => {
    await renderCard({
      files: [{ path: "notes.md", kind: "modified", additions: 2, deletions: 0 }],
      attribution: attribution({
        notReported: ["notes.md"],
        unloadedSubagentTitles: ["Explorer", "Planner"],
      }),
    });

    const section = sectionLabelled(NOT_REPORTED_BY_EDIT_TOOL_LABEL);
    expect(section?.textContent).toContain(
      "May include edits by subagents Explorer and Planner, whose activity is not loaded here.",
    );
    expect(section?.textContent).toContain("notes.md");
  });

  it("names a single unloaded subagent", async () => {
    await renderCard({
      files: [{ path: "notes.md", kind: "modified", additions: 2, deletions: 0 }],
      attribution: attribution({ notReported: ["notes.md"], unloadedSubagentTitles: ["Explorer"] }),
    });

    expect(sectionLabelled(NOT_REPORTED_BY_EDIT_TOOL_LABEL)?.textContent).toContain(
      "May include edits by subagent Explorer, whose activity is not loaded here.",
    );
  });

  it("opens the turn diff from the header with the source thread", async () => {
    const onOpenTurnDiff = await renderCard({
      files: [{ path: "README.md", kind: "modified", additions: 1, deletions: 0 }],
      sourceThreadId: threadId,
    });

    await click(container.querySelector<HTMLButtonElement>('button[aria-label="Open diff"]')!);

    expect(onOpenTurnDiff.mock.calls).toEqual([[runId, "README.md", { sourceThreadId: threadId }]]);
  });

  it("keeps two-argument links and one tree when there is no attribution", async () => {
    const onOpenTurnDiff = await renderCard({
      files: [{ path: "README.md", kind: "modified", additions: 1, deletions: 0 }],
    });

    expect(container.querySelector("section")).toBeNull();
    await click(buttonNamed(container, "README.md"));

    expect(onOpenTurnDiff.mock.calls).toEqual([[runId, "README.md"]]);
  });

  it("shows no card when the checkpoint lists no files", async () => {
    await renderCard({ files: [], attribution: attribution({}) });

    expect(container.innerHTML).toBe("");
  });

  it("keeps Concise to one line with failures, files not from edit tools and subagent files", async () => {
    const onOpenTurnDiff = await renderCard({
      files: [
        { path: "src/own.ts", kind: "modified", additions: 3, deletions: 1 },
        { path: "src/child.ts", kind: "added", additions: 12, deletions: 0 },
        { path: "package-lock.json", kind: "modified", additions: 40, deletions: 38 },
        { path: "dist/out.js", kind: "modified", additions: 5, deletions: 5 },
      ],
      summaryOnly: true,
      failedCount: 2,
      attribution: attribution({
        notReported: ["package-lock.json", "dist/out.js"],
        bySubagent: [{ title: "Reviewer", files: ["src/child.ts"] }],
      }),
      sourceThreadId: threadId,
    });

    const header = container.querySelector<HTMLElement>("[data-changed-files-header]")!;
    expect(container.querySelector('[data-changed-files-state="summary"]')).not.toBeNull();
    expect(header.textContent).toContain("4 changed files");
    expect(header.textContent).toContain("2 failed");
    expect(header.textContent).toContain("+2 not from edit tools");
    expect(header.textContent).toContain("1 by subagent Reviewer");
    expect(container.querySelector("section")).toBeNull();
    expect(container.textContent).not.toContain("own.ts");
    expect(header.firstElementChild?.className).toContain("flex-nowrap");
    // A narrow card cuts these labels; each tooltip starts with the text it cuts.
    const titles = Array.from(header.querySelectorAll<HTMLElement>("span[title]")).map(
      (span) => span.title,
    );
    expect(titles).toContain(`+2 not from edit tools\n${NOT_REPORTED_BY_EDIT_TOOL_LABEL}`);
    expect(titles).toContain("1 by subagent Reviewer");

    await click(header.querySelector<HTMLButtonElement>('button[aria-label="Open diff"]')!);
    expect(onOpenTurnDiff.mock.calls).toEqual([
      [runId, "src/own.ts", { sourceThreadId: threadId }],
    ]);
  });

  it("adds nothing to the Concise line when every file came from the turn's edits and nothing failed", async () => {
    await renderCard({
      files: [{ path: "src/own.ts", kind: "modified", additions: 3, deletions: 1 }],
      summaryOnly: true,
      failedCount: 0,
      attribution: attribution({}),
    });

    const header = container.querySelector<HTMLElement>("[data-changed-files-header]")!;
    expect(header.textContent).toContain("1 changed file");
    expect(header.textContent).not.toContain("failed");
    expect(header.textContent).not.toContain("not from edit tools");
    expect(header.textContent).not.toContain("subagent");
  });
});
