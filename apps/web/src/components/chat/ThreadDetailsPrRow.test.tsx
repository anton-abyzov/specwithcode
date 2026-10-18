import { EnvironmentId, type PullRequestCheck } from "@specweave-studio/contracts";
import { act, cloneElement, type ReactElement, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  status: "success" as PullRequestCheck["status"],
  extraStatus: null as PullRequestCheck["status"] | null,
  mergeability: "mergeable" as "mergeable" | "conflicting",
  perform: vi.fn(),
  startHandoff: vi.fn(),
}));

vi.mock("~/state/entities", () => ({ useServerConfigs: () => new Map() }));
vi.mock("~/state/pullRequests", () => ({ pullRequestEnvironment: {} }));
vi.mock("~/hooks/useLiveRefresh", () => ({ useLiveRefresh: () => {} }));
vi.mock("~/state/query", () => ({
  useEnvironmentQuery: () => ({
    data: {
      number: 1,
      title: "Test PR",
      url: "https://github.com/acme/atlas/pull/1",
      state: "open",
      isDraft: false,
      mergeability: state.mergeability,
      headBranch: "feature",
      baseBranch: "main",
      changedFiles: 1,
      additions: 1,
      deletions: 0,
      checks: [state.status, ...(state.extraStatus ? [state.extraStatus] : [])].map((status) => ({
        name: `CI-${status}`,
        status,
        description: null,
        url: null,
      })),
      capabilities: { actions: ["merge"], mergeMethods: ["merge"] },
      viewerPermissions: { actions: ["merge"] },
      mergeCapabilities: { merge: true, squash: false, rebase: false },
    },
    dataUpdatedAt: 1,
    isPending: false,
    refresh: vi.fn(),
  }),
}));
vi.mock("../pullRequest/usePullRequestActions", () => ({
  usePullRequestActionRunner: () => ({ actionPending: false, perform: state.perform }),
  usePullRequestHandoffs: () => ({ handoff: null, startHandoff: state.startHandoff }),
}));
vi.mock("../ui/popover", () => ({
  Popover: ({ children }: { children: ReactNode }) => children,
  PopoverTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, undefined, children),
  PopoverPopup: () => null,
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render, children }: { render: ReactElement; children: ReactNode }) =>
    cloneElement(render, undefined, children),
  TooltipPopup: () => null,
}));
vi.mock("../ui/alert-dialog", () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div role="alertdialog">{children}</div> : null,
  AlertDialogPopup: ({ children }: { children: ReactNode }) => children,
  AlertDialogHeader: ({ children }: { children: ReactNode }) => children,
  AlertDialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  AlertDialogDescription: ({ children }: { children: ReactNode }) => children,
  AlertDialogFooter: ({ children }: { children: ReactNode }) => children,
  AlertDialogClose: () => null,
}));

import { ThreadDetailsPrRow } from "./ThreadDetailsPrRow";

let renderer: ReactTestRenderer;
afterEach(() => {
  act(() => renderer?.unmount());
  vi.unstubAllGlobals();
  state.status = "success";
  state.extraStatus = null;
  state.mergeability = "mergeable";
  state.startHandoff.mockReset();
});

it("requires a new merge click after passing checks become pending and pass again", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const render = () => (
    <ThreadDetailsPrRow
      environmentId={EnvironmentId.make("environment")}
      pr={null}
      number={1}
      status={null}
      project={null}
      label="Test PR"
      openAriaLabel="Open PR"
      onOpen={vi.fn()}
    />
  );
  const clickMerge = () =>
    act(() => {
      renderer.root
        .findAllByType("button")
        .find((button) => button.children.includes("Merge"))!
        .props.onClick();
    });
  const dialogs = () => renderer.root.findAllByProps({ role: "alertdialog" });

  act(() => {
    renderer = create(render());
  });
  clickMerge();
  expect(dialogs()).toHaveLength(1);
  act(() => {
    state.status = "pending";
    renderer.update(render());
  });
  expect(dialogs()).toHaveLength(0);
  act(() => {
    state.status = "success";
    renderer.update(render());
  });
  expect(dialogs()).toHaveLength(0);
  clickMerge();
  expect(dialogs()).toHaveLength(1);
  expect(state.perform).not.toHaveBeenCalled();
});

it.each<[PullRequestCheck["status"], PullRequestCheck["status"], string]>([
  ["success", "skipped", ""],
  ["failure", "cancelled", ""],
  ["success", "action-required", ""],
  ["success", "pending", "1/2"],
  ["failure", "pending", "1/2"],
])("shows a count only while checks run (%s, %s)", (status, extraStatus, count) => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.status = status;
  state.extraStatus = extraStatus;
  act(() => {
    renderer = create(
      <ThreadDetailsPrRow
        environmentId={EnvironmentId.make("environment")}
        pr={null}
        number={1}
        status={null}
        project={null}
        label="Test PR"
        openAriaLabel="Open PR"
        onOpen={vi.fn()}
      />,
    );
  });
  const text = renderer.root
    .findAllByType("span")
    .map((span) => span.children.filter((child) => typeof child === "string").join(""));
  expect(text.filter((value) => /^\d+\/\d+$/.test(value))).toEqual(count ? [count] : []);
});

it.each([
  ["the thread's own branch", "feature", true],
  ["another branch", "other", false],
  ["no branch", null, false],
] as const)(
  "resolves conflicts on %s in place only when it is the PR's head",
  (_, branch, inPlace) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    state.mergeability = "conflicting";
    const onResolveInThread = vi.fn(async () => true);
    act(() => {
      renderer = create(
        <ThreadDetailsPrRow
          environmentId={EnvironmentId.make("environment")}
          pr={null}
          number={1}
          status={null}
          project={null}
          label="Test PR"
          openAriaLabel="Open PR"
          onOpen={vi.fn()}
          threadBranch={branch}
          onResolveInThread={onResolveInThread}
        />,
      );
    });
    act(() => {
      renderer.root
        .findAllByType("button")
        .find((button) => button.children.includes("Resolve"))!
        .props.onClick();
    });
    if (inPlace) {
      expect(onResolveInThread).toHaveBeenCalledWith({
        number: 1,
        url: "https://github.com/acme/atlas/pull/1",
        conflict: { headBranch: "feature", baseBranch: "main" },
      });
      expect(state.startHandoff).not.toHaveBeenCalled();
    } else {
      expect(onResolveInThread).not.toHaveBeenCalled();
      expect(state.startHandoff).toHaveBeenCalledWith("conflicts", expect.anything());
    }
  },
);
