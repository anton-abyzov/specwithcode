import { EnvironmentId, ThreadId } from "@specweave-studio/contracts";
import { AsyncResult } from "effect/reactivity";
import { act, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  openInEditor: vi.fn(),
  listEntries: vi.fn(),
  existing: new Set<string>(),
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
vi.mock("../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../state/use-atom-command", () => ({ useAtomCommand: () => state.openInEditor }));
vi.mock("../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../state/session")>()),
  readEnvironmentScope: () => true,
  useEnvironmentScope: () => false,
  usePreparedConnection: () => ({ _tag: "None" }),
}));
vi.mock("../state/projects", () => ({
  projectEnvironment: {
    searchEntries: () => ({ input: { cwd: "" } }),
    listEntries: (request: { input: { cwd: string } }) => request,
  },
}));
vi.mock("@specweave-studio/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@specweave-studio/client-runtime/state/runtime")>()),
  executeAtomQuery: async (_registry: unknown, request: { input: { cwd: string } }) => {
    state.listEntries(request.input.cwd);
    const prefix = `${request.input.cwd}/`;
    return AsyncResult.success({
      truncated: false,
      entries: [...state.existing]
        .filter((path) => path.startsWith(prefix) && !path.slice(prefix.length).includes("/"))
        .map((path) => ({
          path: path.slice(prefix.length),
          kind: path.endsWith(".svg") || path.endsWith(".md") ? "file" : "directory",
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

const CWD = "/Users/me/Projects/specweave";
const LOGO = "/Users/me/Projects/swc-logo";
const REPORT = [
  `Evidence: \`${LOGO}/png/contact-sheet.png\`, \`svg/icon.svg\`, \`png/icon-4k.png\`,`,
  "`png/app/`, `png/icon.ico`. Kie studies: `explorations/`. Notes: `README.md`.",
].join(" ");
const threadRef = {
  environmentId: EnvironmentId.make("refs-environment"),
  threadId: ThreadId.make("refs-thread"),
};

let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.openInEditor.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.listEntries.mockReset();
  state.existing = new Set([`${LOGO}/svg/icon.svg`, `${LOGO}/png/app`, `${LOGO}/README.md`]);
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

function chip(label: string) {
  const link = renderer!.root
    .findAllByType("a")
    .find((node) => node.findAll((child) => child.children.includes(label)).length > 0);
  expect(link, label).toBeDefined();
  return link!;
}

it("turns every path in a report into a chip that points at the folder it names", async () => {
  await act(async () => {
    renderer = create(<ChatMarkdown cwd={CWD} threadRef={threadRef} text={REPORT} />);
  });
  for (const label of ["icon.svg", "app", "explorations", "README.md", "icon.ico"]) chip(label);
  expect(chip("icon.svg").props.href).toBe(`${LOGO}/svg/icon.svg`);
  expect(chip("README.md").props.href).toBe(`${LOGO}/README.md`);
  expect(state.listEntries).toHaveBeenCalledWith(`${LOGO}/svg`);
});

it("opens a folder chip in the file manager", async () => {
  await act(async () => {
    renderer = create(<ChatMarkdown cwd={CWD} threadRef={threadRef} text={REPORT} />);
  });
  await act(async () => {
    chip("app").props.onClick({ preventDefault: vi.fn(), stopPropagation: vi.fn() });
  });
  expect(state.openInEditor).toHaveBeenCalledWith({
    environmentId: threadRef.environmentId,
    input: { cwd: `${LOGO}/png/app`, editor: "file-manager" },
  });
});

it("falls back to the workspace when the named folder does not hold the file", async () => {
  state.existing = new Set([`${CWD}/svg/icon.svg`]);
  await act(async () => {
    renderer = create(<ChatMarkdown cwd={CWD} threadRef={threadRef} text={REPORT} />);
  });
  expect(chip("icon.svg").props.href).toBe(`${CWD}/svg/icon.svg`);
});
