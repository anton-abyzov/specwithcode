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
  environments: [] as string[],
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
    request: { search?: true; environmentId?: string; input: { cwd: string; query?: string } },
  ) => {
    if (request.environmentId) state.environments.push(request.environmentId);
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
import { clearSettledFileLinkCache } from "./chat/useExistingFileLinks";

// November 24, 2026 on M5: a coordinator reply wrote `llms.txt` for the web
// convention, a file nobody had made. It linked, and the click said
// "llms.txt was not found". A bare name names no place: it links only once
// the thread's own machine has the file.
const CWD = "/Users/me/Projects/umbrella";
const threadRef = {
  environmentId: EnvironmentId.make("bare-environment"),
  threadId: ThreadId.make("bare-thread"),
};

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  clearSettledFileLinkCache();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.openInEditor.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.openFile.mockReset();
  state.toast.mockReset();
  state.listEntries.mockReset();
  state.environments = [];
  state.existing = new Set([CWD, `${CWD}/README.md`, `${CWD}/apps/web/src/app.ts`]);
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

async function render(text: string, ref = threadRef) {
  await act(async () => {
    renderer = create(<ChatMarkdown cwd={CWD} threadRef={ref} text={text} />);
  });
}

function links() {
  return renderer!.root.findAllByType("a");
}

function linkNamed(label: string) {
  return links().find((node) => node.findAll((child) => child.children.includes(label)).length > 0);
}

function codeNamed(text: string) {
  return renderer!.root.findAll((node) => node.type === "code" && node.children.includes(text));
}

it("leaves a bare name the machine does not have as plain code", async () => {
  await render("Next we could add an `llms.txt` for agents.");
  expect(linkNamed("llms.txt")).toBeUndefined();
  expect(codeNamed("llms.txt")).toHaveLength(1);
  expect(state.toast).not.toHaveBeenCalled();
});

it("links a bare name the machine has", async () => {
  await render("See `README.md`.");
  expect(linkNamed("README.md")?.props.href).toBe(`${CWD}/README.md`);
});

it("links a bare name with a line once search finds the one file, keeping the line", async () => {
  await render("The bug is at `app.ts:12`.");
  const link = links()[0];
  expect(link?.props.href).toBe(`${CWD}/apps/web/src/app.ts:12`);
});

it("keeps a missing path with a folder as a link that says where it looked", async () => {
  await render("The page is `docs/llms.txt`.");
  const link = linkNamed("llms.txt");
  expect(link).toBeDefined();
  await act(async () => {
    link!.props.onClick({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
  });
  expect(state.toast).toHaveBeenCalledWith(
    expect.objectContaining({ title: "llms.txt was not found" }),
  );
});

it("asks the thread's own machine", async () => {
  const remote = { ...threadRef, environmentId: EnvironmentId.make("remote-environment") };
  await render("See `README.md`.", remote);
  expect(state.environments).toContain("remote-environment");
  expect(state.environments).not.toContain("bare-environment");
});

it("shows a confirmed name at once on the next mount and checks a missing one again", async () => {
  await render("See `README.md` and `llms.txt`.");
  await act(async () => renderer?.unmount());
  state.listEntries.mockReset();
  state.existing.add(`${CWD}/llms.txt`);
  // The first render, before the machine answers again.
  act(() => {
    renderer = create(
      <ChatMarkdown cwd={CWD} threadRef={threadRef} text="See `README.md` and `llms.txt`." />,
    );
  });
  expect(linkNamed("README.md")).toBeDefined();
  expect(linkNamed("llms.txt")).toBeUndefined();
  await act(async () => {});
  expect(linkNamed("llms.txt")?.props.href).toBe(`${CWD}/llms.txt`);
});

it("drops a confirmed chip once the file is deleted", async () => {
  await render("See `README.md`.");
  expect(linkNamed("README.md")).toBeDefined();
  await act(async () => renderer?.unmount());
  state.existing.delete(`${CWD}/README.md`);
  await render("See `README.md`.");
  expect(linkNamed("README.md")).toBeUndefined();
  expect(codeNamed("README.md")).toHaveLength(1);
});

it("links a bare name whose inline code wraps onto the next line", async () => {
  await render("See `README.md\n` for setup.");
  expect(linkNamed("README.md")?.props.href).toBe(`${CWD}/README.md`);
});

it("never shows the file a span named under its previous folder", async () => {
  const OTHER = "/Users/me/Projects/other";
  state.existing.add(OTHER).add(`${OTHER}/notes`).add(`${OTHER}/notes/README.md`);
  await render(`Built in \`${OTHER}/notes/\`. See \`README.md\`.`);
  expect(linkNamed("README.md")?.props.href).toBe(`${OTHER}/notes/README.md`);
  state.existing.delete(`${CWD}/README.md`);
  await act(async () => {
    renderer!.update(<ChatMarkdown cwd={CWD} threadRef={threadRef} text="See `README.md`." />);
  });
  expect(linkNamed("README.md")).toBeUndefined();
});
