import { EnvironmentId, ThreadId } from "@specweave-studio/contracts";
import { AsyncResult } from "effect/reactivity";
import { act, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  openInEditor: vi.fn(),
  listEntries: vi.fn(),
  existing: new Set<string>(),
  openFile: vi.fn(),
  mint: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("./ui/toast", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./ui/toast")>();
  return { ...actual, toastManager: { ...actual.toastManager, add: state.toast } };
});
vi.mock("../rightPanelStore", () => ({
  useRightPanelStore: { getState: () => ({ openFile: state.openFile }) },
}));
vi.mock("./chat/MarkdownDocumentReader", () => ({
  MARKDOWN_DOCUMENT_PATTERN: /\.(?:md|mdx|markdown)$/i,
  MarkdownDocumentReader: (props: { target: { path: string } }) => (
    <div data-document-reader={props.target.path} />
  ),
}));
// The overlay viewer, reduced to what it was asked to open.
vi.mock("./chat/ThreadArtifacts", () => ({
  MessageFileViewer: (props: {
    target: { filePath: string; line?: number };
    links: ReadonlyArray<{ filePath: string }>;
  }) => (
    <div
      data-file-viewer={props.target.filePath}
      data-line={props.target.line}
      data-links={props.links.map((link) => link.filePath).join(",")}
    />
  ),
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../hooks/useSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/useSettings")>();
  const settings = actual.getClientSettings();
  return {
    ...actual,
    useClientSettings: (select: (value: typeof settings) => unknown) => select(settings),
  };
});
vi.mock("./ui/tooltip", async () => {
  const { cloneElement, isValidElement } = await import("react");
  return {
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
    TooltipTrigger({
      render,
      children,
    }: ComponentProps<typeof import("./ui/tooltip").TooltipTrigger>) {
      if (!isValidElement(render)) return <>{children}</>;
      return children === undefined ? render : cloneElement(render, undefined, children);
    },
    TooltipPopup: () => null,
  };
});
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => state.mint }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => state.openInEditor }));
vi.mock("../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/session")>()),
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => false,
  usePreparedConnection: () => ({ _tag: "Some", value: { httpBaseUrl: "https://host.test" } }),
}));
vi.mock("../state/projects", () => ({
  projectEnvironment: {
    searchEntries: (request: object) => ({ ...request, search: true }),
    listEntries: (request: object) => request,
  },
}));
vi.mock("@specweave-studio/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@specweave-studio/client-runtime/state/runtime")>()),
  executeAtomQuery: async (
    _registry: unknown,
    request: { search?: true; input: { cwd: string; query?: string } },
  ) => {
    const prefix = `${request.input.cwd}/`;
    if (request.search) {
      // The file index: every file under the root whose name is the query.
      return AsyncResult.success({
        truncated: false,
        entries: [...state.existing]
          .filter(
            (path) => path.startsWith(prefix) && path.split("/").at(-1) === request.input.query,
          )
          .map((path) => ({ path: path.slice(prefix.length), kind: "file" })),
      });
    }
    state.listEntries(request.input.cwd);
    return AsyncResult.success({
      truncated: false,
      entries: [...state.existing]
        .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
        .map((path) => ({
          path: path.slice(prefix.length),
          kind: /\.[a-z]+$/.test(path) ? "file" : "directory",
        })),
    });
  },
}));
vi.mock("../state/entities", () => ({
  readEnvironmentSupportsServerBrowser: () => false,
  readThreadShell: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("../editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectForChangeRequest: () => undefined,
  matchesLinkedPullRequestUrl: () => false,
  parseChangeRequestUrl: () => null,
  useOpenChangeRequestLink: () => vi.fn(),
}));

import ChatMarkdown from "./ChatMarkdown";

// The thread's workspace is the main checkout; the worker built in a sibling
// worktree and names it relative to the workspace.
const UMB = "/Users/me/Projects/github/specweave-umb/repositories/anton-abyzov";
const CWD = `${UMB}/specweave`;
const WORKTREE = `${UMB}/specweave-wt-code-captures`;
const SOURCE = "docs-site/static/img/studio/coordinator-capture-source.md";
const REPORT = [
  "**Evidence:**",
  "- Branch `docs/code-page-real-captures`, commit `d18231320`, in `../specweave-wt-code-captures`.",
  `- Provenance: \`${SOURCE}\`.`,
  "- Raw captures: `~/specwithcode-promo/shots/`.",
  "- Hero: `../specweave-wt-code-captures/docs-site/static/img/studio/hero.png`, wired at `../specweave-wt-code-captures/docs-site/src/pages/code.tsx:42`.",
].join("\n");
const threadRef = {
  environmentId: EnvironmentId.make("outside-environment"),
  threadId: ThreadId.make("outside-thread"),
};

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.openInEditor.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.openFile.mockReset();
  state.toast.mockReset();
  state.listEntries.mockReset();
  state.mint
    .mockReset()
    .mockResolvedValue(AsyncResult.success({ relativeUrl: "/api/assets/hero.png", expiresAt: 1 }));
  state.existing = new Set([
    WORKTREE,
    `${WORKTREE}/docs-site`,
    `${WORKTREE}/${SOURCE}`,
    `${WORKTREE}/docs-site/static/img/studio/hero.png`,
    `${WORKTREE}/docs-site/src/pages/code.tsx`,
    "/Users/me/specwithcode-promo/shots",
  ]);
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

async function render(text = REPORT, cwd = CWD) {
  await act(async () => {
    renderer = create(
      <ChatMarkdown cwd={cwd} threadRef={threadRef} text={text} onImageExpand={state.mint} />,
    );
  });
}

function chip(label: string) {
  const link = renderer!.root
    .findAllByType("a")
    .find((node) => node.findAll((child) => child.children.includes(label)).length > 0);
  expect(link, label).toBeDefined();
  return link!;
}

function viewer() {
  const [node] = renderer!.root.findAll(
    (child) => child.type === "div" && child.props["data-file-viewer"] !== undefined,
  );
  expect(node, "viewer").toBeDefined();
  return node!;
}

async function click(label: string) {
  await act(async () => {
    chip(label).props.onClick({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
  });
}

it("resolves a sibling worktree folder without a `..` that reads as inside the workspace", async () => {
  await render();
  expect(chip("specweave-wt-code-captures").props.href).toBe(WORKTREE);
  await click("specweave-wt-code-captures");
  expect(state.openInEditor).toHaveBeenCalledWith({
    environmentId: threadRef.environmentId,
    input: { cwd: WORKTREE, editor: "file-manager" },
  });
  expect(state.openFile).not.toHaveBeenCalled();
});

it("opens a folder outside the workspace in the file manager", async () => {
  await render();
  await click("shots");
  expect(state.openInEditor).toHaveBeenCalledWith({
    environmentId: threadRef.environmentId,
    input: { cwd: "/Users/me/specwithcode-promo/shots", editor: "file-manager" },
  });
});

it("opens the provenance markdown from the worktree it names, in the docked reader", async () => {
  await render();
  expect(chip("coordinator-capture-source.md").props.href).toBe(`${WORKTREE}/${SOURCE}`);
  await click("coordinator-capture-source.md");
  expect(
    renderer!.root.findAll(
      (node) => node.props["data-document-reader"] === `${WORKTREE}/${SOURCE}`,
    ),
  ).toHaveLength(1);
  expect(state.openFile).not.toHaveBeenCalled();
});

it("opens an image and a file:line outside the workspace by their host paths", async () => {
  await render();
  await click("hero.png");
  expect(viewer().props["data-file-viewer"]).toBe(
    `${WORKTREE}/docs-site/static/img/studio/hero.png`,
  );
  await click("code.tsx · L42");
  expect(viewer().props["data-file-viewer"]).toBe(`${WORKTREE}/docs-site/src/pages/code.tsx`);
  expect(viewer().props["data-line"]).toBe(42);
  expect(state.openFile).not.toHaveBeenCalled();
});

// The "Machine name in thread list" report: the thread's workspace is the
// Studio checkout, the worker built in its own worktree and saved screenshots
// in a temp folder, and one file is named by its bare name.
const STUDIO = "/Users/me/Projects/github/specweave-umb/repositories/anton-abyzov/specwithcode";
const LABEL_WORKTREE = "/Users/me/Projects/github/studio-machine-label";
const CONVERSATION = `${LABEL_WORKTREE}/apps/web/src/components/studio/CoordinatorConversation.tsx`;
const CHECK = `${LABEL_WORKTREE}/apps/web/tests/project-workspace/machine-label-check.mjs`;
const MACHINE_LABEL_REPORT = [
  "**Evidence:**",
  "- Branch `feat/machine-label` in `~/Projects/github/studio-machine-label`, commit `2ed18fd43`, not pushed.",
  "- The web typecheck passes. 8,199 of 8,200 web unit tests passed. The one failure, `coordinatorRecovery.test.ts`, is in code I didn't touch and passed twice when run alone, so it looks flaky.",
  "- I added a headless browser check, `apps/web/tests/project-workspace/machine-label-check.mjs`, and it passes. Screenshots: `/tmp/studio-machine-label/machine-label-1440-light.png`, `machine-label-1440-dark.png` and `machine-label-1100-light.png` in the same folder.",
  "",
  "**Blockers:** none. `pnpm run lint` fails on two existing errors at `CoordinatorConversation.tsx:615` that I didn't add.",
].join("\n");

function useMachineLabelHost() {
  state.existing = new Set([
    LABEL_WORKTREE,
    `${LABEL_WORKTREE}/apps`,
    CHECK,
    CONVERSATION,
    "/tmp/studio-machine-label",
    "/tmp/studio-machine-label/machine-label-1440-light.png",
    "/tmp/studio-machine-label/machine-label-1440-dark.png",
    "/tmp/studio-machine-label/machine-label-1100-light.png",
  ]);
}

it("opens the worktree folder the machine-label report names in the file manager", async () => {
  useMachineLabelHost();
  await render(MACHINE_LABEL_REPORT, STUDIO);
  await click("studio-machine-label");
  expect(state.openInEditor).toHaveBeenCalledWith({
    environmentId: threadRef.environmentId,
    input: { cwd: LABEL_WORKTREE, editor: "file-manager" },
  });
});

it("resolves a worktree-relative script in the worktree, not the workspace", async () => {
  useMachineLabelHost();
  await render(MACHINE_LABEL_REPORT, STUDIO);
  expect(chip("machine-label-check.mjs").props.href).toBe(CHECK);
  await click("machine-label-check.mjs");
  expect(viewer().props["data-file-viewer"]).toBe(CHECK);
});

it("finds a bare screenshot name in the folder of the screenshot named before it", async () => {
  useMachineLabelHost();
  await render(MACHINE_LABEL_REPORT, STUDIO);
  expect(chip("machine-label-1440-dark.png").props.href).toBe(
    "/tmp/studio-machine-label/machine-label-1440-dark.png",
  );
  await click("machine-label-1440-dark.png");
  expect(viewer().props["data-file-viewer"]).toBe(
    "/tmp/studio-machine-label/machine-label-1440-dark.png",
  );
  // The message's other files are a step away in the viewer.
  expect(viewer().props["data-links"]).toContain(
    "/tmp/studio-machine-label/machine-label-1440-light.png",
  );
});

it("finds a bare file:line by name in the worktree and opens it at that line", async () => {
  useMachineLabelHost();
  await render(MACHINE_LABEL_REPORT, STUDIO);
  expect(chip("CoordinatorConversation.tsx · L615").props.href).toBe(`${CONVERSATION}:615`);
  await click("CoordinatorConversation.tsx · L615");
  expect(viewer().props["data-file-viewer"]).toBe(CONVERSATION);
  expect(viewer().props["data-line"]).toBe(615);
});

it("lists where it looked when the named file is gone, instead of a dead end", async () => {
  useMachineLabelHost();
  state.existing.delete(CONVERSATION);
  await render(MACHINE_LABEL_REPORT, STUDIO);
  await click("CoordinatorConversation.tsx · L615");
  expect(state.openFile).not.toHaveBeenCalled();
  expect(state.toast).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "CoordinatorConversation.tsx was not found",
      description: expect.stringContaining(`${LABEL_WORKTREE}/CoordinatorConversation.tsx`),
    }),
  );
});

// The "Finish every authorized project thread" report of October 20, 2026:
// shell brace shorthand for four findings files outside the workspace.
const AUDIT = "/Users/me/.specwithcode/audits/2026-10-20";
const BRACE_REPORT =
  "Findings so far are in `~/.specwithcode/audits/2026-10-20/findings-{B,C,D,E}.md`.";

function useAuditHost(files = ["A", "B", "C", "D", "E"].map((batch) => `findings-${batch}.md`)) {
  state.existing = new Set([AUDIT, ...files.map((name) => `${AUDIT}/${name}`)]);
}

function chipLabels() {
  return renderer!.root
    .findAllByType("a")
    .map((node) => node.findAll((child) => typeof child.children[0] === "string"))
    .flatMap((nodes) => nodes.flatMap((node) => node.children))
    .filter((label): label is string => typeof label === "string" && label.endsWith(".md"));
}

it("shows one chip per file brace shorthand names, never the shorthand itself", async () => {
  useAuditHost();
  await render(BRACE_REPORT);
  expect(new Set(chipLabels())).toEqual(
    new Set(["findings-B.md", "findings-C.md", "findings-D.md", "findings-E.md"]),
  );
  expect(chip("findings-C.md").props.href).toBe(`${AUDIT}/findings-C.md`);
  await click("findings-C.md");
  expect(
    renderer!.root.findAll(
      (node) => node.props["data-document-reader"] === `${AUDIT}/findings-C.md`,
    ),
  ).toHaveLength(1);
  // Copying the message keeps what the worker wrote.
  const [group] = renderer!.root.findAll((node) => node.props["data-file-link-group"] === "true");
  expect(group!.props["data-markdown-copy"]).toBe(
    "`~/.specwithcode/audits/2026-10-20/findings-{B,C,D,E}.md`",
  );
});

it("opens a file whose name really has braces as that one file", async () => {
  useAuditHost(["findings-{B,C,D,E}.md"]);
  await render(BRACE_REPORT);
  expect(chipLabels()).toEqual(["findings-{B,C,D,E}.md"]);
  expect(chip("findings-{B,C,D,E}.md").props.href).toBe(`${AUDIT}/findings-{B,C,D,E}.md`);
});

it("marks a file the shorthand names but the host lacks as not found", async () => {
  useAuditHost(["findings-B.md", "findings-C.md", "findings-E.md"]);
  await render(BRACE_REPORT);
  await click("findings-D.md");
  expect(state.toast).toHaveBeenCalledWith(
    expect.objectContaining({
      title: "findings-D.md was not found",
      description: expect.stringContaining(`${AUDIT}/findings-D.md`),
    }),
  );
  await click("findings-E.md");
  expect(
    renderer!.root.findAll(
      (node) => node.props["data-document-reader"] === `${AUDIT}/findings-E.md`,
    ),
  ).toHaveLength(1);
});

it("links the files a name pattern matches on the host, not the pattern", async () => {
  useAuditHost(["findings-A.md", "findings-B.md", "INVENTORY.md"]);
  await render("Per batch: `~/.specwithcode/audits/2026-10-20/findings-*.md`.");
  expect(chipLabels()).toEqual(["findings-A.md", "findings-B.md"]);
});

function codeTexts() {
  return renderer!.root
    .findAllByType("code")
    .map((node) => node.children.filter((child) => typeof child === "string").join(""));
}

it("keeps a name pattern as written when nothing, or too much, matches", async () => {
  useAuditHost(["INVENTORY.md"]);
  await render("None: `~/.specwithcode/audits/2026-10-20/findings-*.md`.");
  expect(chipLabels()).toEqual([]);
  expect(codeTexts()).toEqual(["~/.specwithcode/audits/2026-10-20/findings-*.md"]);

  useAuditHost(Array.from({ length: 40 }, (_, index) => `log-${index}.md`));
  await render("Logs: `~/.specwithcode/audits/2026-10-20/log-*.md`.");
  expect(chipLabels()).toEqual([]);
  expect(codeTexts()).toEqual(["~/.specwithcode/audits/2026-10-20/log-*.md"]);
});

it("keeps brace shorthand of patterns as written, never a chip per pattern", async () => {
  useAuditHost();
  await render("Shots: `~/.specwithcode/audits/2026-10-20/findings-{A,B}-*.md`.");
  expect(chipLabels()).toEqual([]);
  expect(codeTexts()).toEqual(["~/.specwithcode/audits/2026-10-20/findings-{A,B}-*.md"]);
});

it("never drops shorthand for folders the host cannot list", async () => {
  useAuditHost();
  await render("Caches: `~/.specwithcode/audits/2026-10-20/{logs,cache}`.");
  const [group] = renderer!.root.findAll((node) => node.props["data-file-link-group"] === "true");
  expect(group?.findAllByType("a").map((link) => link.props.href)).toEqual([
    `${AUDIT}/logs`,
    `${AUDIT}/cache`,
  ]);
});
