// @vitest-environment jsdom
import * as DateTime from "effect/DateTime";
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import * as FileSystem from "effect/FileSystem";
import * as Effect from "effect/Effect";
import { act } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { DEFAULT_SERVER_SETTINGS } from "@specweave-studio/contracts";
import { setConversationFindState } from "../find/conversationFindStore";
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import {
  recreateRoot,
  state,
  root,
  container,
  shell,
  repoFile,
  render,
  openFirstThread,
  press,
  click,
  prompt,
} from "./ProjectWorkspace.test-fixtures";

describe("project coordinator surface", () => {
  it("keeps a thread's meta on one line: model first, its error last", async () => {
    state.shells = [
      shell("coord"),
      shell("worker", { runtime: { lastError: "You have hit your usage limit" } } as never),
    ];
    await render();
    const meta = container.querySelector("[data-thread-id='worker'] .sws-thread-meta")!;
    // The lead (status, model) never gives way; the rest shrinks after it.
    const parts = [...meta.children].flatMap((group) => [...group.children]);
    expect(meta.firstElementChild?.matches(".sws-thread-meta-lead")).toBe(true);
    expect(parts[0]?.matches("[data-model-badge]")).toBe(true);
    expect(parts.at(-1)?.textContent).toBe("You have hit your usage limit");
    // A project on one machine leaves the machine to the composer.
    expect(meta.querySelector(".sws-thread-machine")).toBeNull();
  });
  it("names where a thread lives and runs once its execution moved", async () => {
    state.shells = [
      shell("coord"),
      shell("worker", {
        source: {
          ownerMachineId: "host",
          executionMachineId: "minis",
          executionMachineLabel: "Anton's Minis",
          executionState: "running",
        },
      } as never),
    ];
    await render();
    const chip = container.querySelector("[data-thread-id='worker'] .sws-thread-machine")!;
    expect(chip.querySelector("span[aria-hidden='true']")?.textContent).toBe("Test host → Minis");
    expect(chip.querySelector(".sr-only")?.textContent).toBe(
      "Lives on Test host · runs on Anton's Minis",
    );
    expect(chip.getAttribute("data-moved")).toBe("true");
    expect(container.querySelector("[data-thread-id='coord'] .sws-thread-machine")).toBeNull();
  });
  it("names the model the coordinator is on, then the pick, when the limit rule moved it", async () => {
    const saved = { instanceId: "claudeAgent", model: "claude-opus-5-5" };
    Object.assign(state.project, { workspaceSettings: { coordinatorModelSelection: saved } });
    state.shells = [
      shell("coord", { modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" } } as never),
    ];
    state.hostSettings = DEFAULT_SERVER_SETTINGS;
    const resetsAt = new Date(Date.now() + 39.5 * 3_600_000).toISOString();
    const claude = (weeklyUsed: number) => ({
      instanceId: "claudeAgent",
      driver: "claudeAgent",
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
      models: [{ slug: "claude-opus-5-5", name: "Opus 5.5", isCustom: false }],
      usageLimits: {
        checkedAt: new Date().toISOString(),
        windows: [
          { id: "five_hour", kind: "session", label: "Session", usedPercent: 0, resetsAt },
          { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: weeklyUsed, resetsAt },
        ],
      },
    });
    const codex = {
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      status: "ready",
      auth: { status: "authenticated" },
      models: [{ slug: "gpt-6.1-sol", name: "GPT-6.1 Sol", isCustom: false }],
    };
    try {
      // Claude reads as having room: the coordinator is still on Codex, so the line
      // names Codex and the pick, and claims no limit it cannot read.
      state.providers = [claude(20), codex];
      await render();
      const room = container.querySelector("p[data-model-fallback]");
      // One line, only because the pick has room again: what to do, not what happened.
      expect(room?.textContent).toContain("Your pick, Claude Code · Opus 5.5, has room again.");
      expect(room?.textContent).not.toContain("limit");
      expect(
        container.querySelector("[data-coordinator-model]")?.getAttribute("data-running-instance"),
      ).toBe("codex");
      expect(
        container.querySelector("[data-coordinator-model]")?.hasAttribute("data-returns-to"),
      ).toBe(false);
      // The saved model runs the next turn once asked; the host decides if it has room.
      state.send.mockClear();
      await click("Switch back to Claude Code");
      expect(state.send).toHaveBeenCalledWith(
        expect.objectContaining({ input: { threadId: "coord", modelSelection: saved } }),
      );
      // The weekly is spent: the session's room cannot be used, so the limit is real. The
      // picker says it once (its suffix and header); no line repeats it.
      state.providers = [claude(100), codex];
      await render();
      expect(container.querySelector("p[data-model-fallback]")).toBeNull();
      const picker = container.querySelector("[data-coordinator-model]");
      expect(picker?.getAttribute("data-running-instance")).toBe("codex");
      expect(picker?.getAttribute("data-returns-to")).toBe("Claude Code");
      expect(picker?.textContent).toBe("gpt-6.1-sol");
      // The project runs on another machine than this one, and its header says so.
      expect(container.querySelector("[data-project-machine]")).not.toBeNull();
    } finally {
      Object.assign(state.project, { workspaceSettings: undefined });
    }
  });
  it("shows the retained coordinator model when its override is cleared", async () => {
    state.coordinatorModel = null;
    await render();
    // The picker sits under the composer, where the model is read while writing.
    const picker = container.querySelector(".sws-composer [data-coordinator-model]");
    expect(picker?.textContent).toBe("chosen-model");
  });
  it("shows the host's default model when nobody has chosen one", async () => {
    state.coordinatorModel = null;
    state.coordinatorId = null as never;
    state.shells = [];
    Object.assign(state.project, { defaultModelSelection: null });
    state.providers = [
      {
        instanceId: "claudeAgent",
        driver: "claudeAgent",
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        models: [
          { slug: "claude-sonnet-5-5", name: "Sonnet 5.5", isCustom: false, isDefault: true },
          { slug: "claude-opus-5-5", name: "Opus 5.5", isCustom: false, isDefault: false },
        ],
      },
    ];
    await render();
    expect(container.querySelector("[data-coordinator-model]")?.textContent).toBe(
      "claude-opus-5-5",
    );
  });
  it("names a model for a project from before workspace settings and enables it once read", async () => {
    // Shaped like an old project row: no workspace settings and no worker default.
    delete (state.project as { workspaceSettings?: unknown }).workspaceSettings;
    Object.assign(state.project, { defaultModelSelection: null });
    state.coordinatorModel = null;
    state.coordinatorId = null;
    state.shells = [];
    state.providers = [
      {
        instanceId: "claudeAgent",
        driver: "claudeAgent",
        enabled: true,
        installed: true,
        status: "ready",
        auth: { status: "authenticated" },
        models: [{ slug: "claude-opus-5-5", name: "Opus 5.5", isCustom: false, isDefault: true }],
      },
    ];
    state.projectReadPending = true;
    await render();
    const picker = () => container.querySelector("[data-coordinator-model]")!;
    expect(picker().textContent).toBe("claude-opus-5-5");
    expect(picker().getAttribute("data-disabled")).toBe("true");
    state.projectReadPending = false;
    await render();
    expect(picker().textContent).toBe("claude-opus-5-5");
    expect(picker().getAttribute("data-disabled")).toBe("false");
  });
  it("names the coordinator thread's model before the worker default", async () => {
    state.coordinatorModel = null;
    state.shells = [
      shell("coord", {
        modelSelection: { instanceId: "claude-native", model: "thread-model" },
      } as never),
    ];
    await render();
    expect(container.querySelector("[data-coordinator-model]")?.textContent).toBe("thread-model");
  });
  it("leaves the project's goal to settings instead of the top of the project", async () => {
    state.goal = "Ship the Atlas importer";
    await render();
    expect(container.querySelector("[data-project-pane='coordinator']")).not.toBeNull();
    expect(container.textContent).not.toContain("Ship the Atlas importer");
    expect(container.querySelector("button[aria-label='Edit project goal']")).toBeNull();
    // The operator docs describe the same project view.
    const docPath = await repoFile("docs/studio/project-orchestration.md");
    const docs = await Effect.runPromise(
      Effect.flatMap(FileSystem.FileSystem, (fs) => fs.readFileString(docPath)).pipe(
        Effect.provide(NodeFileSystem.layer),
      ),
    );
    expect(docs).not.toMatch(/goal in a strip|strip above the conversation/i);
    expect(docs).toContain("Set or edit it under **Goal** in the project settings");
  });
  it("waits for a picked coordinator model before a worker reply can dispatch", async () => {
    let finish!: (result: unknown) => void;
    state.send.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    await render();
    await openFirstThread();
    await prompt("Keep this draft");
    let sent!: Promise<void>;
    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-coordinator-model]")!.click();
      sent = state.routing!.send("Continue this worker");
    });
    expect(state.send).toHaveBeenCalledTimes(1);
    expect(container.querySelector<HTMLButtonElement>(".sws-send")!.disabled).toBe(true);
    expect(state.send.mock.calls[0]![0].input.workspaceSettings).toEqual({
      expectedRevision: 1,
      coordinatorModelSelection: { instanceId: "codex-native", model: "picked-model" },
    });
    await act(async () => {
      finish({ _tag: "Success" });
      await sent;
    });
    expect(state.send.mock.calls[1]![0].input).toMatchObject({
      projectId: "project",
      sourceThreadId: "worker",
      prompt: "Continue this worker",
    });
    expect(state.refresh).toHaveBeenCalled();
  });
  it("names the provider model on every thread row and groups them by state", async () => {
    state.shells = [
      shell("coord"),
      shell("ask", { hasPendingUserInput: true }),
      shell("worker"),
      shell("done", { settledOverride: "settled" }),
    ];
    await render();
    const groups = [...container.querySelectorAll(".sws-thread-group")].map((group) => [
      group.getAttribute("data-group"),
      group.querySelectorAll(".sws-thread-row").length,
    ]);
    // Finished work stays folded until it is asked for.
    expect(groups).toEqual([
      ["Waiting on you", 1],
      ["Working", 0],
      ["Waiting", 0],
      ["Unavailable", 0],
      ["Idle", 1],
      ["Resolved", 0],
    ]);
    expect(container.querySelector(".sws-threads-head")?.textContent).toContain(
      "1 waiting on you.",
    );
    expect(container.querySelector(".sws-thread-status")?.textContent).toBe("Answer needed");
    const resolved = container.querySelector<HTMLButtonElement>(
      '[data-group="Resolved"] .sws-group-bar',
    )!;
    expect(resolved.getAttribute("aria-expanded")).toBe("false");
    await act(async () => resolved.click());
    expect(resolved.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelectorAll(".sws-thread-row [data-model-badge]")).toHaveLength(3);
  });
  it("unfolds Resolved when a thread is resolved from its row", async () => {
    state.shells = [shell("coord"), shell("worker"), shell("done", { settledOverride: "settled" })];
    await render();
    expect(container.querySelector('[data-group="Resolved"] .sws-thread-row')).toBeNull();
    const resolve = container.querySelector<HTMLButtonElement>(
      '[data-group="Idle"] .sws-thread-action',
    )!;
    await act(async () => resolve.click());
    expect(
      container
        .querySelector('[data-group="Resolved"] .sws-group-bar')
        ?.getAttribute("aria-expanded"),
    ).toBe("true");
  });
  it("pages a long group behind Show more", async () => {
    state.shells = [shell("coord"), ...Array.from({ length: 8 }, (_, i) => shell(`w${i}`))];
    await render();
    expect(container.querySelectorAll(".sws-thread-row")).toHaveLength(5);
    await act(async () => container.querySelector<HTMLButtonElement>(".sws-show-more")!.click());
    expect(container.querySelectorAll(".sws-thread-row")).toHaveLength(8);
    await click("Show fewer");
    expect(container.querySelectorAll(".sws-thread-row")).toHaveLength(5);
  });
  it("toggles the overview pane from its button and its shortcut", async () => {
    await render();
    const toggle = () => container.querySelector<HTMLButtonElement>(".sws-overview-toggle")!;
    expect(toggle().getAttribute("aria-pressed")).toBe("true");
    expect(container.querySelector('[aria-label="Project threads"]')).not.toBeNull();
    await act(async () => toggle().click());
    expect(toggle().getAttribute("aria-pressed")).toBe("false");
    expect(container.querySelector('[aria-label="Project threads"]')).toBeNull();
    expect(container.querySelector('[aria-label="Project coordinator"]')).not.toBeNull();
    await act(async () => toggle().click());
    expect(container.querySelector('[aria-label="Project threads"]')).not.toBeNull();
  });
  it("focuses thread search on slash and leaves an open thread on Escape", async () => {
    await render();
    await press({ key: "/" });
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Find a project thread");
    (document.activeElement as HTMLElement).blur();
    await openFirstThread();
    expect(container.querySelector('[data-native-thread="worker"]')).not.toBeNull();
    await press({ key: "Escape" });
    expect(container.querySelector('[data-native-thread="worker"]')).toBeNull();
    expect(container.querySelector('[aria-label="Project threads"]')).not.toBeNull();
  });
  it("keeps thread search behind its button until asked for", async () => {
    await render();
    const find = () => container.querySelector<HTMLInputElement>(".sws-find input");
    const toggle = () =>
      container.querySelector<HTMLButtonElement>('.sws-threads-bar [aria-label="Find a thread"]')!;
    expect(find()).toBeNull();
    expect(toggle().getAttribute("aria-expanded")).toBe("false");
    await act(async () => toggle().click());
    expect(find()).not.toBeNull();
    expect(toggle().getAttribute("aria-expanded")).toBe("true");
    await act(async () => toggle().click());
    expect(find()).toBeNull();
  });
  it("sends on Enter and keeps Shift+Enter for a new line", async () => {
    await render();
    await prompt("Build the project");
    const input = container.querySelector<HTMLTextAreaElement>("#project-prompt")!;
    const key = (init: KeyboardEventInit) =>
      act(async () => {
        input.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init }),
        );
      });
    await key({ shiftKey: true });
    expect(state.send).not.toHaveBeenCalled();
    await key({});
    expect(state.send).toHaveBeenCalledTimes(1);
    expect(state.send.mock.calls[0]![0].input.prompt).toBe("Build the project");
  });
  it("sends on Enter in a narrow desktop window, never on a phone keyboard", async () => {
    // A desktop window squeezed under the phone width still has a hardware keyboard.
    state.phone = true;
    await render();
    await prompt("Build the project");
    const input = container.querySelector<HTMLTextAreaElement>("#project-prompt")!;
    const enter = () =>
      act(async () => {
        input.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
        );
      });
    await enter();
    expect(state.send).toHaveBeenCalledTimes(1);
    state.send.mockClear();
    // On a phone the Return key is the on-screen keyboard's new line.
    state.coarse = true;
    await render();
    await prompt("Build the project");
    const phoneInput = container.querySelector<HTMLTextAreaElement>("#project-prompt")!;
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => {
      phoneInput.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(state.send).not.toHaveBeenCalled();
  });
  it("keeps Return for a new line on a landscape phone or tablet keyboard", async () => {
    // Wider than the phone layout, but the keyboard is still on the glass.
    state.coarse = true;
    await render();
    await prompt("Build the project");
    const input = container.querySelector<HTMLTextAreaElement>("#project-prompt")!;
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => {
      input.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(false);
    expect(state.send).not.toHaveBeenCalled();
  });
  it("keeps Enter for the input method while it composes, and sends on Cmd/Ctrl+Enter", async () => {
    await render();
    await prompt("こんにちは");
    const input = container.querySelector<HTMLTextAreaElement>("#project-prompt")!;
    const key = async (init: KeyboardEventInit, keyCode?: number) => {
      const event = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
        ...init,
      });
      if (keyCode !== undefined) Object.defineProperty(event, "keyCode", { value: keyCode });
      await act(async () => {
        input.dispatchEvent(event);
      });
      return event;
    };
    expect((await key({ isComposing: true })).defaultPrevented).toBe(false);
    expect((await key({}, 229)).defaultPrevented).toBe(false);
    expect(state.send).not.toHaveBeenCalled();
    await key({ metaKey: true });
    expect(state.send).toHaveBeenCalledTimes(1);
    await prompt("again");
    await key({ ctrlKey: true });
    expect(state.send).toHaveBeenCalledTimes(2);
  });
  it("does not send on Enter while the Send button is disabled", async () => {
    state.connected = false;
    await render();
    await prompt("New work");
    const input = container.querySelector<HTMLTextAreaElement>("#project-prompt")!;
    const event = new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    await act(async () => {
      input.dispatchEvent(event);
    });
    // The key is still the send key, so no stray new line lands in the message.
    expect(event.defaultPrevented).toBe(true);
    expect(state.send).not.toHaveBeenCalled();
  });
  it("waits for the modifier when the person's send shortcut asks for one", async () => {
    state.sendShortcut = "mod-enter";
    await render();
    await prompt("Build the project");
    const input = container.querySelector<HTMLTextAreaElement>("#project-prompt")!;
    const key = (init: KeyboardEventInit) =>
      act(async () => {
        input.dispatchEvent(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true, ...init }),
        );
      });
    await key({});
    expect(state.send).not.toHaveBeenCalled();
    await key({ metaKey: true });
    await key({ ctrlKey: true });
    expect(state.send).toHaveBeenCalledTimes(1);
  });
  it("starts a phone on the coordinator and leaves the wide layout's choice alone", async () => {
    state.phone = true;
    await render();
    expect(container.querySelector('[aria-label="Project threads"]')).toBeNull();
    expect(container.querySelector("#project-prompt")).not.toBeNull();
    await act(async () =>
      container.querySelector<HTMLButtonElement>(".sws-overview-toggle")!.click(),
    );
    expect(container.querySelector('[aria-label="Project threads"]')).not.toBeNull();
    expect(localStorage.getItem("studio:project-overview-open:v1")).toBeNull();
  });
  it("returns the keyboard to the Find button when Escape closes an empty search", async () => {
    await render();
    await press({ key: "/" });
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    const input = container.querySelector<HTMLInputElement>(".sws-find input")!;
    expect(document.activeElement).toBe(input);
    await act(async () => {
      input.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      );
    });
    expect(container.querySelector(".sws-find input")).toBeNull();
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Find a thread");
  });
  it("reaches the Threads pane with F6 while its search is tucked away", async () => {
    await render();
    container.querySelector<HTMLTextAreaElement>("#project-prompt")!.focus();
    const bar = container.querySelector<HTMLElement>(".sws-group-bar")!;
    // jsdom lays nothing out; say the pane is on screen.
    Object.defineProperty(bar, "offsetParent", { configurable: true, get: () => document.body });
    bar.getBoundingClientRect = () => ({ right: 10 }) as DOMRect;
    await press({ key: "F6" });
    expect(document.activeElement).toBe(bar);
  });
  it("hands focus to the Overview button when the pane is closed from inside", async () => {
    await render();
    const close = container.querySelector<HTMLButtonElement>('[aria-label="Hide overview"]')!;
    close.focus();
    await act(async () => close.click());
    await act(async () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));
    expect(container.querySelector('[aria-label="Project threads"]')).toBeNull();
    expect(document.activeElement).toBe(container.querySelector(".sws-overview-toggle"));
  });
  it("shows a thread's pull request beside its age", async () => {
    state.shells = [
      shell("coord"),
      shell("worker", {
        pullRequests: [
          {
            host: "github.com",
            repository: "acme/atlas",
            number: 21,
            url: "https://github.com/acme/atlas/pull/21",
            source: "created",
            linkedAt: "2026-10-01T00:00:00.000Z",
            snapshot: null,
            stack: null,
          },
        ] as unknown as EnvironmentThreadShell["pullRequests"],
      }),
    ];
    await render();
    const pill = container.querySelector(".sws-thread-pr");
    expect(pill?.textContent).toContain("#21");
    expect(pill?.getAttribute("data-state")).toBe("open");
  });
  it("offers no control that starts a thread: the coordinator starts them", async () => {
    await render();
    expect(container.querySelector('[aria-label="New thread in this project"]')).toBeNull();
    expect(
      [...container.querySelectorAll("button")].some((b) =>
        /new thread/i.test(`${b.getAttribute("aria-label") ?? ""} ${b.textContent ?? ""}`),
      ),
    ).toBe(false);
    await openFirstThread();
    expect(
      [...container.querySelectorAll("button")].some((b) =>
        /new thread/i.test(`${b.getAttribute("aria-label") ?? ""} ${b.textContent ?? ""}`),
      ),
    ).toBe(false);
  });
  it("notes a message typed in a thread only when it went somewhere else", async () => {
    const wrap = (id: string, text: string) =>
      `User follow-up from selected worker ${id}. Review that thread and decide whether to reuse it or route elsewhere.\n\n${text}`;
    const userMessage = (id: string, senderThreadId: string, text: string) => ({
      id,
      role: "user",
      createdBy: "user",
      senderThreadId,
      text: wrap(senderThreadId, text),
      streaming: false,
      attachments: [],
      createdAt: DateTime.makeUnsafe("2026-10-15T15:00:00.000Z"),
    });
    const answer = (id: string, text: string) => ({
      id,
      role: "assistant",
      createdBy: "agent",
      text,
      streaming: false,
      attachments: [],
    });
    state.shells.push(shell("second", { title: "Second worker" }));
    state.messages = [
      userMessage("coordinator-send:project:one", "worker", "Also cover the away fixtures."),
      answer("answer-one", "Sent to [Second worker](studio://thread/second)."),
      userMessage("coordinator-send:project:two", "second", "Belongs to the other thread."),
      userMessage("coordinator-send:project:three", "worker", "Still waiting on this one."),
    ];
    await render();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-thread-id="worker"] .sws-thread-open')!
        .click(),
    );
    expect(container.textContent).not.toContain("Replies pass through the coordinator");
    expect(container.textContent).not.toContain("message you sent from this thread");
    // The worker's timeline gets the person's words where they typed them, with where they went.
    const routed = state.routing!.routedMessages!;
    expect(routed.map((m) => [m.text, m.routedNote])).toEqual([
      ["Also cover the away fixtures.", { kind: "sent", targetThreadId: "second" }],
      ["Still waiting on this one.", { kind: "pending", targetThreadId: null }],
    ]);
    expect(routed.every((m) => m.role === "user" && m.createdBy === "user")).toBe(true);
    // The same message stays on the coordinator conversation, attributed to its thread.
    const conversation = container.querySelector('[aria-label="Coordinator conversation"]')!;
    expect(conversation.textContent).toContain("Also cover the away fixtures.");
    expect(conversation.textContent).toContain("From Thread worker");
  });
  it("shows nothing extra once a message comes back to its own thread", async () => {
    state.messages = [
      {
        id: "coordinator-send:project:one",
        role: "user",
        createdBy: "user",
        senderThreadId: "worker",
        text: "User follow-up from selected worker worker. Review that thread and decide whether to reuse it or route elsewhere.\n\nShip it.",
        streaming: false,
        attachments: [],
      },
      {
        id: "forwarded-one",
        role: "user",
        createdBy: "user",
        senderThreadId: "coord",
        text: "Ship it.",
        streaming: false,
        attachments: [],
      },
    ];
    await render();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[data-thread-id="worker"] .sws-thread-open')!
        .click(),
    );
    expect(state.routing!.routedMessages).toEqual([]);
  });
  it("shows a worker's long report as a card and folds the coordinator's relay of it", async () => {
    const long = Array.from({ length: 100 }, (_, i) => `- Finding ${i + 1}`).join("\n");
    const message = (id: string, role: string, createdBy: string, extra: object = {}) => ({
      id,
      role,
      createdBy,
      text: long,
      streaming: false,
      attachments: [],
      ...extra,
    });
    state.messages = [
      message("plan", "assistant", "agent"),
      // A delegate_task completion wakes the coordinator; people see the worker's status, not a card.
      message("wake", "user", "system", {
        delegatedCompletion: { taskIds: ["node:delegated-task:a"] },
      }),
      message("relay", "assistant", "agent"),
      message("worker-report", "user", "agent", { senderThreadId: "worker" }),
    ];
    state.threadReports = {
      workspaceRoot: "/repo",
      specweave: true,
      increment: { id: "0973-budget", path: ".specweave/increments/0973-budget" },
      folder: ".specweave/increments/0973-budget/reports",
      reports: [],
    };
    await render();
    const conversation = container.querySelector('[aria-label="Coordinator conversation"]')!;
    expect(conversation.textContent).not.toContain("reported back");
    expect(conversation.querySelector(".project-notice")).toBeNull();
    const articles = [...conversation.querySelectorAll("article")];
    const byAuthor = (author: string) =>
      articles.filter((article) => article.querySelector("h3")?.textContent === author);
    // The coordinator's reply before any worker reported back stays whole.
    expect(articles[0]!.querySelector('[data-report-collapsed="true"]')).toBeNull();
    expect(articles[0]!.querySelector("[data-report-artifact]")).toBeNull();

    // The worker's report is a card naming its increment, not a clamped wall of text.
    const report = byAuthor("Message from a worker")[0]!;
    expect(report.querySelector('[data-report-artifact="true"]')).not.toBeNull();
    expect(report.querySelector("[data-report-increment]")?.textContent).toBe("0973-budget");
    expect(report.textContent).not.toContain("- Finding 20");
    const save = [...report.querySelectorAll("button")].find(
      (b) => b.textContent === "Save to increment",
    )!;
    state.send.mockResolvedValueOnce({ _tag: "Success", value: state.threadReports });
    await act(async () => save.click());
    expect(state.send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ threadId: "worker", text: long }),
      }),
    );
    expect(state.refresh).toHaveBeenCalled();

    // The coordinator's relay folds inline; expanded it is bounded and folds again.
    const relay = byAuthor("Coordinator").at(-1)!;
    expect(relay.querySelector('[data-report-collapsed="true"]')).not.toBeNull();
    const toggle = [...relay.querySelectorAll("button")].find(
      (b) => b.textContent === "Show full message",
    )!;
    await act(async () => toggle.click());
    expect(relay.querySelector('[data-report-collapsed="true"]')).toBeNull();
    expect(relay.querySelector('[data-report-expanded="true"]')).not.toBeNull();
    expect(toggle.textContent).toBe("Show less");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    await act(async () => toggle.click());
    expect(relay.querySelector('[data-report-collapsed="true"]')).not.toBeNull();
  });
  it("keeps a worker's direct answer in the chat: its opening, then the rest on request", async () => {
    const sentence =
      "The relay token expired, so both machines dropped and the list waited on them.";
    const answer = [
      "Both machines are back and the UI no longer freezes.",
      "",
      Array.from({ length: 12 }, () => sentence).join(" "),
      "",
      "- Reconnected M1 and M3.",
      "- Gave the thread list a timeout.",
      "",
      Array.from({ length: 10 }, () => sentence).join(" "),
      "",
      "Nothing needs you right now.",
    ].join("\n");
    state.messages = [
      {
        id: "worker-answer",
        role: "user",
        createdBy: "agent",
        senderThreadId: "worker",
        text: answer,
        streaming: false,
        attachments: [],
      },
    ];
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
    await render();
    const conversation = container.querySelector('[aria-label="Coordinator conversation"]')!;
    expect(conversation.querySelector("[data-report-artifact]")).toBeNull();
    expect(conversation.textContent).not.toContain("Open report");
    // A quiet relayed note names its thread and links back to it; the opening
    // shows as written and the disclosure says how much more there is.
    const relay = conversation.querySelector('[data-relayed-message="thread"]')!;
    expect(relay.closest("article")!.className).toContain("project-message-relay");
    expect(relay.querySelector("h3")!.textContent).toBe("Message from Thread worker");
    expect(conversation.textContent).not.toContain("Sent by");
    expect(conversation.textContent).toContain("View thread");
    expect(conversation.textContent).toContain(
      "Both machines are back and the UI no longer freezes.",
    );
    expect(conversation.textContent).not.toContain("Nothing needs you right now.");
    const toggle = relay.querySelector<HTMLButtonElement>("h3 [aria-expanded]")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    const hidden =
      /^Message from Thread worker\. Show full message, ([\d,]+) more characters$/.exec(
        toggle.getAttribute("aria-label")!,
      );
    expect(Number(hidden![1]!.replaceAll(",", ""))).toBeGreaterThan(answer.length / 2);
    expect(Number(hidden![1]!.replaceAll(",", ""))).toBeLessThan(answer.length);
    expect(document.getElementById(toggle.getAttribute("aria-controls")!)).not.toBeNull();
    await act(async () => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(conversation.textContent).toContain("Nothing needs you right now.");
    const copy = [...conversation.querySelectorAll("button")].find(
      (b) => b.getAttribute("aria-label") === "Copy original message",
    )!;
    await act(async () => copy.click());
    expect(writeText).toHaveBeenCalledWith(answer);
    Reflect.deleteProperty(navigator, "clipboard");
  });
  it("opens a folded worker message for find while its hidden part holds more matches", async () => {
    const answer = [
      "The worktree is ready and the checks pass.",
      "",
      Array.from(
        { length: 6 },
        (_, index) => `Step ${index + 1} cleaned one worktree and kept its branch.`,
      ).join(" "),
      "",
      "x ".repeat(300).trim(),
    ].join("\n");
    state.messages = [
      {
        id: "worker-find",
        role: "user",
        createdBy: "agent",
        senderThreadId: "worker",
        text: answer,
        streaming: false,
        attachments: [],
      },
    ];
    await render();
    const conversation = container.querySelector('[aria-label="Coordinator conversation"]')!;
    const folded = () =>
      conversation.querySelector("[data-worker-message]")!.getAttribute("data-worker-message");
    expect(folded()).toBe("folded");
    // The opening shows "worktree" once; the hidden part holds six more.
    const scope = container.querySelector<HTMLElement>("[data-conversation-find-scope]")!;
    await act(async () => setConversationFindState({ query: "worktree", scope }));
    expect(folded()).toBe("open");
    // Its disclosure still folds it while that find stays open.
    const less = conversation.querySelector<HTMLButtonElement>(
      "[data-relayed-message] h3 [aria-expanded]",
    )!;
    expect(less.getAttribute("aria-expanded")).toBe("true");
    await act(async () => less.click());
    expect(folded()).toBe("folded");
    // Closing find and searching the same word again opens it again.
    await act(async () => setConversationFindState({ query: "", scope: null }));
    await act(async () => setConversationFindState({ query: "worktree", scope }));
    expect(folded()).toBe("open");
    await act(async () => setConversationFindState({ query: "", scope: null }));
  });
  it("leaves a long answer to the coordinator's question unfolded", async () => {
    const answer = Array.from(
      { length: 14 },
      (_, index) => `Answer line ${index + 1}: the relay is back and the list loads.`,
    ).join("\n");
    state.messages = [
      {
        id: "async-answer:question-1",
        role: "user",
        createdBy: "agent",
        senderThreadId: "worker",
        text: answer,
        streaming: false,
        attachments: [],
      },
    ];
    await render();
    const conversation = container.querySelector('[aria-label="Coordinator conversation"]')!;
    expect(conversation.querySelector("[data-worker-message]")).toBeNull();
    expect(conversation.textContent).toContain("Answer line 14");
    expect(conversation.textContent).not.toContain("Copy original");
  });
  it("folds a worker message sooner in Concise and opens it in Verbose (1068)", async () => {
    const report = [
      "Checked the release branch end to end today.",
      "Every gate passed in order except the feed signature step at the end of the run, which stopped on a key mismatch.",
      "The run log, both manifests and the key fingerprints are saved beside the receipt for the release owner to review.",
      "Nothing was published.",
    ].join(" ");
    expect(report.length).toBeGreaterThan(280);
    expect(report.length).toBeLessThan(600);
    state.messages = [
      {
        id: "worker-detail",
        role: "user",
        createdBy: "agent",
        senderThreadId: "worker",
        text: report,
        streaming: false,
        attachments: [],
      },
    ];
    const conversation = () => container.querySelector('[aria-label="Coordinator conversation"]')!;
    const fold = () =>
      conversation().querySelector("[data-worker-message]")?.getAttribute("data-worker-message");
    // Normal shows it whole: it is under 600 characters and 8 lines.
    await render();
    expect(fold()).toBeUndefined();
    expect(conversation().textContent).toContain("Nothing was published.");
    // Concise folds it to its opening, still sent by the worker.
    state.timelineDetail = "concise";
    await render();
    expect(fold()).toBe("folded");
    expect(conversation().textContent).toContain("Message from Thread worker");
    expect(conversation().textContent).toContain("Checked the release branch end to end today.");
    expect(conversation().textContent).not.toContain("Nothing was published.");
    // Verbose shows every word, and Show less still folds it.
    state.timelineDetail = "verbose";
    state.messages = [{ ...state.messages[0]!, text: `${report} ${report} ${report}` }];
    await render();
    expect(fold()).toBe("open");
    expect(conversation().textContent).toContain("Nothing was published.");
    // Opened by Verbose, not by the reader: its controls stay at its end, not over the text.
    const footer = () => conversation().querySelector("[data-relayed-message-footer]")!;
    expect(footer().className).not.toContain("sticky");
    // The reader folds it and opens it again: now the controls follow them down.
    const toggle = () =>
      conversation().querySelector<HTMLButtonElement>("[data-worker-message] [aria-expanded]")!;
    await act(async () => toggle().click());
    expect(fold()).toBe("folded");
    await act(async () => toggle().click());
    expect(fold()).toBe("open");
    expect(footer().className).toContain("sticky");
  });
  it("shows a short worker message whole, with no fold controls", async () => {
    state.messages = [
      {
        id: "worker-short",
        role: "user",
        createdBy: "agent",
        senderThreadId: "worker",
        text: "Done. The PR is green and the evidence is saved.",
        streaming: false,
        attachments: [],
      },
    ];
    await render();
    const conversation = container.querySelector('[aria-label="Coordinator conversation"]')!;
    expect(conversation.textContent).toContain("Done. The PR is green and the evidence is saved.");
    expect(conversation.textContent).not.toContain("Show full message");
    expect(conversation.textContent).not.toContain("Copy original");
  });
  it("announces a thread started this turn with a card and links one that existed", async () => {
    state.shells.push(
      shell("fresh", { title: "Skills consolidation", createdAt: "2026-10-11T05:00:03Z" }),
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
        text: "Started [Skills consolidation](studio://thread/fresh), next to [Thread worker](studio://thread/worker).",
        createdAt: "2026-10-11T05:00:04Z",
        updatedAt: "2026-10-11T05:00:05Z",
        streaming: false,
        attachments: [],
      },
    ];
    await render();
    const conversation = container.querySelector('[aria-label="Coordinator conversation"]')!;
    const cards = conversation.querySelectorAll<HTMLElement>(".sws-thread-card");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.textContent).toContain("Skills consolidation");
    expect(cards[0]!.getAttribute("aria-label")).toBe("Thread Skills consolidation, Idle");
    // Both threads the sentence names are chips with a status dot.
    const chips = conversation.querySelectorAll<HTMLButtonElement>(".sws-thread-link");
    expect([...chips].map((chip) => chip.textContent)).toEqual([
      "Skills consolidation",
      "Thread worker",
    ]);
    expect(chips[0]!.classList.contains("sws-thread-mention")).toBe(true);
    expect(chips[1]!.querySelector(".sws-dot")?.getAttribute("data-tone")).toBe("idle");
    expect(chips[1]!.getAttribute("aria-label")).toBe("Open thread Thread worker, Idle");
    // Without a branch or a pull request, the card has no actions: the card itself opens the thread.
    expect(cards[0]!.querySelectorAll(".sws-thread-card-action")).toHaveLength(0);
    const open = cards[0]!.querySelector<HTMLButtonElement>("button.sws-thread-card-head")!;
    expect(open.getAttribute("aria-label")).toBe("Open thread Skills consolidation, Idle");
    expect(cards[0]!.textContent).not.toContain("View thread");
    await act(async () => open.click());
    expect(container.querySelector('[data-native-thread="fresh"]')).not.toBeNull();
    await act(async () => chips[1]!.click());
    expect(container.querySelector('[data-native-thread="worker"]')).not.toBeNull();
    await act(async () => chips[0]!.click());
    expect(container.querySelector('[data-native-thread="fresh"]')).not.toBeNull();
  });
  it("opens a delegated worker whose ID contains %3A from every link the coordinator writes", async () => {
    const id = "thread:delegated-task:command%3Amcp%3Ad859%3Adelegate-task%3Acoord-format-alpha";
    state.shells.push(
      shell(id, {
        title: "Coordinator formatting and Alpha label",
        createdAt: "2026-10-09T00:00:00Z",
      }),
    );
    state.messages = [
      {
        id: "ack",
        role: "assistant",
        createdBy: "agent",
        text: `Raw [Coordinator formatting and Alpha label](studio://thread/${id}), encoded [Formatting](studio://thread/${encodeURIComponent(id)}), and [Gone](studio://thread/not-here).`,
        createdAt: "2026-10-11T05:00:04Z",
        streaming: false,
        attachments: [],
      },
    ];
    await render();
    const conversation = container.querySelector('[aria-label="Coordinator conversation"]')!;
    const chips = conversation.querySelectorAll<HTMLButtonElement>(`[data-thread-chip="${id}"]`);
    expect(chips).toHaveLength(2);
    // The chip shows the live title, whatever label the message gave it.
    expect([...chips].map((chip) => chip.textContent)).toEqual([
      "Coordinator formatting and Alpha label",
      "Coordinator formatting and Alpha label",
    ]);
    expect(chips[1]!.getAttribute("data-markdown-copy")).toBe(
      `[Coordinator formatting and Alpha label](studio://thread/${encodeURIComponent(id)})`,
    );
    // A link to a thread this project does not have goes to the standard chip.
    expect(conversation.querySelector('[data-fallback-thread-link="not-here"]')?.textContent).toBe(
      "Gone",
    );
    await act(async () => chips[1]!.click());
    expect(container.querySelector(`[data-native-thread="${id}"]`)).not.toBeNull();
  });
  it("opens a worker only for its own ID, and reads a coordinator link as its label", async () => {
    state.shells.push(
      shell("retry", { title: "Retry me", createdAt: "2026-10-09T00:00:00Z" }),
      shell("first", { title: "Retry me", deletedAt: "2026-10-10T00:00:00Z" }),
      shell("elsewhere", { title: "Retry me", projectId: "other" as never }),
    );
    state.messages = [
      {
        id: "ack",
        role: "assistant",
        createdBy: "agent",
        text: "Deleted [Retry me](studio://thread/first), other [Retry me](studio://thread/elsewhere), me [Coordinator](studio://thread/coord).",
        createdAt: "2026-10-11T05:00:04Z",
        streaming: false,
        attachments: [],
      },
    ];
    await render();
    const conversation = container.querySelector('[aria-label="Coordinator conversation"]')!;
    expect(conversation.querySelector('[data-thread-chip="retry"]')).toBeNull();
    expect(conversation.querySelector('[data-fallback-thread-link="first"]')).not.toBeNull();
    expect(conversation.querySelector('[data-fallback-thread-link="elsewhere"]')).not.toBeNull();
    expect(conversation.querySelector('[data-fallback-thread-link="coord"]')).toBeNull();
    expect(conversation.textContent).toContain("me Coordinator.");
  });
  it("shows no record in a thread nothing was typed in", async () => {
    await render();
    await openFirstThread();
    expect(container.querySelector("details.project-routed")).toBeNull();
  });
  it("does not launch on mount and scopes worker cards to this host/project", async () => {
    await render();
    expect(state.send).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Thread worker");
    expect(container.textContent).not.toContain("Thread foreign");
  });
  it("retains the coordinator while a selected worker takes its reply itself", async () => {
    await render();
    await openFirstThread();
    expect(container.querySelector('[aria-label="Project coordinator"]')).not.toBeNull();
    expect(container.querySelector('[data-native-thread="worker"]')).not.toBeNull();
    await click("Reply in selected thread");
    // No coordinator turn: the worker's own composer sends it.
    expect(state.send).not.toHaveBeenCalled();
  });
  it("lets a worker take its reply before the coordinator exists", async () => {
    state.coordinatorId = null;
    state.shells = state.shells.filter((t) => t.id !== "coord");
    await render();
    await openFirstThread();
    await click("Reply in selected thread");
    expect(state.send).not.toHaveBeenCalled();
  });
  it("preserves a rejected draft and retries an uncertain result with the same identity", async () => {
    state.send.mockResolvedValueOnce({
      _tag: "Failure",
      error: new Error("Host disconnected before confirmation"),
    });
    await render();
    await prompt("Build the project");
    await click("Send");
    const id = state.send.mock.calls[0]![0].input.commandId;
    expect(container.querySelector<HTMLTextAreaElement>("#project-prompt")!.value).toBe(
      "Build the project",
    );
    expect(container.textContent).toContain("Host disconnected before confirmation");
    await click("Send");
    expect(state.send.mock.calls[1]![0].input.commandId).toBe(id);
    expect(container.querySelector<HTMLTextAreaElement>("#project-prompt")!.value).toBe("");
  });
  it("reuses an uncertain send identity after the project is reloaded", async () => {
    state.send.mockResolvedValueOnce({ _tag: "Failure", error: new Error("Response lost") });
    await render();
    await prompt("Retry after reload");
    await click("Send");
    const requestId = state.send.mock.calls[0]![0].input.commandId;
    await act(async () => root.unmount());
    recreateRoot();
    await render();
    await prompt("Retry after reload");
    await click("Send");
    expect(state.send.mock.calls[1]![0].input.commandId).toBe(requestId);
  });
  it("continues an existing coordinator when project defaults have been cleared", async () => {
    state.coordinatorModel = null;
    Object.assign(state.project, { defaultModelSelection: null });
    await render();
    await prompt("Continue existing coordinator");
    await click("Send");
    expect(state.send).toHaveBeenCalledOnce();
  });
  it("blocks admission when the selected host is disconnected", async () => {
    state.connected = false;
    await render();
    await prompt("New work");
    expect(
      container.querySelector<HTMLButtonElement>('[aria-label="Send to coordinator"]')!.disabled,
    ).toBe(true);
    expect(state.send).not.toHaveBeenCalled();
  });
  it("lays the panel out as Threads, Designs, Library, PRs and Routines tabs", async () => {
    state.shells = [
      shell("coord"),
      shell("worker", {
        pullRequests: [
          {
            host: "github.com",
            repository: "acme/atlas",
            number: 21,
            url: "https://github.com/acme/atlas/pull/21",
            source: "created",
            linkedAt: "2026-10-01T00:00:00.000Z",
            snapshot: null,
            stack: null,
          },
        ] as unknown as EnvironmentThreadShell["pullRequests"],
      }),
    ];
    await render();
    // Each pane draws its own bar, so the tabs are looked up after every switch.
    const tabs = () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    expect(tabs().map((tab) => tab.querySelector(".sws-pane-tab-label")?.textContent)).toEqual([
      "Threads",
      "Designs",
      "Library",
      "PRs",
      "Routines",
    ]);
    expect(tabs()[0]!.getAttribute("aria-selected")).toBe("true");
    expect(tabs()[3]!.textContent).toContain("1");
    await act(async () => tabs()[3]!.click());
    expect(container.querySelector("#sws-pane-prs")?.textContent).toContain("acme/atlas #21");
    expect(localStorage.getItem("studio:project-pane-tab:v1")).toContain("prs");
    // Arrow keys move along the tabs, as a tablist does.
    await act(async () =>
      tabs()[3]!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true })),
    );
    expect(container.textContent).toContain("Library pane");
  });
  it("lists pull requests from both machines' checkouts, naming each machine", async () => {
    const pr = (number: number) =>
      [
        {
          host: "github.com",
          repository: "acme/atlas",
          number,
          url: `https://github.com/acme/atlas/pull/${number}`,
          source: "created",
          linkedAt: "2026-10-01T00:00:00.000Z",
          snapshot: null,
          stack: null,
        },
      ] as unknown as EnvironmentThreadShell["pullRequests"];
    state.otherCheckouts = [
      { id: "remote-project", environmentId: "laptop", workspaceRoot: "/w/atlas" },
    ];
    state.shells = [
      shell("coord"),
      shell("worker", { pullRequests: pr(21) }),
      shell("laptop-worker", {
        environmentId: "laptop" as never,
        projectId: "remote-project" as never,
        pullRequests: pr(22),
      }),
    ];
    await render();
    const prsTab = [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')][3]!;
    await act(async () => prsTab.click());
    const pane = container.querySelector("#sws-pane-prs")!;
    expect(pane.querySelector("[data-prs-across-machines]")?.textContent).toBe(
      "Pull requests from both machines",
    );
    expect(pane.textContent).toContain("acme/atlas #21 · Open · host");
    expect(pane.textContent).toContain("acme/atlas #22 · Open · laptop");
  });
  it("widens the panel over the coordinator and back", async () => {
    await render();
    const expand = () =>
      container.querySelector<HTMLButtonElement>(
        '[aria-label="Expand panel"], [aria-label="Restore panel"]',
      )!;
    const columns = () => container.querySelector(".sws-columns")!;
    await act(async () => expand().click());
    expect(columns().getAttribute("data-expanded")).toBe("true");
    expect(expand().getAttribute("aria-label")).toBe("Restore panel");
    await act(async () => expand().click());
    expect(columns().getAttribute("data-expanded")).toBeNull();
  });
  it("gives an open thread a Resolve button and an actions menu", async () => {
    await render();
    await openFirstThread();
    const resolve = container.querySelector<HTMLButtonElement>('[aria-label="Resolve thread"]');
    expect(resolve).not.toBeNull();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Thread actions"]')!.click(),
    );
    expect(state.openMenu).toHaveBeenCalledTimes(1);
    await act(async () => resolve!.click());
    expect(state.settle).toHaveBeenCalledWith({ environmentId: "host", threadId: "worker" });
  });
  it("closes the open thread and shows the thread list once Resolve succeeds", async () => {
    await render();
    await openFirstThread();
    state.settle.mockResolvedValueOnce({ _tag: "Success", value: undefined });
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Resolve thread"]')!.click(),
    );
    expect(state.settle).toHaveBeenCalledWith({ environmentId: "host", threadId: "worker" });
    expect(container.querySelector('[aria-label="Resolve thread"]')).toBeNull();
    const pane = container.querySelector('[data-project-pane="threads"]')!;
    expect(pane.querySelector('[data-thread-id="worker"]')).not.toBeNull();
  });
  it("keeps the thread open when Resolve fails", async () => {
    await render();
    await openFirstThread();
    state.settle.mockResolvedValueOnce({ _tag: "Failure", error: new Error("offline") });
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Resolve thread"]')!.click(),
    );
    expect(container.querySelector('[aria-label="Resolve thread"]')).not.toBeNull();
  });
  it("resolves through the native thread API without starting a provider", async () => {
    await render();
    await click("Resolve");
    expect(state.settle).toHaveBeenCalledWith({ environmentId: "host", threadId: "worker" });
    expect(state.send).not.toHaveBeenCalled();
  });
  it("shares one title row: the top bar over the coordinator, the panel's header beside it", async () => {
    await render();
    // Nothing spans the window above the two columns.
    expect(container.querySelector(".sws-project > header")).toBeNull();
    const coordinator = container.querySelector('[aria-label="Project coordinator"]')!;
    const topBar = coordinator.firstElementChild!;
    expect(topBar.tagName).toBe("HEADER");
    expect(topBar.querySelector(".sws-overview-toggle")).not.toBeNull();
    const pane = container.querySelector("#project-threads-pane")!;
    expect(pane.querySelectorAll(".sws-pane-head")).toHaveLength(1);
    expect(pane.firstElementChild!.classList.contains("sws-pane-head")).toBe(true);
    expect(pane.firstElementChild!.querySelector('[role="tablist"]')).not.toBeNull();
  });
  it("turns the panel's header row into the open thread's header, not a second row", async () => {
    await render();
    await openFirstThread();
    const pane = container.querySelector("#project-threads-pane")!;
    const rows = pane.querySelectorAll(".sws-pane-head");
    expect(rows).toHaveLength(1);
    expect(pane.firstElementChild).toBe(rows[0]);
    expect(rows[0]!.classList.contains("sws-thread-head")).toBe(true);
    expect(pane.querySelector('[role="tablist"]')).toBeNull();
    const back = rows[0]!.querySelector<HTMLButtonElement>(
      '[aria-label="Back to project threads"]',
    )!;
    expect(back.textContent).toBe("Threads");
    expect(rows[0]!.querySelector("h2")?.textContent).toBe("Thread worker");
    await act(async () => back.click());
    expect(container.querySelector('[data-native-thread="worker"]')).toBeNull();
    expect(pane.querySelector('[role="tablist"]')).not.toBeNull();
  });
});
