// @vitest-environment jsdom
import { act, type RefObject } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { EnvironmentId, FolderCopySourceSummary } from "@specweave-studio/contracts";

import type { CopyMachine } from "./HandoffCopySetup";
import { folderCopyStorageKey, type PendingCopy } from "./handoffFolderCopyPending";
import { useCopySecrets } from "./useCopySecrets";

const state = vi.hoisted(() => ({
  sends: [] as Array<ReadonlyArray<string>>,
  onSend: null as null | (() => void),
}));

vi.mock("../../studio/machineHandoff", () => ({
  machineHandoff: new Proxy({}, { get: (_target, name) => name }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (name: string) => async (request: { input?: { paths?: Array<string> } }) => {
    if (name === "copySecrets" || name === "copySealedSecrets") {
      state.sends.push(request.input?.paths ?? []);
      const during = state.onSend;
      state.onSend = null;
      during?.();
    }
    return { _tag: "Success", value: {} };
  },
}));
vi.mock("../../studio/copySecretsRoute", () => ({
  refreshSealedRoute: async () => undefined,
  secretsSealed: () => false,
}));
vi.mock("./useSecretsGate", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./useSecretsGate")>()),
  useSecretsGate: () => ({ clamp: (choice: unknown) => choice, blocked: false, sender: "here" }),
  secretsBlockedNow: () => false,
  sendSecretsOrWithdraw: async (_context: unknown, actions: { send: () => Promise<unknown> }) => {
    await actions.send();
  },
}));

type Secrets = ReturnType<typeof useCopySecrets>;

const storageKey = folderCopyStorageKey("env-source", "project-1");
const summary = {
  secretFiles: [
    { path: ".env", size: 10 },
    { path: "app.env", size: 10 },
  ],
  warnings: [],
} as unknown as FolderCopySourceSummary;
const machines = [
  { id: "env-target", label: "Target", homeSecretFiles: false },
] as never as ReadonlyArray<CopyMachine>;

let roots: Array<Root> = [];

function Window({
  into,
  pending,
  listed = summary,
}: {
  into: { current: Secrets | null };
  pending: RefObject<PendingCopy | null>;
  listed?: FolderCopySourceSummary;
}) {
  into.current = useCopySecrets({
    source: "env-source" as EnvironmentId,
    sourceLabel: "Source",
    targetLabel: "Target",
    machine: "env-target" as EnvironmentId,
    machines,
    summary: listed,
    copy: null,
    summaryNow: { current: listed },
    copyNow: { current: null },
    repositoryChoices: null,
    repositoryDraft: { current: null },
    latestPending: pending,
    done: false,
    keep: (secrets) => {
      if (pending.current) pending.current = { ...pending.current, secrets };
    },
    readSummary: async () => listed,
    storageKey,
  });
  return null;
}

/** One dialog window on the copy, with its own memory and the machine's shared storage. */
async function openWindow(listed = summary) {
  const into: { current: Secrets | null } = { current: null };
  const pending: RefObject<PendingCopy | null> = {
    current: {
      operationId: "op-1",
      environmentId: "env-target",
      secrets: { included: true, out: [] },
    } as unknown as PendingCopy,
  };
  const element = document.createElement("div");
  document.body.append(element);
  const root = createRoot(element);
  roots.push(root);
  await act(async () => root.render(<Window into={into} pending={pending} listed={listed} />));
  return into;
}

beforeEach(() => {
  localStorage.clear();
  state.sends = [];
  state.onSend = null;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(async () => {
  for (const root of roots) await act(async () => root.unmount());
  roots = [];
  document.body.innerHTML = "";
});

it("keeps a file another window left out when this one saves a change it drew before", async () => {
  const a = await openWindow();
  const b = await openWindow();
  // Window A drew its boxes; its handler still holds that render.
  const staleChoose = a.current!.choose;
  // Window B leaves .env out.
  await act(async () => b.current!.choose({ included: true, out: [".env"] }));
  // A, never redrawn, unticks app.env on what it showed: .env was ticked there.
  await act(async () => staleChoose({ included: true, out: ["app.env"] }));
  await act(async () => a.current!.sendTicked("op-1"));
  expect(state.sends.at(-1)).toEqual([]);
  expect(a.current!.sentFor("op-1")).toEqual([]);
});

it("stages again when another window leaves a file out while the list is on its way", async () => {
  const a = await openWindow();
  const b = await openWindow();
  state.onSend = () => b.current!.choose({ included: true, out: [".env"] });
  await act(async () => a.current!.sendTicked("op-1"));
  expect(state.sends).toEqual([[".env", "app.env"], ["app.env"]]);
  // What the approval then names leaves .env out.
  expect(a.current!.sentFor("op-1")).toEqual(["app.env"]);
});

it("names no secret file to the approval when the saved summary lists none", async () => {
  // A reopened dialog holds a summary from before a Refresh found .env; a list staged then
  // must never be pulled unnamed.
  const a = await openWindow({
    secretFiles: [],
    warnings: [],
  } as unknown as FolderCopySourceSummary);
  await act(async () => a.current!.sendTicked("op-1"));
  expect(a.current!.sentFor("op-1")).toEqual([]);
});

it("lets Sync again with secrets take back only this window's own exclusions", async () => {
  const a = await openWindow();
  const b = await openWindow();
  // B leaves .env out of this copy; A leaves app.env out.
  await act(async () => b.current!.choose({ included: true, out: [".env"] }));
  await act(async () => a.current!.choose({ included: true, out: ["app.env"] }));
  // A asks for every secret on another copy to the same machine.
  const again = a.current!.includeAll();
  // A's own exclusion is taken back; B's still keeps .env out.
  expect(a.current!.settled(again).out).toEqual([".env"]);
});
