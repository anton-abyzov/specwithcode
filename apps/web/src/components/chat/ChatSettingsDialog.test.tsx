// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@specweave-studio/contracts";

import { closeChatSettings, requestChatSettings } from "../../studio/chatSettingsRequest";
import { CHAT_SETTINGS_LEAD, ChatSettingsDialogHost } from "./ChatSettingsDialog";

const state = vi.hoisted(() => ({
  thread: null as null | {
    title: string;
    worktreePath: string | null;
    modelSelection: { instanceId: string; model: string };
  },
  canOperate: true,
  projectMove: true,
  assistant: true,
  pathname: "/env-1/chat-1",
  switched: [] as unknown[],
  moved: [] as unknown[],
}));

vi.mock("@tanstack/react-router", () => ({
  useLocation: ({ select }: { select: (location: { pathname: string }) => string }) =>
    select({ pathname: state.pathname }),
}));
vi.mock("../../state/entities", () => ({
  useThreadShell: (ref: ScopedThreadRef | null) => (ref ? state.thread : null),
  readEnvironmentSupportsProjectMove: () => state.projectMove,
}));
vi.mock("../../state/environments", () => ({
  useEnvironment: () => ({ label: "minisforum" }),
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => state.canOperate,
}));
vi.mock("../../studio/machineNickname", () => ({
  useMachineNicknames: () => (_id: string, label?: string | null) => label ?? "this machine",
}));
vi.mock("../../hooks/useSettings", () => ({ useAideEnabled: () => state.assistant }));
vi.mock("../studio/shell/ModelBadge", () => ({
  useProviderEntries: () => new Map(),
  ModelBadge: (props: { model: string }) => <span data-model-badge>{props.model}</span>,
}));
vi.mock("../handoff/HandOffThreadDialog", () => ({
  requestSwitchModel: (ref: unknown) => state.switched.push(ref),
}));
vi.mock("../ThreadMoveDialog", () => ({
  requestThreadMove: async (ref: unknown) => {
    state.moved.push(ref);
  },
}));

const environmentId = "env-1" as EnvironmentId;
const threadRef = { environmentId, threadId: "chat-1" as ThreadId } as ScopedThreadRef;
let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  state.thread = {
    title: "Plan a trip",
    worktreePath: "/home/me/.specwithcode/m/scratch/2026-11-19-plan-a-trip-1a2b",
    modelSelection: { instanceId: "claudeAgent", model: "claude-opus-5-5" },
  };
  state.canOperate = true;
  state.projectMove = true;
  state.assistant = true;
  state.pathname = "/env-1/chat-1";
  state.switched = [];
  state.moved = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  act(() => closeChatSettings());
  container.remove();
  document.body.innerHTML = "";
});

const render = () => act(() => root.render(<ChatSettingsDialogHost />));
const dialog = () => document.querySelector("[data-chat-settings]");
const button = (name: string) =>
  [...document.querySelectorAll("button")].find((element) => element.textContent === name);

it("shows a chat's machine, its own folder and model, and no project settings", () => {
  render();
  expect(dialog()).toBeNull();
  act(() => requestChatSettings({ environmentId, threadRef }));
  const text = dialog()?.textContent ?? "";
  expect(text).toContain("Chat settings");
  expect(text).toContain("Plan a trip");
  expect(text).toContain(CHAT_SETTINGS_LEAD);
  expect(text).toContain("minisforum");
  expect(text).toContain("/home/me/.specwithcode/m/scratch/2026-11-19-plan-a-trip-1a2b");
  expect(text).toContain("claude-opus-5-5");
  for (const projectOnly of ["Project folder", "Use worktrees", "Goal", "Coordinator model"])
    expect(text).not.toContain(projectOnly);
  expect(text).toContain("personal assistant");
});

it("hands Switch model and Move to project to their own dialogs", () => {
  render();
  act(() => requestChatSettings({ environmentId, threadRef }));
  act(() => button("Switch model…")?.click());
  expect(state.switched).toEqual([threadRef]);
  expect(dialog()).toBeNull();
  act(() => requestChatSettings({ environmentId, threadRef }));
  act(() => button("Move to project…")?.click());
  expect(state.moved).toEqual([threadRef]);
  expect(dialog()).toBeNull();
});

it("offers no actions to a read-only connection or a host that cannot move threads", () => {
  state.canOperate = false;
  render();
  act(() => requestChatSettings({ environmentId, threadRef }));
  expect(button("Switch model…")).toBeUndefined();
  expect(button("Move to project…")).toBeUndefined();
  act(() => closeChatSettings());
  state.canOperate = true;
  state.projectMove = false;
  act(() => requestChatSettings({ environmentId, threadRef }));
  expect(button("Switch model…")).toBeDefined();
  expect(button("Move to project…")).toBeUndefined();
});

it("describes an unsent draft, which has no folder or thread yet", () => {
  state.assistant = false;
  render();
  act(() => requestChatSettings({ environmentId, threadRef: null }));
  const text = dialog()?.textContent ?? "";
  expect(text).toContain("New chat");
  expect(text).toContain("Its own folder is made when you send the first message.");
  expect(text).toContain("Chosen in the message box.");
  expect(text).not.toContain("personal assistant");
  expect(button("Move to project…")).toBeUndefined();
});

it("closes when the page changes under it", () => {
  render();
  act(() => requestChatSettings({ environmentId, threadRef }));
  expect(dialog()).not.toBeNull();
  state.pathname = "/settings";
  render();
  expect(dialog()).toBeNull();
});
