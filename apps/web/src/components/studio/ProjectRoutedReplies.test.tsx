// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import * as DateTime from "effect/DateTime";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ThreadId } from "@specweave-studio/contracts";
import type { ChatMessage } from "../../types";
import { useRoutedThreadMessages } from "./ProjectRoutedReplies";

const state = vi.hoisted(() => ({
  coordinator: [] as unknown[],
}));
vi.mock("../../state/entities", () => ({
  useThreadProjection: (ref: { threadId: string } | null) =>
    ref?.threadId === "coordinator" ? { projection: { messages: state.coordinator } } : null,
  useThreadShell: () => null,
}));

const prefix =
  "User follow-up from selected worker worker. Review that thread and decide whether to reuse it or route elsewhere.\n\n";
const at = DateTime.makeUnsafe("2026-10-16T10:00:00.000Z");
const typed = {
  id: "coordinator-send:project:one",
  role: "user",
  createdBy: "user",
  senderThreadId: "worker",
  text: `${prefix}Fix the status page`,
  createdAt: at,
};
const reply = (text: string, streaming: boolean) => ({
  id: "reply",
  role: "assistant",
  createdBy: "agent",
  text,
  streaming,
  createdAt: at,
});

const results: Array<readonly ChatMessage[]> = [];
function Probe() {
  results.push(
    useRoutedThreadMessages(
      { id: "project", environmentId: "host" as never },
      ThreadId.make("coordinator"),
      {
        id: ThreadId.make("worker"),
        environmentId: "host",
        projectId: "project",
        title: "Status page",
        deletedAt: null,
      } as never,
    ),
  );
  return null;
}

let root: Root;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  results.length = 0;
  root = createRoot(document.createElement("div"));
});
afterEach(() => act(() => root.unmount()));

it("keeps the worker's routed messages while the coordinator streams, and updates them when it answers", () => {
  state.coordinator = [typed, reply("Look", true)];
  act(() => root.render(<Probe />));
  const pending = results.at(-1)!;
  expect(pending.map((message) => message.routedNote?.kind)).toEqual(["pending"]);

  // Each streamed token is a new coordinator message list.
  for (const text of ["Looking", "Looking at", "Looking at it"]) {
    state.coordinator = [typed, reply(text, true)];
    act(() => root.render(<Probe />));
    expect(results.at(-1)).toBe(pending);
  }

  state.coordinator = [typed, reply("Sent to [Status page](studio://thread/other-thread).", false)];
  act(() => root.render(<Probe />));
  const sent = results.at(-1)!;
  expect(sent).not.toBe(pending);
  expect(sent[0]!.routedNote).toEqual({ kind: "sent", targetThreadId: "other-thread" });
});
