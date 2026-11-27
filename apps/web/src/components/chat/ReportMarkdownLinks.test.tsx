// @vitest-environment jsdom

import { EnvironmentId, ThreadId } from "@specweave-studio/contracts";
import { AsyncResult } from "effect/reactivity";
import { act, type ComponentProps, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  files: new Map<string, string>(),
  openFile: vi.fn(),
  toast: vi.fn(),
}));

/** The host's files by absolute path; a relative read is relative to `cwd`. */
function hostRead(cwd: string, path: string | null) {
  if (path === null) return undefined;
  const absolute = path.startsWith("/") ? path : `${cwd.replace(/\/+$/, "")}/${path}`;
  return state.files.get(absolute);
}

vi.mock("../files/projectFilesQueryState", () => ({
  useProjectFileQuery: (_environmentId: string, cwd: string, path: string | null) => {
    const contents = hostRead(cwd, path);
    return {
      data: contents === undefined ? null : { contents, truncated: false },
      error: path !== null && contents === undefined ? `File not found: ${path}` : null,
      readError: null,
      isNotFile: false,
      isPending: false,
      refresh: () => undefined,
    };
  },
}));
// The cards and viewers are the app's own; only the overlay's thread strip is left out.
vi.mock("./ThreadArtifacts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./ThreadArtifacts")>()),
  ThreadArtifactStrip: () => null,
  useThreadViewables: () => [],
}));
vi.mock("~/assets/assetUrls", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/assets/assetUrls")>()),
  useAssetUrlState: () => ({ _tag: "Loading" }),
}));
vi.mock("../../state/environments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/environments")>()),
  useEnvironment: () => null,
  useUnreachableEnvironmentIds: () => new Set(),
}));
vi.mock("../ui/toast", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../ui/toast")>();
  return { ...actual, toastManager: { ...actual.toastManager, add: state.toast } };
});
vi.mock("../../rightPanelStore", () => ({
  useRightPanelStore: { getState: () => ({ openFile: state.openFile }) },
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../../hooks/useSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useSettings")>();
  const settings = actual.getClientSettings();
  return {
    ...actual,
    useClientSettings: (select: (value: typeof settings) => unknown) => select(settings),
  };
});
vi.mock("../ui/tooltip", async () => {
  const { cloneElement, isValidElement } = await import("react");
  return {
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
    TooltipTrigger({
      render,
      children,
    }: ComponentProps<typeof import("../ui/tooltip").TooltipTrigger>) {
      if (!isValidElement(render)) return <>{children}</>;
      return children === undefined ? render : cloneElement(render, undefined, children);
    },
    TooltipPopup: () => null,
  };
});
vi.mock("../../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => false,
  usePreparedConnection: () => ({ _tag: "Some", value: { httpBaseUrl: "https://host.test" } }),
}));
vi.mock("../../state/projects", () => ({
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
    const prefix = `${request.input.cwd.replace(/\/+$/, "")}/`;
    const paths = [...state.files.keys()];
    if (request.search) {
      return AsyncResult.success({
        truncated: false,
        entries: paths
          .filter((path) => path.startsWith(prefix) && path.endsWith(`/${request.input.query}`))
          .map((path) => ({ path: path.slice(prefix.length), kind: "file" })),
      });
    }
    const names = new Map<string, "file" | "directory">();
    for (const path of paths) {
      if (!path.startsWith(prefix)) continue;
      const [first, ...rest] = path.slice(prefix.length).split("/");
      names.set(first!, rest.length > 0 ? "directory" : "file");
    }
    return AsyncResult.success({
      truncated: false,
      entries: [...names].map(([path, kind]) => ({ path, kind })),
    });
  },
}));
vi.mock("../../state/entities", () => ({
  readEnvironmentSupportsServerBrowser: () => false,
  readThreadShell: () => null,
  useThreadShell: () => null,
  useThreadProjection: () => null,
  useProject: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("../../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("../../editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectForChangeRequest: () => undefined,
  findProjectOnChangeRequestHost: () => undefined,
  matchesLinkedPullRequestUrl: () => false,
  parseChangeRequestUrl: () => null,
  resolvePullRequestPreviewTarget: () => null,
  useOpenChangeRequestLink: () => vi.fn(),
}));

import { useViewerOverlayStore } from "~/viewerOverlayStore";
import ChatMarkdown from "../ChatMarkdown";
import { ViewerOverlayHost } from "../ViewerOverlayHost";
import { ReportArtifactCard } from "./ReportArtifact";
import { ArtifactCards } from "./ThreadArtifacts";
import { clearSettledFileLinkCache } from "./useExistingFileLinks";

// A thread whose workspace is the repository; its increment keeps a report
// beside the spec, and the report links the spec and a sibling note.
const CWD = "/Users/me/Projects/app";
const INCREMENT = `${CWD}/.specweave/increments/0042-links`;
const REPORT = `${INCREMENT}/reports/review.md`;
const NOTE = `${INCREMENT}/reports/notes.md`;
const SPEC = `${INCREMENT}/spec.md`;
const OUTSIDE = "/Users/me/.specwithcode/audits/findings.md";
const threadRef = {
  environmentId: EnvironmentId.make("report-links-host"),
  threadId: ThreadId.make("report-links-thread"),
};

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  clearSettledFileLinkCache();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.openFile.mockReset();
  state.toast.mockReset();
  state.files = new Map([
    [
      REPORT,
      [
        "# Review of 0042",
        "",
        "The plan is in [the spec](../spec.md), the notes in [notes](notes.md),",
        `and the audit in [findings](${OUTSIDE}).`,
      ].join("\n"),
    ],
    [NOTE, "# Reviewer notes\n\nThe notes body.\n"],
    [SPEC, "# Spec 0042\n\nThe spec body.\n"],
    [OUTSIDE, "# Audit findings\n\nThe findings body.\n"],
  ]);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  const { active, close } = useViewerOverlayStore.getState();
  if (active) close(active.key);
  vi.unstubAllGlobals();
});

const settle = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

async function renderMessage() {
  await act(async () => {
    root.render(
      <>
        <ChatMarkdown
          cwd={CWD}
          threadRef={threadRef}
          text={`The review is in \`${REPORT}\`.`}
          isStreaming={false}
        />
        <ViewerOverlayHost renderThread={() => null} />
      </>,
    );
  });
  await settle();
  await settle();
}

const overlay = () => document.querySelector<HTMLElement>("[data-viewer-overlay]");
const reader = () => document.querySelector<HTMLElement>('[data-report-reader="true"]');
const linkedPane = () => document.querySelector<HTMLElement>('[data-viewer-linked="file"]');

function link(scope: ParentNode, label: string): HTMLAnchorElement {
  const found = Array.from(scope.querySelectorAll<HTMLAnchorElement>("a")).find((anchor) =>
    anchor.textContent?.includes(label),
  );
  expect(found, `link ${label}`).toBeDefined();
  return found!;
}

async function click(element: HTMLElement) {
  await act(async () => {
    element.click();
  });
  await settle();
  await settle();
}

async function openReport() {
  await renderMessage();
  await click(link(container, "review.md"));
  expect(overlay(), "overlay open").not.toBeNull();
  expect(reader()?.textContent).toContain("Review of 0042");
}

async function back() {
  const button = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-viewer-overlay-head="true"] button'),
  ).find((candidate) => candidate.textContent?.includes("Back"));
  expect(button, "Back").toBeDefined();
  await click(button!);
}

it.each([
  ["an absolute link", "findings.md", OUTSIDE, "Audit findings"],
  ["a sibling link", "notes.md", NOTE, "Reviewer notes"],
  ["a parent-folder link", "spec.md", SPEC, "Spec 0042"],
])(
  "opens %s to another markdown file inside a report, with Back to the report",
  async (_case, label, path, heading) => {
    await openReport();
    await click(link(reader()!, label));

    const store = useViewerOverlayStore.getState();
    expect(store.active, "the overlay stays open").not.toBeNull();
    expect(overlay(), "the overlay stays open").not.toBeNull();
    expect(store.linked?.kind).toBe("file");
    const file = store.linked?.kind === "file" ? store.linked.file : null;
    expect(hostRead(file!.cwd, file!.path)).toBe(state.files.get(path));
    expect(linkedPane()?.textContent).toContain(heading);
    expect(state.toast).not.toHaveBeenCalled();
    expect(state.openFile).not.toHaveBeenCalled();

    await back();
    expect(linkedPane()).toBeNull();
    expect(overlay()).not.toBeNull();
    expect(reader()?.textContent).toContain("Review of 0042");
  },
);

// A worker's reply shown as a report card: the reader lists the files the
// report names as cards under it, and a markdown card opens in the reader's
// place, with Back to the report, rather than closing the overlay.
const WORKER_REPORT = [
  "# Review of 0042",
  "",
  `The plan is in [the spec](${SPEC}) and the audit in [findings](${OUTSIDE}).`,
].join("\n");

// The same report with labeled parts, read as a document as the timeline renders it.
const LABELED_REPORT = [
  "# Review of 0042",
  "",
  "**Outcome:** the review is done.",
  "",
  `**Evidence:** the plan is in [the spec](${SPEC}) and the audit in [findings](${OUTSIDE}).`,
].join("\n");

async function openWorkerReport(labeled = false) {
  const text = labeled ? LABELED_REPORT : WORKER_REPORT;
  await act(async () => {
    root.render(
      <>
        <ReportArtifactCard
          text={text}
          fallbackTitle="Report"
          save={null}
          threadRef={threadRef}
          {...(labeled
            ? {
                renderMarkdown: (part: string) => (
                  <ChatMarkdown cwd={CWD} threadRef={threadRef} text={part} isStreaming={false} />
                ),
              }
            : {})}
          renderAttachments={() => <ArtifactCards threadRef={threadRef} cwd={CWD} text={text} />}
        >
          <ChatMarkdown cwd={CWD} threadRef={threadRef} text={text} isStreaming={false} />
        </ReportArtifactCard>
        <ViewerOverlayHost renderThread={() => null} />
      </>,
    );
  });
  await settle();
  const open = container.querySelector<HTMLButtonElement>('button[aria-label^="Open report"]');
  expect(open, "report card").not.toBeNull();
  await click(open!);
  await settle();
  expect(overlay(), "overlay open").not.toBeNull();
  expect(reader()?.textContent).toContain("Review of 0042");
}

const attachmentCard = (name: string) =>
  Array.from(reader()?.querySelectorAll<HTMLButtonElement>("[data-artifact-card]") ?? []).find(
    (card) => card.textContent?.includes(name),
  );

it.each([
  ["a file inside the workspace", "spec.md", SPEC, "Spec 0042", "card", false],
  ["a file outside the workspace", "findings.md", OUTSIDE, "Audit findings", "card", false],
  ["a labeled report", "spec.md", SPEC, "Spec 0042", "card", true],
  ["a labeled report's inline link", "findings.md", OUTSIDE, "Audit findings", "link", true],
])(
  "opens the report's markdown file for %s in the report's place, with Back",
  async (_case, name, path, heading, from, labeled) => {
    await openWorkerReport(labeled);
    if (labeled) expect(reader()?.querySelector('[data-report-lead="true"]')).not.toBeNull();
    const target = from === "card" ? attachmentCard(name) : link(reader()!, name);
    expect(target, `${name} ${from}`).toBeDefined();
    await click(target!);

    const store = useViewerOverlayStore.getState();
    expect(store.active, "the overlay stays open").not.toBeNull();
    expect(overlay(), "the overlay stays open").not.toBeNull();
    expect(store.active?.title).toBe("Review of 0042");
    const file = store.linked?.kind === "file" ? store.linked.file : null;
    expect(file, "the attachment opens as a linked file").not.toBeNull();
    expect(hostRead(file!.cwd, file!.path)).toBe(state.files.get(path));
    expect(linkedPane()?.textContent).toContain(heading);

    await back();
    expect(linkedPane()).toBeNull();
    expect(overlay()).not.toBeNull();
    expect(reader()?.textContent).toContain("Review of 0042");
  },
);
