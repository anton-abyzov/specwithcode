// @vitest-environment jsdom
import { act } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import {
  state,
  root,
  container,
  shell,
  render,
  openFirstThread,
  press,
  click,
  prompt,
} from "./ProjectWorkspace.test-fixtures";
import { ProjectWorkspace } from "./ProjectWorkspace";
import { UnreachableHostsContext } from "../../studio/unreachableHosts";
import { enqueueProjectCoordinatorDraft } from "../../studio/projectCoordinatorDraft";

describe("thread links inside the project", () => {
  const openThread = (id: string) => container.querySelector(`[data-native-thread="${id}"]`);
  it.each(["user", undefined] as const)(
    "keeps %s-owned independent chats outside the worker pane",
    async (createdBy) => {
      const independent = shell("independent", { createdBy: "user" });
      if (createdBy === undefined) Reflect.deleteProperty(independent, "createdBy");
      state.shells.push(independent);
      await render();
      const pane = container.querySelector('[data-project-pane="threads"]')!;
      expect(pane.querySelector('[data-thread-id="worker"]')).not.toBeNull();
      expect(pane.querySelector('[data-thread-id="independent"]')).toBeNull();
      await act(async () =>
        root.render(
          <ProjectWorkspace
            projectKey="atlas"
            selectedThreadId={"independent" as never}
            onSelectThread={vi.fn()}
          />,
        ),
      );
      expect(openThread("independent")).toBeNull();
      expect(state.navigate).toHaveBeenCalledWith({
        to: "/$environmentId/$threadId",
        params: { environmentId: "host", threadId: "independent" },
        replace: true,
      });
    },
  );
  it("opens a subagent of a project thread in the right panel, whatever its project id", async () => {
    state.shells.push(
      shell("child", {
        projectId: "provider-scratch" as EnvironmentThreadShell["projectId"],
        lineage: {
          relationshipToParent: "subagent",
          parentThreadId: "worker",
          rootThreadId: "worker",
        } as EnvironmentThreadShell["lineage"],
      }),
    );
    state.relatedThreadId = "child";
    await render();
    await openFirstThread();
    await click("Open related thread");
    expect(openThread("child")).not.toBeNull();
    expect(state.navigate).not.toHaveBeenCalled();
  });
  it("opens another project's thread full page instead of doing nothing", async () => {
    state.relatedThreadId = "foreign";
    await render();
    await openFirstThread();
    await click("Open related thread");
    expect(openThread("worker")).not.toBeNull();
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "host", threadId: "foreign" },
    });
  });
  it("opens the thread the URL names and reports selections back to the route", async () => {
    const onSelectThread = vi.fn();
    await act(async () =>
      root.render(
        <ProjectWorkspace
          projectKey="atlas"
          selectedThreadId={"worker" as never}
          onSelectThread={onSelectThread}
        />,
      ),
    );
    expect(openThread("worker")).not.toBeNull();
    await click("Open related thread");
    // Already open: the route is asked again and ignores the repeat.
    expect(onSelectThread).toHaveBeenLastCalledWith("worker");
    await press({ key: "Escape" });
    expect(onSelectThread).toHaveBeenLastCalledWith(null);
  });
  it("hands the route the quoted passage to land on in the opened thread", async () => {
    state.shells.push(shell("quoted"));
    const onSelectThread = vi.fn();
    await act(async () =>
      root.render(
        <ProjectWorkspace
          projectKey="atlas"
          selectedThreadId={"worker" as never}
          onSelectThread={onSelectThread}
        />,
      ),
    );
    const at = { hash: "assistant-citation=abc", state: { assistantCitationActivation: "1" } };
    let opened = false;
    await act(async () => {
      opened = state.routing!.openThread("quoted" as never, undefined, at);
    });
    expect(opened).toBe(true);
    expect(onSelectThread).toHaveBeenLastCalledWith("quoted", at);
  });
  it("sends a URL that names another project's thread to that thread's own page", async () => {
    await act(async () =>
      root.render(
        <ProjectWorkspace
          projectKey="atlas"
          selectedThreadId={"foreign" as never}
          onSelectThread={vi.fn()}
        />,
      ),
    );
    expect(openThread("foreign")).toBeNull();
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "host", threadId: "foreign" },
      replace: true,
    });
  });
  const renderSelected = async (id: string, onSelectThread = vi.fn()) => {
    await act(async () =>
      root.render(
        <ProjectWorkspace
          projectKey="atlas"
          selectedThreadId={id as never}
          onSelectThread={onSelectThread}
        />,
      ),
    );
    return onSelectThread;
  };
  it("closes the panel on a deleted thread without a new history entry", async () => {
    state.shells.push(shell("gone", { deletedAt: "2026-10-11T00:00:00Z" as never }));
    const onSelectThread = await renderSelected("gone");
    expect(onSelectThread).toHaveBeenCalledWith(null, { replace: true });
    expect(state.navigate).not.toHaveBeenCalled();
  });
  it("waits for every host before dropping a thread it has not seen", async () => {
    state.shellsBootstrapped = false;
    const onSelectThread = await renderSelected("later");
    expect(onSelectThread).not.toHaveBeenCalled();
    state.shellsBootstrapped = true;
    await renderSelected("later", onSelectThread);
    expect(onSelectThread).toHaveBeenCalledWith(null, { replace: true });
  });
  it("opens a thread only another machine has on that machine's page", async () => {
    state.shells.push(shell("remote", { environmentId: "laptop" as never }));
    await renderSelected("remote");
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "laptop", threadId: "remote" },
      replace: true,
    });
  });
  it("shows the overview on the first press while the URL names a thread not loaded yet", async () => {
    state.shellsBootstrapped = false;
    await renderSelected("later");
    const toggle = () => container.querySelector<HTMLButtonElement>(".sws-overview-toggle")!;
    await act(async () => toggle().click());
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    await act(async () => toggle().click());
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
  });
  it("keeps one thread opener across renders and lets go of links once the project is left", async () => {
    await render();
    await openFirstThread();
    const routing = state.routing!;
    await prompt("Typing re-renders the project");
    expect(state.routing!.openThread).toBe(routing.openThread);
    await act(async () => root.render(<div />));
    expect(routing.openThread("worker" as never)).toBe(false);
  });
});

describe("switching the coordinator machine", () => {
  it("honors a linked checkout without changing the saved machine", async () => {
    state.otherCheckouts = [
      { id: "remote-project", environmentId: "laptop", workspaceRoot: "/w/atlas" },
    ];
    state.savedMachines = { atlas: "host:project" };
    await act(async () =>
      root.render(<ProjectWorkspace projectKey="atlas" checkoutKey="laptop:remote-project" />),
    );
    await prompt("Use the linked checkout");
    await click("Send");
    expect(state.send.mock.calls.at(-1)?.[0]).toMatchObject({
      environmentId: "laptop",
      input: { projectId: "remote-project" },
    });
    expect(state.savedMachines).toEqual({ atlas: "host:project" });
  });
  it("works on a reachable checkout while the saved machine is offline, keeping the choice", async () => {
    state.otherCheckouts = [
      { id: "remote-project", environmentId: "laptop", workspaceRoot: "/w/atlas" },
    ];
    state.savedMachines = { atlas: "laptop:remote-project" };
    await act(async () =>
      root.render(
        <UnreachableHostsContext.Provider value={new Set(["laptop"])}>
          <ProjectWorkspace projectKey="atlas" />
        </UnreachableHostsContext.Provider>,
      ),
    );
    expect(container.textContent).toContain("Saved machine offline");
    await prompt("Keep working while the laptop is away");
    await click("Send");
    expect(state.send.mock.calls.at(-1)?.[0]).toMatchObject({
      environmentId: "host",
      input: { projectId: "project" },
    });
    expect(state.savedMachines).toEqual({ atlas: "laptop:remote-project" });
  });
  it("never substitutes a different checkout when a linked checkout is missing", async () => {
    state.savedMachines = { atlas: "host:project" };
    const onSelectCheckout = vi.fn();
    await act(async () =>
      root.render(
        <ProjectWorkspace
          projectKey="atlas"
          checkoutKey="host:removed-project"
          onSelectCheckout={onSelectCheckout}
        />,
      ),
    );
    expect(container.textContent).toContain("Linked checkout unavailable");
    expect(container.querySelector("#project-prompt")).toBeNull();
    expect(state.send).not.toHaveBeenCalled();
    await click("Use host · /scratch/atlas");
    expect(onSelectCheckout).toHaveBeenCalledWith("host:project");
    expect(state.savedMachines).toEqual({ atlas: "host:project" });
  });
  it("keeps the coordinator, worker and draft until the selected machine completes a handoff", async () => {
    state.otherCheckouts = [{ id: "project", environmentId: "laptop", workspaceRoot: "/w/atlas" }];
    state.shells.push(shell("old-checkout-thread"));
    const onSelectThread = vi.fn();
    const renderOpen = () =>
      act(async () =>
        root.render(
          <ProjectWorkspace
            projectKey="atlas"
            selectedThreadId={"old-checkout-thread" as never}
            onSelectThread={onSelectThread}
          />,
        ),
      );
    await renderOpen();
    expect(container.querySelector('[data-native-thread="old-checkout-thread"]')).not.toBeNull();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label^="Coordinator runs on"]')!.click(),
    );
    const laptop = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
      (element) => element.textContent?.includes("laptop"),
    );
    await act(async () => laptop!.click());
    expect(state.savedMachines).toEqual({});
    await renderOpen();
    expect(onSelectThread).not.toHaveBeenCalled();
    expect(state.navigate).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(container.querySelector('[data-native-thread="old-checkout-thread"]')).not.toBeNull();
  });
});

describe("the coordinator stays in the main column", () => {
  const nativeThread = (id: string) => document.querySelector(`[data-native-thread="${id}"]`);
  const renderSelected = async (id: string, onSelectThread = vi.fn()) => {
    await act(async () =>
      root.render(
        <ProjectWorkspace
          projectKey="atlas"
          selectedThreadId={id as never}
          onSelectThread={onSelectThread}
        />,
      ),
    );
    return onSelectThread;
  };
  it("lets go of a URL that names the coordinator, without a new history entry", async () => {
    const onSelectThread = await renderSelected("coord");
    expect(nativeThread("coord")).toBeNull();
    expect(onSelectThread).toHaveBeenCalledWith(null, { replace: true });
    expect(state.navigate).not.toHaveBeenCalled();
    expect(container.querySelector('[aria-label="Coordinator conversation"]')).not.toBeNull();
  });
  it("shows the main conversation for a link to the coordinator from an open thread", async () => {
    state.relatedThreadId = "coord";
    await render();
    await openFirstThread();
    expect(nativeThread("worker")).not.toBeNull();
    await click("Open related thread");
    expect(nativeThread("coord")).toBeNull();
    expect(nativeThread("worker")).toBeNull();
    expect(state.navigate).not.toHaveBeenCalled();
  });
  it("answers the routing's own coordinator request the same way", async () => {
    await render();
    await openFirstThread();
    await act(async () => state.routing!.openCoordinator());
    expect(nativeThread("coord")).toBeNull();
    expect(nativeThread("worker")).toBeNull();
  });
  it("keeps the status chip in the main column", async () => {
    await render();
    await openFirstThread();
    const chip = container.querySelector<HTMLButtonElement>(".sws-state")!;
    expect(chip.textContent).toContain("Idle");
    await act(async () => chip.click());
    expect(nativeThread("coord")).toBeNull();
    expect(nativeThread("worker")).toBeNull();
  });
  it("suspends worker commands during handoff and restores them without replacing the coordinator draft", async () => {
    await render();
    await openFirstThread();
    await prompt("Keep my coordinator draft");
    expect(nativeThread("worker")?.hasAttribute("data-native-suspend")).toBe(false);
    await click("Handoff");
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(nativeThread("worker")?.hasAttribute("data-native-suspend")).toBe(true);
    expect(container.querySelector<HTMLTextAreaElement>("#project-prompt")!.value).toBe(
      "Keep my coordinator draft",
    );
    await act(async () =>
      document.querySelector<HTMLButtonElement>('[role="dialog"] [aria-label="Close"]')!.click(),
    );
    expect(nativeThread("worker")?.hasAttribute("data-native-suspend")).toBe(false);
    expect(state.navigate).not.toHaveBeenCalled();
  });
  it.each(["hasPendingApprovals", "hasPendingUserInput", "hasActionableProposedPlan"] as const)(
    "reviews %s in a dialog while preserving the coordinator, worker, and draft",
    async (attention) => {
      state.shells = state.shells.map((t) => (t.id === "coord" ? { ...t, [attention]: true } : t));
      await render();
      await openFirstThread();
      await prompt("Keep my coordinator draft");
      const chip = container.querySelector<HTMLButtonElement>(".sws-state")!;
      expect(chip.dataset.opens).toBe("coordinator-review");
      chip.focus();
      await act(async () => chip.click());
      expect(state.navigate).not.toHaveBeenCalled();
      expect(nativeThread("coord")?.closest('[role="dialog"]')).not.toBeNull();
      expect(container.querySelector("#project-prompt")).not.toBeNull();
      expect(nativeThread("worker")?.closest('[data-project-pane="threads"]')).not.toBeNull();
      expect(nativeThread("worker")?.hasAttribute("data-native-suspend")).toBe(true);
      await click("Close review");
      expect(nativeThread("coord")).toBeNull();
      expect(nativeThread("worker")).not.toBeNull();
      expect(document.activeElement).toBe(chip);
      expect(container.querySelector<HTMLTextAreaElement>("#project-prompt")!.value).toBe(
        "Keep my coordinator draft",
      );
    },
  );
  it.each(["Resume", "Plan"])(
    "%s in native review uses the acknowledged project selection, not the stale projection",
    async (kind) => {
      state.shells = state.shells.map((t) =>
        t.id === "coord" ? { ...t, hasPendingApprovals: true } : t,
      );
      await render();
      await act(async () => container.querySelector<HTMLButtonElement>(".sws-state")!.click());
      const details = nativeThread("coord")!;
      let resolveSave!: (value: unknown) => void;
      state.send.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveSave = resolve;
          }),
      );
      await act(async () => {
        container.querySelector<HTMLButtonElement>("[data-coordinator-model]")!.click();
        [...details.querySelectorAll("button")]
          .find((button) => button.textContent === `${kind} native`)!
          .click();
      });
      expect(state.nativeContinue).not.toHaveBeenCalled();
      await act(async () => resolveSave({ _tag: "Success", value: undefined }));
      expect(state.nativeContinue).toHaveBeenCalledExactlyOnceWith(kind, {
        instanceId: "codex-native",
        model: "picked-model",
      });
      expect(state.send).toHaveBeenCalledOnce();
    },
  );
  it("uses the acknowledged revision for another model change before projection refresh", async () => {
    await render();
    const picker = container.querySelector<HTMLButtonElement>("[data-coordinator-model]")!;
    await act(async () => picker.click());
    await act(async () => picker.click());
    expect(
      state.send.mock.calls.map(([call]) => call.input.workspaceSettings.expectedRevision),
    ).toEqual([1, 2]);
  });
  it("does not resume native review when the project model save failed", async () => {
    state.shells = state.shells.map((t) =>
      t.id === "coord" ? { ...t, hasPendingApprovals: true } : t,
    );
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>(".sws-state")!.click());
    const details = nativeThread("coord")!;
    state.send.mockResolvedValueOnce({ _tag: "Failure", error: new Error("Conflict") });
    await act(async () =>
      container.querySelector<HTMLButtonElement>("[data-coordinator-model]")!.click(),
    );
    await act(async () =>
      [...details.querySelectorAll("button")]
        .find((button) => button.textContent === "Resume native")!
        .click(),
    );
    expect(state.nativeContinue).not.toHaveBeenCalled();
    expect(state.nativeError).toContain("Conflict");
  });
  it("shows a model save failure while coordinator review stays open", async () => {
    state.shells = state.shells.map((t) =>
      t.id === "coord" ? { ...t, hasPendingApprovals: true } : t,
    );
    await render();
    await act(async () => container.querySelector<HTMLButtonElement>(".sws-state")!.click());
    state.send.mockResolvedValueOnce({ _tag: "Failure", error: new Error("Host went away") });
    await act(async () =>
      container.querySelector<HTMLButtonElement>("[data-coordinator-model]")!.click(),
    );
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toBe(
      "Host went away",
    );
  });
  it("lists neither the coordinator nor a previous one among the project's threads", async () => {
    state.shells.push(shell("project-coordinator:project", { title: "Old coordinator" }));
    await render();
    const pane = container.querySelector("#project-threads-pane")!;
    expect(pane.querySelector('[data-thread-id="coord"]')).toBeNull();
    expect(pane.querySelector('[data-thread-id="project-coordinator:project"]')).toBeNull();
    expect(pane.querySelector('[data-thread-id="worker"]')).not.toBeNull();
  });
  it("opens a previous coordinator full page, where its history is, never in the panel", async () => {
    state.shells.push(shell("project-coordinator:project", { title: "Old coordinator" }));
    state.relatedThreadId = "project-coordinator:project";
    await render();
    await openFirstThread();
    await click("Open related thread");
    expect(nativeThread("project-coordinator:project")).toBeNull();
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/$environmentId/$threadId",
      params: { environmentId: "host", threadId: "project-coordinator:project" },
    });
  });
  it("treats the host's coordinator id as the coordinator before the settings name one", async () => {
    state.coordinatorId = null;
    const onSelectThread = await renderSelected("project-coordinator:project");
    expect(onSelectThread).toHaveBeenCalledWith(null, { replace: true });
    expect(state.navigate).not.toHaveBeenCalled();
  });
});

describe("thread cards' quick actions", () => {
  const announce = (overrides: Partial<EnvironmentThreadShell> = {}) => {
    state.shells.push(
      shell("fresh", {
        title: "Skills consolidation",
        createdAt: "2026-10-11T05:00:03Z",
        branch: "skills",
        ...overrides,
      } as Partial<EnvironmentThreadShell>),
    );
    state.messages = [
      {
        id: "ask",
        role: "user",
        createdBy: "user",
        text: "Consolidate the skills.",
        createdAt: "2026-10-11T05:00:00Z",
        streaming: false,
        attachments: [],
      },
      {
        id: "ack",
        role: "assistant",
        createdBy: "agent",
        text: "Started [Skills consolidation](studio://thread/fresh).",
        createdAt: "2026-10-11T05:00:04Z",
        updatedAt: "2026-10-11T05:00:05Z",
        streaming: false,
        attachments: [],
      },
    ];
  };
  const git = (overrides: Record<string, unknown> = {}) => ({
    isRepo: true,
    refName: "skills",
    isDefaultRef: false,
    hasPrimaryRemote: true,
    hasWorkingTreeChanges: true,
    workingTree: { files: [], insertions: 3, deletions: 1 },
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
    pr: null,
    ...overrides,
  });
  const card = () => container.querySelector<HTMLElement>('[data-thread-card="fresh"]')!;
  const actions = () =>
    [...card().querySelectorAll(".sws-thread-card-action")].map((b) => b.textContent);
  it("offers Create PR for unshipped changes and runs it beside the thread", async () => {
    announce();
    state.git = git();
    await render();
    expect(actions()).toEqual(["Create PR"]);
    // A title cut short in a narrow panel can still be read in full on hover.
    const title = card().querySelector<HTMLElement>(".sws-thread-card-title")!;
    expect(title.getAttribute("data-slot")).toBe("tooltip-trigger");
    const create = card().querySelector<HTMLButtonElement>('[data-action="create-pr"]')!;
    expect(create.getAttribute("aria-label")).toBe(
      "Create a pull request for Skills consolidation",
    );
    await act(async () => create.click());
    const ref = { environmentId: "host", threadId: "fresh" };
    expect(state.pullRequestRequests).toEqual([ref]);
    expect(state.detailsPanelsShown).toEqual([ref]);
    expect(container.querySelector('[data-native-thread="fresh"]')).not.toBeNull();
  });
  it("offers View PR once the thread has one, and opens it", async () => {
    announce({
      pullRequests: [
        {
          host: "github.com",
          repository: "acme/atlas",
          number: 42,
          url: "https://github.com/acme/atlas/pull/42",
          source: "created",
          linkedAt: "2026-10-11T05:01:00Z",
          snapshot: { state: "open", isDraft: false, title: "Skills", updatedAt: "2026-10-11" },
        },
      ] as never,
    });
    state.git = git();
    await render();
    expect(actions()).toEqual(["View PR"]);
    await act(async () =>
      card().querySelector<HTMLButtonElement>('[data-action="view-pr"]')!.click(),
    );
    expect(state.openLink).toHaveBeenCalledWith("https://github.com/acme/atlas/pull/42");
    // The pull request opens on its own; the thread does not open behind it.
    expect(container.querySelector('[data-native-thread="fresh"]')).toBeNull();
  });
  const conflictingPullRequest = (syncedAt = "2026-10-11T05:10:00Z") =>
    [
      {
        host: "github.com",
        repository: "acme/atlas",
        number: 288,
        url: "https://github.com/acme/atlas/pull/288",
        source: "created",
        linkedAt: "2026-10-11T05:01:00Z",
        stack: null,
        snapshot: {
          state: "open",
          isDraft: false,
          title: "Thread provider",
          headBranch: "skills",
          baseBranch: "main",
          updatedAt: "2026-10-11T05:05:00Z",
          syncedAt,
          mergeability: "conflicting",
        },
      },
    ] as never;
  it("offers Resolve conflicts on a conflicting pull request and sends it to that thread", async () => {
    announce({ pullRequests: conflictingPullRequest() });
    state.git = git({ hasWorkingTreeChanges: false });
    await render();
    expect(actions()).toEqual(["Resolve conflicts", "View PR"]);
    const resolve = card().querySelector<HTMLButtonElement>('[data-action="resolve-conflicts"]')!;
    expect(resolve.getAttribute("aria-label")).toBe(
      "Resolve the conflicts on pull request #288 in Skills consolidation",
    );
    state.send.mockClear();
    await act(async () => resolve.click());
    expect(state.send).toHaveBeenCalledTimes(1);
    const sent = state.send.mock.calls[0]![0] as {
      environmentId: string;
      input: { threadId: string; dispatchMode: string; message: { text: string } };
    };
    expect(sent.environmentId).toBe("host");
    expect(sent.input.threadId).toBe("fresh");
    // Queued: a run in progress is never interrupted to merge under it.
    expect(sent.input.dispatchMode).toBe("queue");
    expect(sent.input.message.text).toContain(
      "Your pull request #288 (https://github.com/acme/atlas/pull/288) now conflicts with its base branch `main`.",
    );
    // The thread stays where it is: the request goes to it, nothing opens.
    expect(container.querySelector('[data-native-thread="fresh"]')).toBeNull();
    // Hidden until a newer host read still reports the conflict.
    expect(actions()).toEqual(["View PR"]);
    announce({ pullRequests: conflictingPullRequest("2026-10-11T05:40:00Z") });
    state.shells.splice(
      state.shells.findIndex((thread) => thread.id === "fresh"),
      1,
    );
    await render();
    expect(actions()).toEqual(["Resolve conflicts", "View PR"]);
  });
  it("leaves Resolve conflicts out on a read-only connection", async () => {
    announce({ pullRequests: conflictingPullRequest("2026-10-11T06:00:00Z") });
    state.git = git({ hasWorkingTreeChanges: false });
    state.canOperate = false;
    await render();
    expect(actions()).toEqual(["View PR"]);
  });
  it("leaves Create PR out on a read-only connection", async () => {
    announce();
    state.git = git();
    state.canOperate = false;
    await render();
    expect(actions()).toEqual([]);
  });
  it("leaves Create PR out when the grant can operate but not change source control", async () => {
    announce();
    state.git = git();
    state.canWriteSourceControl = false;
    await render();
    expect(actions()).toEqual([]);
  });
  it("says why when nothing acted on Create PR by the deadline", async () => {
    vi.useFakeTimers();
    try {
      announce();
      state.git = git();
      state.expireResult = true;
      await render();
      await act(async () =>
        card().querySelector<HTMLButtonElement>('[data-action="create-pr"]')!.click(),
      );
      const { toastManager } = await import("../ui/toast");
      const add = vi.mocked(toastManager.add);
      add.mockClear();
      await act(async () => vi.advanceTimersByTime(16_000));
      expect(add).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "No pull request opened",
          description: "Nothing answered.",
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("project request drafts from PR actions", () => {
  it("appends a request to the current draft once without sending or replacing the worker pane", async () => {
    await render();
    await openFirstThread();
    await prompt("Keep my draft");
    await act(async () =>
      enqueueProjectCoordinatorDraft({
        environmentId: "host",
        projectId: "project",
        text: "Review PR 42",
      }),
    );
    expect(container.querySelector<HTMLTextAreaElement>("#project-prompt")!.value).toBe(
      "Keep my draft\n\nReview PR 42",
    );
    expect(container.querySelector('[data-native-thread="worker"]')).not.toBeNull();
    expect(state.send).not.toHaveBeenCalled();
    await render();
    expect(container.querySelector<HTMLTextAreaElement>("#project-prompt")!.value).toBe(
      "Keep my draft\n\nReview PR 42",
    );
  });
  it("keeps a staged request for its exact checkout until that checkout opens", async () => {
    enqueueProjectCoordinatorDraft({
      environmentId: "laptop",
      projectId: "remote-project",
      text: "Fix PR 9",
    });
    await render();
    expect(container.querySelector<HTMLTextAreaElement>("#project-prompt")!.value).toBe("");
    state.otherCheckouts = [
      { id: "remote-project", environmentId: "laptop", workspaceRoot: "/w/atlas" },
    ];
    await act(async () =>
      root.render(<ProjectWorkspace projectKey="atlas" checkoutKey="laptop:remote-project" />),
    );
    expect(container.querySelector<HTMLTextAreaElement>("#project-prompt")!.value).toBe("Fix PR 9");
    expect(state.send).not.toHaveBeenCalled();
  });
});
