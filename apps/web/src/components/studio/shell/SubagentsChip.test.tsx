// @vitest-environment jsdom
import type { EnvironmentThreadShell } from "@specweave-studio/client-runtime/state/shell";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

vi.mock("../../ChatView", () => ({ default: () => null }));
vi.mock("../../../state/entities", () => ({ useThreadProjection: () => null }));
vi.mock("./ModelBadge", () => ({
  ModelBadge: (props: { model: string }) => <span className="sws-model">{props.model}</span>,
  useProviderEntriesByEnvironment: () => new Map(),
}));

import type { SubagentEntry } from "../../../studio/threadSubagents";
import { SubagentPeek } from "./SubagentPeek";
import { SubagentsChip } from "./SubagentsChip";

const entry = (key: string, overrides: Partial<SubagentEntry> = {}): SubagentEntry => ({
  key,
  childThreadId: key as SubagentEntry["childThreadId"],
  title: key,
  status: "running",
  origin: "provider_native",
  providerInstanceId: null,
  model: null,
  prompt: null,
  result: null,
  startedAt: null,
  completedAt: null,
  depth: 0,
  ...overrides,
});

const thread = {
  id: "worker",
  environmentId: "host",
  title: "Install dependencies",
  modelSelection: { instanceId: "codex", model: "worker-model" },
} as unknown as EnvironmentThreadShell;

let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
});

describe("a subagent blocked on the person", () => {
  it("reads as waiting on you in the chip's list, and is not counted working", async () => {
    await act(() =>
      root.render(
        <SubagentsChip
          environmentId="host"
          entries={[
            entry("approve", { status: "waiting", awaitingPerson: "approval" }),
            entry("answer", { status: "waiting", awaitingPerson: "answer" }),
            entry("sign-in", { status: "waiting", awaitingPerson: "sign-in" }),
            entry("busy"),
          ]}
          onPeek={vi.fn()}
        />,
      ),
    );
    const trigger = container.querySelector<HTMLButtonElement>(".sws-subagents-chip")!;
    expect(trigger.getAttribute("aria-label")).toBe("4 subagents, 1 working");
    await act(async () => {
      trigger.click();
    });
    const rows = [...document.querySelectorAll('[aria-label="Subagents"] li')].map(
      (row) => row.textContent ?? "",
    );
    expect(rows).toHaveLength(4);
    expect(rows[0]).toContain("Approval requested");
    expect(rows[1]).toContain("Answer needed");
    expect(rows[2]).toContain("Sign-in needed");
    expect(rows[3]).toContain("Working");
    expect(document.body.textContent).toContain("1 working");
  });

  it("names what it waits on in the peek header", async () => {
    await act(() =>
      root.render(
        <SubagentPeek
          thread={thread}
          entry={entry("worker", { status: "waiting", awaitingPerson: "approval" })}
          parentTitle="Coordinator"
          onClose={vi.fn()}
        />,
      ),
    );
    const status = container.querySelector(".sws-subagent-status")!;
    expect(status.textContent).toBe("Approval requested");
    expect(status.getAttribute("data-tone")).toBe("waiting");
  });
});
