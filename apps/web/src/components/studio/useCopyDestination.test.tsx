// @vitest-environment jsdom
import type { EnvironmentId } from "@specweave-studio/contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import type { CopyMachine } from "./HandoffCopySetup";
import { useCopyDestination } from "./useCopyDestination";

vi.mock("../../state/filesystem", () => ({
  filesystemEnvironment: { browse: (input: unknown) => input },
  useFilesystemReadAccess: () => ({ canReadFiles: false }),
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({ data: null, isPending: false }),
}));

const id = (value: string) => value as EnvironmentId;
const scope = {
  selected: { copyRoot: "/Users/me/app", projectRelativePath: "." },
} as never;
let root: Root;
let container: HTMLDivElement;
let last: ReturnType<typeof useCopyDestination>;
function Probe(props: { machines: CopyMachine[]; preferred: EnvironmentId | null }) {
  last = useCopyDestination({
    machines: props.machines,
    preferredMachine: props.preferred,
    savedFolder: (machine) => (machine === "mini" ? "/Users/me/saved" : null),
    scope,
  });
  return null;
}
const show = (machines: CopyMachine[], preferred: EnvironmentId | null = null) =>
  act(async () => root.render(<Probe machines={machines} preferred={preferred} />));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
});

const mini = (unavailable: string | null): CopyMachine => ({
  id: id("mini"),
  label: "Mini",
  unavailable,
});
const m3 = (unavailable: string | null): CopyMachine => ({
  id: id("m3"),
  label: "M3",
  unavailable,
});

it("picks a machine once it finishes connecting, instead of leaving the form without one", async () => {
  await show([mini("Connecting…")]);
  expect(last.machine).toBeNull();
  expect(last.folder).toBe("");
  await show([mini(null)]);
  expect(last.machine).toBe("mini");
  expect(last.folder).toBe("/Users/me/saved");
});

it("prefers the remembered machine when it is ready, and keeps a machine the person chose", async () => {
  await show([mini(null), m3(null)], id("m3"));
  expect(last.machine).toBe("m3");
  await act(async () => last.setMachine(id("mini")));
  await show([mini(null), m3(null)], id("m3"));
  expect(last.machine).toBe("mini");
});

it("skips a remembered machine that cannot take the copy", async () => {
  await show([mini(null), m3("Connect first")], id("m3"));
  expect(last.machine).toBe("mini");
});

it("pins the first ready machine, so a machine that connects later or reconnects never retargets", async () => {
  await show([mini("Connecting…"), m3(null)]);
  expect(last.machine).toBe("m3");
  // Mini, earlier in the list, finishes connecting: the pinned machine stays.
  await show([mini(null), m3(null)]);
  expect(last.machine).toBe("m3");
  // The pinned machine briefly reconnects: it stays the target instead of switching or clearing.
  await show([mini(null), m3("Reconnecting…")]);
  expect(last.machine).toBe("m3");
});
