// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { ProjectHandoffRecovery } from "./ProjectHandoffRecovery";
import { machineHandoffStorageKey } from "../../studio/machineHandoffPending";

const state = vi.hoisted(() => ({
  prepare: vi.fn(),
  receive: vi.fn(),
  offline: new Set<string>(),
}));
vi.mock("../../studio/machineHandoff", () => ({
  machineHandoff: { prepare: "prepare", receive: "receive" },
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (name: "prepare" | "receive") => state[name],
}));
vi.mock("@specweave-studio/client-runtime/state/runtime", () => ({
  squashAtomCommandFailure: (failure: { error: Error }) => failure.error,
}));
vi.mock("../../state/environments", () => ({
  useEnvironments: () => ({
    environments: ["m4", "m1"].map((environmentId) => ({
      environmentId,
      label: environmentId,
      connection: { phase: state.offline.has(environmentId) ? "disconnected" : "connected" },
    })),
  }),
}));
vi.mock("../../state/session", () => ({ useEnvironmentsWithScope: () => new Set(["m4", "m1"]) }));
const operationId = "7307ab55-fc59-4e07-abeb-de54be69215f";
const scope = {
  environmentId: "m4",
  projectId: "source",
  coordinatorThreadId: "source-coordinator",
};
const binding = { epoch: 0, state: "transferring", operationId };
const members = [
  { id: "source", environmentId: "m4", workspaceSettings: { coordinatorBinding: binding } },
];
const bundle = {
  sourceEnvironmentId: "m4",
  sourceProjectId: "source",
  sourceThreadId: "source-coordinator",
  destination: { environmentId: "m1", projectId: "original-anchor" },
  manifest: { operationId },
  digest: "saved-published-digest",
  coordinatorBinding: binding,
  logicalProject: { id: "one", members: [scope], coordinatorId: "one", title: "One" },
};
const started = {
  phase: "started",
  projectId: "isolated",
  coordinatorThreadId: "next-coordinator",
  operationId,
};
const key = machineHandoffStorageKey(scope.environmentId, scope.projectId);
let root: Root, container: HTMLDivElement;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  state.offline.clear();
  localStorage.clear();
  state.prepare.mockResolvedValue({ _tag: "Success", value: { publication: "published", bundle } });
  state.receive.mockResolvedValue({ _tag: "Success", value: started });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});
const render = (knownMembers = members) =>
  act(async () =>
    root.render(
      <ProjectHandoffRecovery scopes={[scope] as never} members={knownMembers as never} />,
    ),
  );
const finishButton = () =>
  [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.textContent === "Finish handoff",
  );
const retry = () => act(async () => finishButton()!.click());

it("recovers from authoritative source ownership without a browser retry pointer", async () => {
  await render();
  await retry();
  expect(state.prepare.mock.calls[0]?.[0]).toEqual({
    environmentId: "m4",
    input: {
      projectId: "source",
      sourceThreadId: "source-coordinator",
      operationId,
      publish: false,
    },
  });
  expect(state.receive).toHaveBeenCalledTimes(1);
  expect(state.receive.mock.calls[0]?.[0].input.mode).toBe("preview");
  expect(state.prepare.mock.calls[1]?.[0].input.acknowledgment).toMatchObject({
    projectId: "isolated",
    coordinatorThreadId: "next-coordinator",
    digest: bundle.digest,
  });
  expect(container.textContent).toContain("Handoff finished on both machines.");
});

it("keeps an unavailable source discoverable using the original pointer and does not invoke either host", async () => {
  localStorage.setItem(key, JSON.stringify({ operationId, targetKey: "m1:original-anchor" }));
  state.offline.add("m4");
  await render([]);
  expect(container.textContent).toContain("Reconnect m4");
  expect(finishButton()?.disabled).toBe(true);
  expect(state.prepare).not.toHaveBeenCalled();
  expect(state.receive).not.toHaveBeenCalled();
  expect(localStorage.getItem(key)).not.toBeNull();
});

it("retries the same published operation after an ambiguous launch, then acknowledges its receipt without launching again", async () => {
  state.receive
    .mockResolvedValueOnce({ _tag: "Success", value: { phase: "ready" } })
    .mockResolvedValueOnce({ _tag: "Failure", error: new Error("Ambiguous launch response") })
    .mockResolvedValue({ _tag: "Success", value: started });
  await render();
  await retry();
  expect(container.textContent).toContain("Ambiguous launch response");
  await retry();
  expect(state.receive.mock.calls.map(([call]) => call.input.mode)).toEqual([
    "preview",
    "start",
    "preview",
  ]);
  expect(state.receive.mock.calls[1]?.[0]).toEqual({
    environmentId: "m1",
    input: { projectId: "original-anchor", operationId, mode: "start", bundle },
  });
  expect(container.textContent).toContain("Handoff finished on both machines.");
});

it("requires the original review when a retry pointer only refers to an unpublished preview", async () => {
  state.prepare.mockResolvedValue({
    _tag: "Success",
    value: { publication: "unpublished", bundle },
  });
  await render();
  await retry();
  expect(container.textContent).toMatch(
    /This handoff isn.t ready to finish yet\. Open Hand off on .+ to continue it\./,
  );
  expect(container.textContent).not.toContain("checkpoint");
  expect(state.receive).not.toHaveBeenCalled();
  expect(state.prepare).toHaveBeenCalledTimes(1);
});

it("preserves the saved operation when the source cannot read it, then recovers without touching the destination prematurely", async () => {
  const pointer = JSON.stringify({ operationId, targetKey: "m1:original-anchor" });
  localStorage.setItem(key, pointer);
  state.prepare.mockResolvedValueOnce({
    _tag: "Failure",
    error: new Error("Source checkpoint storage is unavailable"),
  });
  await render();
  await retry();
  expect(container.querySelector('[role="status"]')?.textContent).toBe(
    "Source checkpoint storage is unavailable",
  );
  expect(localStorage.getItem(key)).toBe(pointer);
  expect(state.receive).not.toHaveBeenCalled();
  expect(finishButton()?.disabled).toBe(false);
  await retry();
  expect(state.prepare.mock.calls[1]?.[0]).toEqual(state.prepare.mock.calls[0]?.[0]);
  expect(state.receive).toHaveBeenCalledWith({
    environmentId: "m1",
    input: expect.objectContaining({
      projectId: "original-anchor",
      operationId,
      mode: "preview",
    }),
  });
  expect(state.receive).toHaveBeenCalledTimes(1);
  expect(container.textContent).toContain("Handoff finished on both machines.");
  expect(localStorage.getItem(key)).toBeNull();
});

it("names the project and destination, keeps the operation in Details, and asks to reconnect only when the source is not ready", async () => {
  localStorage.setItem(key, JSON.stringify({ operationId, targetKey: "m1:original-anchor" }));
  await render([{ ...members[0]!, title: "SpecWeave" }] as never);
  expect(container.textContent).toContain("Finish handing off SpecWeave to m1");
  expect(container.textContent).toContain(
    "The handoff stopped partway. m4 won’t restart on its own.",
  );
  expect(container.textContent).not.toContain("Reconnect");
  const details = [...container.querySelectorAll("button")].find(
    (b) => b.textContent === "Details",
  )!;
  expect(container.textContent).not.toContain(operationId);
  await act(async () => details.click());
  expect(container.textContent).toContain(`Operation ${operationId}`);
  state.offline.add("m4");
  await render([{ ...members[0]!, title: "SpecWeave" }] as never);
  expect(container.textContent?.match(/Reconnect m4/g)).toHaveLength(1);
  expect(finishButton()?.disabled).toBe(true);
});
