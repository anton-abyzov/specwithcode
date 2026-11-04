// @vitest-environment jsdom
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import {
  state,
  root,
  container,
  shell,
  render,
  press,
  click,
  prompt,
  alertText,
} from "./ProjectWorkspace.test-fixtures";
import { ProjectWorkspace } from "./ProjectWorkspace";

/** Enter in the coordinator's composer, as a person sends a message. */
async function enter() {
  const input = container.querySelector<HTMLTextAreaElement>("#project-prompt")!;
  await act(async () => {
    input.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
  });
}

describe("a coordinator turn that failed", () => {
  const failedCoordinator = (lastError: string | null) =>
    shell("coord", {
      latestRun: { runId: "run-1", status: "failed" },
      runtime: { lastError },
    } as unknown as Partial<EnvironmentThreadShell>);
  beforeEach(() => {
    state.messages = [
      {
        id: "m1",
        role: "user",
        createdBy: "user",
        runId: "run-1",
        text: "Reply with OK",
        streaming: false,
        attachments: [],
      },
    ];
  });

  it("says so in the project conversation, with the host's reason", async () => {
    state.shells = [
      failedCoordinator("Provider session failed to open: no remaining permitted usage."),
      shell("worker"),
    ];
    await render();
    const conversation = container.querySelector('[aria-label="Coordinator conversation"]')!;
    const alert = conversation.querySelector("[data-coordinator-failure][role='alert']");
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("The coordinator did not answer.");
    expect(alert!.textContent).toContain("no remaining permitted usage");
    await prompt("Preserve this draft");
    const retry = alert!.querySelector<HTMLButtonElement>("button")!;
    expect(retry.textContent).toBe("Retry last message");
    expect(retry.dataset.slot).toBe("button");
    await act(async () => retry.click());
    expect(state.send.mock.calls.at(-1)![0].input.prompt).toBe("Reply with OK");
    expect(container.querySelector<HTMLTextAreaElement>("#project-prompt")!.value).toBe(
      "Preserve this draft",
    );
    expect(document.querySelector('[data-native-thread="coord"]')).toBeNull();
    // A retry asks the host to read sign-in and usage afresh first.
    expect(state.send.mock.calls.at(-1)![0].input.recheck).toBe(true);
    // The run's ID is there to copy, not to read.
    const details = alert!.querySelector("details")!;
    expect(details.textContent).not.toContain("run-1");
    const copy = details.querySelector<HTMLButtonElement>("[data-coordinator-copy-run]")!;
    expect(copy.textContent).toBe("Copy run ID");
    expect(copy.title).toBe("run-1");
    expect(state.navigate).not.toHaveBeenCalled();
  });

  it("says who ran out of usage, where, and when it resets, without repeating the host", async () => {
    const hostText =
      "This native subscription profile has no remaining permitted usage under its current usage limit. Next observed reset: 2099-11-06T02:00:00.000Z. Select an eligible profile for a new session.";
    state.runs = [
      {
        id: "run-1",
        ordinal: 1,
        status: "failed",
        requestedAt: "2026-11-04T12:00:00Z",
        modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
      },
    ];
    state.shells = [
      shell("coord", {
        latestRun: { runId: "run-1", status: "failed" },
        runtime: {
          lastError: hostText,
          lastErrorClass: "usage_limit",
          usageLimitResetAt: "2099-11-06T02:00:00.000Z",
        },
      } as unknown as Partial<EnvironmentThreadShell>),
      shell("worker"),
    ];
    await render();
    const alert = container.querySelector("[data-coordinator-failure]")!;
    const body = alert.querySelector("[data-coordinator-failure-body]")!.textContent!;
    expect(body).toMatch(/^Claude Code · .+ on Test host has no usage left\. It resets \w{3} /);
    expect(body).toContain("Retry checks again, or pick another model.");
    expect(body).not.toContain("2099-11-06T02:00:00.000Z");
    // The host's text appears once, in the details, never next to its own summary.
    expect(alert.textContent!.split("no remaining permitted usage")).toHaveLength(2);
    expect(alert.querySelector("[data-coordinator-failure-detail]")!.textContent).toBe(hostText);
  });

  it("says which model a retry went to once the host picked it", async () => {
    // Its own run and message: a retry is sent once per failed run and message.
    state.messages = [{ ...state.messages[0]!, id: "m-routing", runId: "run-routing" }];
    state.shells = [
      shell("coord", {
        latestRun: { runId: "run-routing", status: "failed" },
        runtime: {
          lastError: "This native subscription profile has no remaining permitted usage.",
        },
      } as unknown as Partial<EnvironmentThreadShell>),
      shell("worker"),
    ];
    state.send.mockResolvedValue({
      _tag: "Success",
      value: {
        threadId: "coord",
        created: false,
        routing: {
          selection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
          reason: "saved",
          rechecked: true,
        },
      },
    });
    await render();
    const retry = container.querySelector<HTMLButtonElement>("[data-coordinator-failure] button")!;
    await act(async () => retry.click());
    expect(state.send.mock.calls.at(-1)![0].input.recheck).toBe(true);
    // The new run starts; the old failure gives way to where it runs.
    state.shells = [
      shell("coord", {
        latestRun: { runId: "run-2", status: "completed" },
        runtime: { lastError: null },
      } as unknown as Partial<EnvironmentThreadShell>),
      shell("worker"),
    ];
    await render();
    expect(container.textContent).toMatch(/Retrying on Claude Code · [^.]+\./);
  });

  it("does not leave 'Retrying on' behind when the retry's turn ended before the response", async () => {
    state.messages = [{ ...state.messages[0]!, id: "m-ended", runId: "run-ended" }];
    state.runs = [
      { id: "run-ended", ordinal: 1, status: "failed", requestedAt: "2026-11-04T12:00:00Z" },
    ];
    state.shells = [
      shell("coord", {
        latestRun: { runId: "run-ended", status: "failed" },
        runtime: { lastError: "Provider session failed to open." },
      } as unknown as Partial<EnvironmentThreadShell>),
      shell("worker"),
    ];
    let respond: (value: unknown) => void = () => {};
    state.send.mockImplementation(
      () =>
        new Promise((resolve) => {
          respond = resolve;
        }),
    );
    await render();
    const retry = container.querySelector<HTMLButtonElement>("[data-coordinator-failure] button")!;
    await act(async () => retry.click());
    // The retry's run starts and finishes before its send response lands.
    state.runs = [
      ...state.runs,
      { id: "run-2", ordinal: 2, status: "completed", requestedAt: "2026-11-04T12:01:00Z" },
    ];
    state.shells = [
      shell("coord", {
        latestRun: { runId: "run-2", status: "completed" },
        runtime: { lastError: null },
      } as unknown as Partial<EnvironmentThreadShell>),
      shell("worker"),
    ];
    await render();
    await act(async () =>
      respond({
        _tag: "Success",
        value: {
          threadId: "coord",
          created: false,
          routing: {
            selection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
            reason: "saved",
            rechecked: true,
          },
        },
      }),
    );
    await render();
    expect(container.textContent).not.toContain("Retrying on");
  });

  it("drops 'Retrying on' when the retried run fails without ever being seen working", async () => {
    state.messages = [{ ...state.messages[0]!, id: "m-straight", runId: "run-straight" }];
    state.runs = [
      { id: "run-straight", ordinal: 1, status: "failed", requestedAt: "2026-11-04T12:00:00Z" },
    ];
    state.shells = [
      shell("coord", {
        latestRun: { runId: "run-straight", status: "failed" },
        runtime: { lastError: "Provider session failed to open." },
      } as unknown as Partial<EnvironmentThreadShell>),
      shell("worker"),
    ];
    state.send.mockResolvedValue({
      _tag: "Success",
      value: {
        threadId: "coord",
        created: false,
        routing: {
          selection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
          reason: "saved",
          rechecked: true,
        },
      },
    });
    await render();
    const retry = container.querySelector<HTMLButtonElement>("[data-coordinator-failure] button")!;
    await act(async () => retry.click());
    await render();
    // The retried run arrives already failed: the client never saw it queued or running.
    state.runs = [
      ...state.runs,
      { id: "run-3", ordinal: 2, status: "failed", requestedAt: "2026-11-04T12:01:00Z" },
    ];
    state.shells = [
      shell("coord", {
        latestRun: { runId: "run-3", status: "failed" },
        runtime: { lastError: "Provider session failed to open again." },
      } as unknown as Partial<EnvironmentThreadShell>),
      shell("worker"),
    ];
    await render();
    expect(container.textContent).not.toContain("Retrying on");
    expect(container.querySelector("[data-coordinator-failure]")!.textContent).toContain(
      "failed to open again",
    );
    // Once that failure is no longer shown, the retry's routing does not come back with it.
    state.shells = [
      shell("coord", {
        latestRun: { runId: "run-3", status: "completed" },
        runtime: { lastError: null },
      } as unknown as Partial<EnvironmentThreadShell>),
      shell("worker"),
    ];
    await render();
    expect(container.querySelector("[data-coordinator-failure]")).toBeNull();
    expect(container.textContent).not.toContain("Retrying on");
  });

  it("does not ask an ordinary send to read the providers again", async () => {
    state.shells = [shell("coord"), shell("worker")];
    await render();
    await prompt("Hello");
    await enter();
    const sent = state.send.mock.calls.find((call) => call[0]?.input?.prompt === "Hello");
    expect(sent).toBeDefined();
    expect(sent![0].input.recheck).toBeUndefined();
  });

  it("still says the turn failed when the host gave no reason", async () => {
    state.shells = [failedCoordinator(null), shell("worker")];
    await render();
    expect(container.querySelector("[data-coordinator-failure]")!.textContent).toContain(
      "The coordinator could not start a turn.",
    );
  });

  it("shows nothing once the latest turn did not fail", async () => {
    state.shells = [
      shell("coord", {
        latestRun: { runId: "run-2", status: "completed" },
        runtime: { lastError: null },
      } as unknown as Partial<EnvironmentThreadShell>),
      shell("worker"),
    ];
    await render();
    expect(container.querySelector("[data-coordinator-failure]")).toBeNull();
  });
});

describe("starter tasks in a project with no threads", () => {
  const found = [
    {
      id: "changes",
      topic: "changes" as const,
      origin: "repository" as const,
      title: "Review 2 uncommitted changes",
      detail: "Work in this checkout that is not committed yet.",
      prompt: 'Start a thread titled "Review uncommitted changes". Read them.',
    },
    {
      id: "explore",
      topic: "explore" as const,
      origin: "common" as const,
      title: "Explore the codebase",
      detail: "Map the main parts.",
      prompt: 'Start a thread titled "Explore the codebase". Map this repository.',
    },
  ];
  const cards = (layout: "cards" | "list") => [
    ...container.querySelectorAll<HTMLButtonElement>(
      `.sws-starters[data-layout="${layout}"] button.sws-starter`,
    ),
  ];
  beforeEach(() => {
    state.shells = [shell("coord")];
    state.starters = { suggestions: found, hasWorkspace: true };
  });

  it("greets with three ways in and offers what the host found in the Threads pane", async () => {
    await render();
    // The coordinator's empty conversation reads like Claude's project home.
    const welcome = container.querySelector(".sws-coordinator-greeting")!;
    expect(welcome.querySelector(".sws-greeting")!.textContent).toContain(
      "Here are a few ways to begin.",
    );
    expect([...welcome.querySelectorAll(".sws-quick-start")].map((b) => b.textContent)).toEqual([
      "Set up from recent work",
      "Connect tools",
      "Make a plan",
    ]);
    // The host's project-specific ideas live in the Threads pane, not beside the greeting.
    expect(welcome.querySelector(".sws-starters")).toBeNull();
    expect(cards("list").map((card) => card.querySelector("strong")!.textContent)).toEqual([
      "Review 2 uncommitted changes",
      "Explore the codebase",
    ]);
    expect(cards("list")[0]!.textContent).toContain("From the repository");
    expect(cards("list")[1]!.textContent).toContain("Good first step");
    const pane = container.querySelector('[aria-label="Project threads"]')!;
    expect(pane.querySelector(".sws-threads-head p")!.textContent).toBe("Nothing needs you.");
    // No empty groups under the ideas: there is nothing to group yet.
    expect(pane.querySelector(".sws-group-bar")).toBeNull();
  });

  it("sends the chosen task to the coordinator, which starts the thread", async () => {
    await render();
    await act(async () => cards("list")[0]!.click());
    expect(state.send).toHaveBeenCalledOnce();
    const input = state.send.mock.calls[0]![0].input;
    expect(input.prompt).toBe(found[0]!.prompt);
    expect(input.projectId).toBe("project");
    expect(input.sourceThreadId).toBeUndefined();
    // Sent once; the other idea is still there to take.
    expect(cards("list")[0]!.disabled).toBe(true);
    expect(cards("list")[0]!.textContent).toContain("Sent to the coordinator.");
    expect(cards("list")[1]!.disabled).toBe(false);
    await act(async () => cards("list")[1]!.click());
    expect(state.send.mock.calls[1]![0].input.prompt).toBe(found[1]!.prompt);
  });

  it("keeps the task on offer and says why when it was not delivered", async () => {
    state.send.mockResolvedValueOnce({ _tag: "Failure", error: new Error("Host went away") });
    await render();
    await act(async () => cards("list")[0]!.click());
    expect(alertText()).toBe("Host went away");
    expect(cards("list")[0]!.disabled).toBe(false);
    await act(async () => cards("list")[0]!.click());
    // The retry is the same request, so the coordinator cannot be asked twice.
    expect(state.send.mock.calls[1]![0].input.commandId).toBe(
      state.send.mock.calls[0]![0].input.commandId,
    );
    expect(cards("list")[0]!.disabled).toBe(true);
  });

  it("keeps a task marked sent after a reload, from the coordinator thread", async () => {
    state.messages = [
      {
        id: "m1",
        role: "user",
        createdBy: "user",
        runId: "run-1",
        text: found[0]!.prompt,
        streaming: false,
        attachments: [],
      },
    ];
    await render();
    // The greeting gives way to the conversation; the Threads pane keeps the list.
    expect(cards("list")[0]!.disabled).toBe(true);
    expect(cards("list")[0]!.textContent).toContain("Sent to the coordinator.");
    expect(cards("list")[1]!.disabled).toBe(false);
  });

  it("offers the task again when the coordinator's turn for it failed", async () => {
    await render();
    await act(async () => cards("list")[0]!.click());
    expect(cards("list")[0]!.disabled).toBe(true);
    expect(container.textContent).toContain("Queued for the coordinator.");
    // The host echoes the message, then its run fails to open a provider session.
    state.messages = [
      {
        id: "m1",
        role: "user",
        createdBy: "user",
        runId: "run-1",
        text: found[0]!.prompt,
        streaming: false,
        attachments: [],
      },
    ];
    state.shells = [
      shell("coord", {
        latestRun: { runId: "run-1", status: "failed" },
        runtime: { lastError: "You have reached your weekly usage limit." },
      } as unknown as Partial<EnvironmentThreadShell>),
    ];
    await render();
    expect(cards("list")[0]!.disabled).toBe(false);
    expect(cards("list")[0]!.textContent).not.toContain("Sent to the coordinator.");
    expect(container.textContent).not.toContain("Queued for the coordinator.");
    await act(async () => cards("list")[0]!.click());
    expect(state.send).toHaveBeenCalledTimes(2);
  });

  it("offers nothing, and asks the host nothing, once the project has a thread", async () => {
    state.shells = [shell("coord"), shell("worker")];
    await render();
    expect(container.querySelector(".sws-starters")).toBeNull();
    expect(state.starterReads).toBe(0);
    expect(container.querySelector(".sws-group-bar")).not.toBeNull();
  });

  it("greets nobody while the workspace read is pending, so a conversation is never covered", async () => {
    // The project shell already names a coordinator; its history arrives with the read.
    state.projectReadPending = true;
    Object.assign(state.project, { workspaceSettings: { coordinatorThreadId: "coord" } });
    try {
      await render();
      expect(container.querySelector(".sws-coordinator-greeting")).toBeNull();
      expect(container.querySelector(".sws-quick-start")).toBeNull();
    } finally {
      delete (state.project as { workspaceSettings?: unknown }).workspaceSettings;
    }
  });

  it("greets a project known to have no coordinator yet", async () => {
    state.coordinatorId = null;
    state.shells = [];
    await render();
    expect(container.querySelector(".sws-greeting")!.textContent).toBe(
      "Hi there,Excited to get started on Atlas. Here are a few ways to begin.",
    );
  });

  it("keeps the ideas in the Threads pane after the coordinator has been spoken to", async () => {
    state.messages = [
      {
        id: "m1",
        text: "Hello",
        role: "user",
        createdBy: "user",
        streaming: false,
        attachments: [],
      },
    ];
    await render();
    expect(container.querySelector(".sws-coordinator-greeting")).toBeNull();
    expect(cards("list")).toHaveLength(2);
  });

  it("holds the space while the host is reading the project", async () => {
    state.starters = null;
    state.startersPending = true;
    await render();
    const section = container.querySelector('.sws-starters[data-layout="list"]')!;
    expect(section.getAttribute("aria-busy")).toBe("true");
    expect(section.querySelectorAll("button")).toHaveLength(0);
    expect(section.querySelectorAll(".sws-starter-pending").length).toBeGreaterThan(0);
  });

  it("falls back to the general steps and the goal when the host cannot answer", async () => {
    state.starters = null;
    state.startersError = "Unknown method";
    state.goal = "Ship the importer";
    await render();
    expect(cards("list").map((card) => card.querySelector("strong")!.textContent)).toEqual([
      "Plan the first steps toward the goal",
      "Explore the codebase",
      "Write project memory",
      "Set up a routine",
    ]);
    expect(cards("list")[0]!.textContent).toContain("Ship the importer");
  });

  it("shows the ideas but sends none while the host is disconnected", async () => {
    state.connected = false;
    await render();
    expect(cards("list").every((card) => card.disabled)).toBe(true);
    expect(container.querySelector(".sws-starter-note")!.textContent).not.toBe("");
    await act(async () => cards("list")[0]!.click());
    expect(state.send).not.toHaveBeenCalled();
  });

  it("asks for a coordinator model before a first task can start one", async () => {
    // A brand new project: no coordinator thread yet, and nothing chosen to run one on.
    state.coordinatorId = null;
    state.coordinatorModel = null;
    state.shells = [];
    Object.assign(state.project, { defaultModelSelection: null });
    await render();
    expect(cards("list")[0]!.disabled).toBe(true);
    expect(container.querySelector(".sws-starter-note")!.textContent).toBe(
      "Choose a coordinator model to start one of these.",
    );
  });

  it("says why Enter did not send when no coordinator model is chosen", async () => {
    state.coordinatorId = null;
    state.coordinatorModel = null;
    state.shells = [];
    Object.assign(state.project, { defaultModelSelection: null });
    await render();
    await prompt("Build the project");
    const input = container.querySelector<HTMLTextAreaElement>("#project-prompt")!;
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => {
      input.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(state.send).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(
      "Choose and save a coordinator or worker model in project settings first.",
    );
  });

  it("does not ask for a coordinator model while the host's models load", async () => {
    state.coordinatorId = null;
    state.coordinatorModel = null;
    state.shells = [];
    state.serverConfigPending = true;
    Object.assign(state.project, { defaultModelSelection: null });
    await render();
    expect(cards("list")[0]!.disabled).toBe(true);
    expect(container.querySelector(".sws-starter-note")!.textContent).toBe(
      "Models are still loading from this host.",
    );
    expect(container.textContent).not.toContain("Choose a coordinator model");
  });

  it("does not ask for a coordinator model while the host checks its providers", async () => {
    state.coordinatorId = null;
    state.coordinatorModel = null;
    state.shells = [];
    // Right after a restart the host sends its config with a placeholder Claude.
    state.providers = [
      {
        instanceId: "claudeAgent",
        driver: "claudeAgent",
        enabled: true,
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        models: [],
      },
    ];
    Object.assign(state.project, { defaultModelSelection: null });
    await render();
    expect(cards("list")[0]!.disabled).toBe(true);
    expect(container.querySelector(".sws-starter-note")!.textContent).toBe(
      "Models are still loading from this host.",
    );
    expect(container.textContent).not.toContain("Choose a coordinator model");
  });

  it("returns a phone to the coordinator after a task is picked in the Threads pane", async () => {
    state.phone = true;
    await render();
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".sws-overview-toggle")!.click(),
    );
    await act(async () => cards("list")[0]!.click());
    expect(state.send).toHaveBeenCalledOnce();
    expect(container.querySelector('[aria-label="Project threads"]')).toBeNull();
  });

  it("reaches the first idea with F6 when there are no thread groups", async () => {
    await render();
    container.querySelector<HTMLTextAreaElement>("#project-prompt")!.focus();
    const first = cards("list")[0]!;
    Object.defineProperty(first, "offsetParent", { configurable: true, get: () => document.body });
    first.getBoundingClientRect = () => ({ right: 10 }) as DOMRect;
    await press({ key: "F6" });
    expect(document.activeElement).toBe(first);
  });
});

describe("a project that is not loaded", () => {
  it("waits for the hosts before calling the project unavailable", async () => {
    state.projectLoaded = false;
    state.shellsBootstrapped = false;
    await render();
    expect(container.textContent).not.toContain("Project unavailable");
    expect(container.textContent).toContain("Loading project");
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();

    // The saved hosts can settle before this computer's own host is known.
    state.shellsBootstrapped = true;
    state.primaryRegistered = false;
    await render();
    expect(container.textContent).not.toContain("Project unavailable");
    expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();

    state.projectLoaded = true;
    state.primaryRegistered = true;
    await render();
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(container.querySelector("#project-prompt")).not.toBeNull();
  });

  it("opens a project linked by its machine and path after the repository key replaced it", async () => {
    const moved = vi.fn();
    await act(async () =>
      root.render(<ProjectWorkspace projectKey="host:/scratch/atlas" onProjectKeyMoved={moved} />),
    );
    expect(container.textContent).not.toContain("Project unavailable");
    expect(container.querySelector("#project-prompt")).not.toBeNull();
    expect(moved).toHaveBeenCalledWith("atlas");
  });

  it("says so once every host has answered without it", async () => {
    state.projectLoaded = false;
    await render();
    expect(container.textContent).toContain("Project unavailable");
  });
});

describe("open in new window", () => {
  // The action lives in the project's "More" menu, which renders outside the container.
  const item = async () => {
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '.project-header-actions [aria-label="More project actions"]',
        )!
        .click(),
    );
    return (
      [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find((element) =>
        element.textContent?.includes("Open in new window"),
      ) ?? null
    );
  };

  it("opens this project in its own desktop window", async () => {
    const openProjectWindow = vi.fn(async () => undefined);
    window.desktopBridge = { openProjectWindow } as unknown as NonNullable<
      typeof window.desktopBridge
    >;
    await render();
    const open = await item();
    expect(open).not.toBeNull();
    await act(async () => open!.click());
    expect(openProjectWindow).toHaveBeenCalledExactlyOnceWith({
      projectKey: "atlas",
      title: "Atlas",
    });
    expect(state.navigate).not.toHaveBeenCalled();
  });

  it("offers nothing inside the project's own window", async () => {
    window.desktopBridge = {
      openProjectWindow: vi.fn(),
      getWindowProjectKey: () => "atlas",
    } as unknown as NonNullable<typeof window.desktopBridge>;
    await render();
    expect(await item()).toBeNull();
    expect(document.querySelector('[role="menuitem"]')).not.toBeNull();
  });

  it("still offers it for another project viewed in a project window", async () => {
    window.desktopBridge = {
      openProjectWindow: vi.fn(),
      getWindowProjectKey: () => "orbit",
    } as unknown as NonNullable<typeof window.desktopBridge>;
    await render();
    expect(await item()).not.toBeNull();
  });

  it("offers nothing in the browser", async () => {
    await render();
    expect(await item()).toBeNull();
    expect(document.querySelector('[role="menuitem"]')).not.toBeNull();
  });

  it("offers nothing on a desktop build without project windows", async () => {
    window.desktopBridge = {} as unknown as NonNullable<typeof window.desktopBridge>;
    await render();
    expect(await item()).toBeNull();
    expect(document.querySelector('[role="menuitem"]')).not.toBeNull();
  });
});

describe("coordinator progress", () => {
  it("replaces Queued with what the coordinator is doing, then clears when its turn ends", async () => {
    await render();
    await prompt("Plan the finance feature");
    await click("Send");
    expect(container.textContent).toContain("Queued for the coordinator.");
    // The host accepted the message and queued the coordinator's turn.
    const requestedAt = new Date(Date.now() - 3_000).toISOString();
    state.runs = [{ id: "run-1", ordinal: 1, status: "queued", requestedAt }];
    await render();
    const line = () => container.querySelector(".sws-coordinator-working");
    expect(line()?.textContent).toMatch(/^Starting the coordinator…\d+s$/);
    expect(container.textContent).not.toContain("Queued for the coordinator.");
    state.runs = [{ id: "run-1", ordinal: 1, status: "running", requestedAt }];
    state.turnItems = [
      { runId: "run-1", ordinal: 2, type: "reasoning", status: "completed" },
      {
        runId: "run-1",
        ordinal: 3,
        type: "dynamic_tool",
        status: "running",
        toolName: "mcp__studio-code__delegate_task",
      },
    ];
    await render();
    expect(line()?.textContent).toContain("Starting a worker…");
    expect(line()?.getAttribute("role")).toBe("status");
    state.runs = [{ id: "run-1", ordinal: 1, status: "completed", requestedAt }];
    await render();
    expect(line()).toBeNull();
    // A finished turn does not bring the Queued notice back.
    expect(container.textContent).not.toContain("Queued for the coordinator.");
  });

  it("does not leave Queued behind a send made while the coordinator is already working", async () => {
    const requestedAt = new Date(Date.now() - 3_000).toISOString();
    state.runs = [{ id: "run-1", ordinal: 1, status: "running", requestedAt }];
    await render();
    await prompt("One more thing");
    await click("Send");
    // The coordinator was already working, so its live line stands in for the receipt.
    expect(container.querySelector(".sws-coordinator-working")).not.toBeNull();
    expect(container.textContent).not.toContain("Queued for the coordinator.");
    state.runs = [{ id: "run-1", ordinal: 1, status: "completed", requestedAt }];
    await render();
    expect(container.querySelector(".sws-coordinator-working")).toBeNull();
    expect(container.textContent).not.toContain("Queued for the coordinator.");
  });

  it("gives way to the failure notice when the turn failed", async () => {
    state.runs = [
      { id: "run-1", ordinal: 1, status: "running", requestedAt: new Date().toISOString() },
    ];
    state.shells = [
      shell("coord", {
        latestRun: { runId: "run-1", status: "failed" },
        runtime: { lastError: "You have reached your weekly usage limit." },
      } as unknown as Partial<EnvironmentThreadShell>),
    ];
    await render();
    expect(container.querySelector(".sws-coordinator-working")).toBeNull();
    expect(container.querySelector("[data-coordinator-failure]")).not.toBeNull();
  });
});

describe("a coordinator whose provider is not prepared on its machine", () => {
  const unprepared =
    "ACP Registry agent 'github-copilot-cli' has not been prepared on this environment.";
  const hostText = `Copilot · Auto cannot run on this machine: ${unprepared} No other provider has room to run the coordinator instead. Open Settings > Providers > Copilot on that machine and choose Install / update agent, or choose another coordinator model.`;
  beforeEach(async () => {
    const { DEFAULT_SERVER_SETTINGS } = await import("@specweave-studio/contracts");
    state.providers = [
      {
        instanceId: "copilot",
        driver: "acpRegistry",
        displayName: "GitHub Copilot",
        enabled: true,
        installed: false,
        status: "error",
        auth: { status: "unknown" },
        checkedAt: "2026-11-04T12:00:00Z",
        version: null,
        message: unprepared,
        models: [{ slug: "auto", name: "Auto", isCustom: false, capabilities: null }],
        slashCommands: [],
        skills: [],
      },
    ];
    state.hostSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providerInstances: {
        copilot: {
          driver: "acpRegistry",
          enabled: true,
          config: { source: "registry", agentId: "github-copilot-cli" },
        },
      },
    };
    state.messages = [
      {
        id: "m1",
        role: "user",
        createdBy: "user",
        runId: "run-1",
        text: "Plan the week",
        streaming: false,
        attachments: [],
      },
    ];
    state.runs = [
      {
        id: "run-1",
        ordinal: 1,
        status: "failed",
        requestedAt: "2026-11-04T12:00:00Z",
        modelSelection: { instanceId: "copilot", model: "auto" },
      },
    ];
    state.shells = [
      shell("coord", {
        modelSelection: { instanceId: "copilot", model: "auto" },
        latestRun: { runId: "run-1", status: "failed" },
        runtime: { lastError: hostText, lastErrorClass: "provider_error" },
      } as unknown as Partial<EnvironmentThreadShell>),
      shell("worker"),
    ];
  });

  it("names the machine and installs the agent there in one click, then offers a retry", async () => {
    await render();
    const alert = container.querySelector("[data-coordinator-failure]")!;
    const body = alert.querySelector("[data-coordinator-failure-body]")!.textContent!;
    expect(body).toContain("cannot run on Test host");
    expect(body).toContain("Copilot on Test host");
    expect(body).not.toMatch(/(this|that) machine/);
    const install = alert.querySelector<HTMLButtonElement>("[data-coordinator-fix='install']")!;
    expect(install.textContent).toBe("Install Copilot on Test host");
    await act(async () => install.click());
    const calls = state.send.mock.calls.map((call) => call[0]);
    expect(calls).toContainEqual({
      environmentId: "host",
      input: { agentId: "github-copilot-cli" },
    });
    expect(calls).toContainEqual({
      environmentId: "host",
      input: { instanceId: "copilot", refreshModels: true },
    });
    await render();
    expect(alert.querySelector("[data-coordinator-fix-done]")!.textContent).toBe(
      "Installed. Retry to send it again.",
    );
    expect(
      [...alert.querySelectorAll("button")].some((b) => b.textContent === "Retry last message"),
    ).toBe(true);
  });

  it("drops 'Installed' once a later run fails for another reason, with no fix button", async () => {
    await render();
    const alert = () => container.querySelector("[data-coordinator-failure]")!;
    await act(async () =>
      alert().querySelector<HTMLButtonElement>("[data-coordinator-fix='install']")!.click(),
    );
    await render();
    expect(alert().querySelector("[data-coordinator-fix-done]")).not.toBeNull();
    // Copilot now runs, and the next turn hits its usage limit instead.
    state.providers = [
      {
        ...(state.providers[0] as object),
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        message: null,
      },
    ];
    state.runs = [
      ...state.runs,
      {
        id: "run-2",
        ordinal: 2,
        status: "failed",
        requestedAt: "2026-11-04T12:05:00Z",
        modelSelection: { instanceId: "copilot", model: "auto" },
      },
    ];
    state.shells = [
      shell("coord", {
        modelSelection: { instanceId: "copilot", model: "auto" },
        latestRun: { runId: "run-2", status: "failed" },
        runtime: {
          lastError: "You have reached your monthly usage limit.",
          lastErrorClass: "usage_limit",
        },
      } as unknown as Partial<EnvironmentThreadShell>),
      shell("worker"),
    ];
    await render();
    expect(alert().querySelector("[data-coordinator-failure-body]")!.textContent).toContain(
      "has no usage left",
    );
    expect(alert().textContent).not.toContain("Installed");
    expect(alert().querySelector("[data-coordinator-fix]")).toBeNull();
    expect(alert().querySelector("[data-coordinator-fix-done]")).toBeNull();
  });

  it("says Retry should work once a usage limit's reset has passed", async () => {
    state.providers = [
      {
        ...(state.providers[0] as object),
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        message: null,
      },
    ];
    state.shells = [
      shell("coord", {
        modelSelection: { instanceId: "copilot", model: "auto" },
        latestRun: { runId: "run-1", status: "failed" },
        runtime: {
          lastError: "You have reached your monthly usage limit.",
          lastErrorClass: "usage_limit",
          usageLimitResetAt: "2020-01-01T00:00:00.000Z",
        },
      } as unknown as Partial<EnvironmentThreadShell>),
      shell("worker"),
    ];
    await render();
    const body = container.querySelector("[data-coordinator-failure-body]")!.textContent!;
    expect(body).toMatch(/hit its usage limit\. The limit reset \w{3} .+, so Retry should work\./);
    expect(body).not.toContain("no usage left");
    expect(container.querySelector("[data-coordinator-failure] [data-coordinator-fix]")).toBeNull();
  });

  it("offers provider setup for a signed-out provider instead of an install", async () => {
    state.providers = [
      {
        ...(state.providers[0] as object),
        installed: true,
        status: "ready",
        auth: { status: "unauthenticated" },
        message: "Copilot is not signed in.",
      },
    ];
    await render();
    const action = container.querySelector<HTMLButtonElement>(
      "[data-coordinator-failure] [data-coordinator-fix]",
    )!;
    expect(action.dataset.coordinatorFix).toBe("sign-in");
    expect(action.textContent).toBe("Sign in to Copilot on Test host");
    await act(async () => action.click());
    expect(state.navigate).toHaveBeenCalledWith({
      to: "/settings/providers",
      search: { environmentId: "host", instanceId: "copilot" },
    });
  });

  it("shows the same fix beside a send the host refused", async () => {
    state.shells = [
      shell("coord", {
        modelSelection: { instanceId: "copilot", model: "auto" },
      } as unknown as Partial<EnvironmentThreadShell>),
      shell("worker"),
    ];
    state.runs = [];
    state.coordinatorModel = { instanceId: "copilot", model: "auto" };
    state.send.mockImplementation(async (request: { input?: { prompt?: string } }) =>
      request.input?.prompt === "Hello"
        ? { _tag: "Failure", error: new Error(hostText) }
        : { _tag: "Success", value: { threadId: "coord", created: false } },
    );
    await render();
    await prompt("Hello");
    await enter();
    const text = alertText();
    expect(text).toContain("cannot run on Test host");
    expect(text).not.toMatch(/(this|that) machine/);
    const install = [
      ...container.querySelectorAll<HTMLButtonElement>("[role='alert'] button"),
    ].find((button) => button.dataset.coordinatorFix === "install");
    expect(install?.textContent).toBe("Install Copilot on Test host");
  });
});
