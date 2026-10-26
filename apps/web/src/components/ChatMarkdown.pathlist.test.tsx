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
  useEnvironmentScope: () => true,
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
          kind: /\.[a-z0-9]+$/i.test(path) ? "file" : "directory",
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

import { Button } from "./ui/button";
import ChatMarkdown from "./ChatMarkdown";

const CWD = "/Users/me/Projects/app";
const CWS = "/Users/me/Downloads/specwithcode-browser-cws";
const SHOTS = [`${CWS}/screenshot-1-overview.png`, `${CWS}/screenshot-2-pair.png`];
const REPLY = [
  "Screenshots (1280x800), in order:",
  "```",
  "screenshot-1-overview.png",
  "screenshot-2-pair.png",
  "```",
].join("\n");
const threadRef = {
  environmentId: EnvironmentId.make("paths-environment"),
  threadId: ThreadId.make("paths-thread"),
};
const bytes = (text: string) => [...new TextEncoder().encode(text)];

let renderer: ReactTestRenderer | undefined;
let writeText: ReturnType<typeof vi.fn>;
let startFileDrag: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.openInEditor.mockReset().mockResolvedValue(AsyncResult.success(undefined));
  state.listEntries.mockReset();
  state.existing = new Set(SHOTS);
  writeText = vi.fn(async (_text: string) => {});
  startFileDrag = vi.fn(async (_path: string) => true);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  vi.stubGlobal("window", { desktopBridge: { startFileDrag } });
});
afterEach(async () => {
  await act(async () => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

async function renderReply() {
  await act(async () => {
    renderer = create(
      <ChatMarkdown cwd={CWD} threadRef={threadRef} text={REPLY} contextFolders={[CWS]} />,
    );
  });
  // Let the host settle where the bare names are.
  await act(async () => {});
}

function button(label: string) {
  const found = renderer!.root
    .findAllByType(Button)
    .filter(
      (node) =>
        node.props["aria-label"] === label ||
        node.findAll((child) => child.children.includes(label)).length > 0,
    );
  expect(found.length, label).toBeGreaterThan(0);
  return found;
}

it("shows a fenced list of bare file names as files with their full paths", async () => {
  await renderReply();
  expect(renderer!.root.findAllByProps({ "data-path-list": "" })).toHaveLength(1);
  const paths = renderer!.root
    .findAll((node) => node.type === "code" && node.props["data-path-list-path"] === "")
    .map((node) => node.children.join(""));
  expect(paths).toEqual(SHOTS);
  expect(state.listEntries).toHaveBeenCalledWith(CWS);
});

it("copies every path exactly, one per line, and each path on its own", async () => {
  await renderReply();
  await act(async () => {
    button("Copy all paths")[0]!.props.onClick();
  });
  expect(bytes(writeText.mock.calls.at(-1)![0])).toEqual(bytes(SHOTS.join("\n")));
  await act(async () => {
    button("Copy full path")[1]!.props.onClick();
  });
  expect(bytes(writeText.mock.calls.at(-1)![0])).toEqual(bytes(SHOTS[1]!));
});

it("drags a row out as the file itself", async () => {
  await renderReply();
  const row = renderer!.root.findAllByProps({ "data-path-list-row": "" })[0]!;
  const preventDefault = vi.fn();
  await act(async () => {
    row.props.onDragStart({ preventDefault, dataTransfer: { setData: vi.fn() } });
  });
  expect(preventDefault).toHaveBeenCalled();
  expect(startFileDrag).toHaveBeenCalledWith(SHOTS[0]);
});

it("keeps a fence with a command in it as code", async () => {
  await act(async () => {
    renderer = create(
      <ChatMarkdown cwd={CWD} threadRef={threadRef} text={"```\nopen screenshot-1.png\n```"} />,
    );
  });
  expect(renderer!.root.findAllByProps({ "data-path-list": "" })).toHaveLength(0);
});

it("shows a fenced list of absolute paths as files, not a runnable shell block", async () => {
  await act(async () => {
    renderer = create(
      <ChatMarkdown cwd={CWD} threadRef={threadRef} text={["```", ...SHOTS, "```"].join("\n")} />,
    );
  });
  await act(async () => {});
  expect(renderer!.root.findAllByProps({ "data-path-list": "" })).toHaveLength(1);
  const paths = renderer!.root
    .findAll((node) => node.type === "code" && node.props["data-path-list-path"] === "")
    .map((node) => node.children.join(""));
  expect(paths).toEqual(SHOTS);
});
