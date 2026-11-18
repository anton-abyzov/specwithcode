// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ProjectId } from "@specweave-studio/contracts";

const mocks = vi.hoisted(() => ({
  push: vi.fn(),
  keep: vi.fn(),
  scopes: new Set<string>(),
  machines: [] as unknown[],
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (atom: { fn: unknown }) => atom.fn,
}));
vi.mock("../../studio/projectWorkspace", () => ({
  projectWorkspace: {
    skillFleetPush: { fn: mocks.push },
    skillsRolloutKeep: { fn: mocks.keep },
  },
}));
vi.mock("../../state/session", () => ({
  useEnvironmentScope: (_environmentId: unknown, scope: string) => mocks.scopes.has(scope),
}));
vi.mock("../../state/server", () => ({ serverEnvironment: { refreshProviders: { fn: vi.fn() } } }));
vi.mock("../../studio/fleet", () => ({
  useStudioFleet: () => ({ snapshot: { machines: mocks.machines }, loading: false }),
}));
vi.mock("../../studio/machineNickname", () => ({
  useMachineNickname: () => "M5",
  useMachineNicknames: () => (_id: string, label: string) => label,
}));
import { SkillRollout } from "./SkillRollout";

const environmentId = EnvironmentId.make("env-m5");
const projectId = ProjectId.make("project");
const COMMIT = "c".repeat(40);
const HASH = "d".repeat(64);
const success = (value: unknown) => ({ _tag: "Success", value });
const machine = (id: string, fields: Record<string, unknown> = {}) => ({
  id,
  label: id,
  environmentId: `env-${id}`,
  url: `http://${id}:8319`,
  status: "reachable",
  pairingConfigured: true,
  ...fields,
});
const STATUS = {
  skill: "html-report",
  repo: "anton-abyzov/vskill",
  lockScope: "user",
  installed: { version: "1.1.3", commit: COMMIT, contentHash: HASH },
  installedSource: { path: "skills/html-report/SKILL.md", branch: "main" },
  latest: null,
  state: "current",
} as const;

type Input = {
  preview?: boolean;
  action?: string;
  version: string;
  contentHash: string;
  github: { commit: string };
  targets: Array<{ machineId: string; expectedHash?: string }>;
};
const calls = () => mocks.push.mock.calls.map(([arg]) => (arg as { input: Input }).input);

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  mocks.scopes.clear();
  for (const scope of ["environment:maintain", "settings:write"]) mocks.scopes.add(scope);
  mocks.machines = [
    machine("m5", { environmentId: "env-m5" }),
    machine("m4"),
    machine("linux-mini", { status: "unreachable" }),
    machine("m1"),
    machine("old"),
  ];
  mocks.keep.mockResolvedValue(success({ records: [] }));
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.resetAllMocks();
});

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));
const render = async () => {
  await act(async () =>
    root.render(
      <SkillRollout environmentId={environmentId} projectId={projectId} status={STATUS} />,
    ),
  );
  await flush();
};
const box = (id: string) =>
  host.querySelector<HTMLElement>(
    `[data-testid="skill-rollout"] fieldset [data-machine="${id}"] [role="checkbox"]`,
  )!;
const tick = async (id: string) => {
  await act(async () => box(id).click());
};
const button = (text: string | RegExp) => {
  const node = [...host.querySelectorAll("button")].find((entry) =>
    typeof text === "string"
      ? entry.textContent?.trim() === text
      : text.test(entry.textContent ?? ""),
  );
  if (!node) throw new Error(`Missing button ${String(text)}`);
  return node;
};
const click = async (text: string | RegExp) => {
  await act(async () => button(text).click());
  await flush();
};
const places = () => host.querySelector('[data-testid="skill-rollout-places"]')!.textContent;
const result = (id: string) =>
  host.querySelector<HTMLElement>(`[data-testid="skill-rollout-results"] [data-machine="${id}"]`);

/** Previews: m4 and m1 get it, `old` runs a version that cannot preview. */
const previewRows = (machineIds: string[]) =>
  machineIds.map((machineId) =>
    machineId === "old"
      ? { machineId, ok: false, reason: "unsupported", message: "update it first" }
      : {
          machineId,
          ok: true,
          preview: true,
          expectedHash: `fp-${machineId}`,
          installedVersion: null,
          files: [`/home/u/.agents/skills/html-report/SKILL.md`],
          via: machineId === "m1" ? "npx" : "vskill",
          previous: null,
        },
  );

describe("Also add on", () => {
  it("starts unticked, says where the change goes and lists disabled machines with their reason", async () => {
    mocks.push.mockImplementation(async ({ input }: { input: Input }) =>
      success({ results: previewRows(input.targets.map((target) => target.machineId)) }),
    );
    await render();
    // The first look previews every machine that may get it; nothing is sent to an offline one.
    expect(calls()[0]!.preview).toBe(true);
    expect(calls()[0]!.targets.map((target) => target.machineId)).toEqual(["m4", "m1", "old"]);
    expect(places()).toBe("On M5 only.");
    expect(box("m4").getAttribute("aria-checked")).toBe("false");
    expect(host.textContent).toContain("linux-mini is offline");
    expect(host.textContent).toContain("old needs a newer SpecWithCode to preview this");
    expect(box("linux-mini").hasAttribute("data-disabled")).toBe(true);
    await tick("m4");
    expect(places()).toBe("On M5 and m4.");
    expect(button(/^Save on/).textContent).toBe("Save on M5 and m4");
    // The review shows that machine's own version and files.
    const review = host.querySelector('[data-testid="skill-rollout-review"] [data-machine="m4"]')!;
    expect(review.textContent).toContain("gets html-report 1.1.3");
    expect(review.textContent).toContain(".agents/skills/html-report/SKILL.md");
  });

  it("saves only the reviewed machines, keeps one row each, retries failed only and undoes per machine", async () => {
    let round = 0;
    mocks.push.mockImplementation(async ({ input }: { input: Input }) => {
      const ids = input.targets.map((target) => target.machineId);
      if (input.preview) return success({ results: previewRows(ids) });
      round += 1;
      return success({
        results: ids.map((machineId) =>
          machineId === "m4"
            ? input.action === "remove"
              ? { machineId, ok: true, removed: true, via: "vskill" }
              : { machineId, ok: true, installedVersion: "1.1.3", via: "vskill", previous: null }
            : round === 1
              ? { machineId, ok: false, reason: "install-failed", message: "vskill exited 1" }
              : { machineId, ok: true, installedVersion: "1.1.3", via: "npx", previous: null },
        ),
      });
    });
    await render();
    await tick("m4");
    await tick("m1");
    await click("Save on M5, m4 and m1");
    const save = calls().find((input) => !input.preview)!;
    expect(save.targets).toEqual([
      { machineId: "m4", scope: "user", expectedHash: "fp-m4" },
      { machineId: "m1", scope: "user", expectedHash: "fp-m1" },
    ]);
    expect(save.github.commit).toBe(COMMIT);
    expect(result("m4")!.textContent).toContain("Added");
    expect(result("m1")!.textContent).toContain("Failed: vskill exited 1");

    mocks.push.mockClear();
    await click("Retry failed (1)");
    // Retry asks m1 again and never m4, the verified success.
    expect(calls().flatMap((input) => input.targets.map((target) => target.machineId))).toEqual([
      "m1",
      "m1",
    ]);
    expect(result("m1")!.textContent).toContain("Added via npx vskill");
    expect(result("m4")!.textContent).toContain("Added");

    mocks.push.mockClear();
    await act(async () =>
      [...result("m4")!.querySelectorAll("button")]
        .find((node) => node.textContent === "Undo")!
        .click(),
    );
    await flush();
    expect(
      calls().map((input) => [input.action, input.preview ?? false, input.targets[0]!.machineId]),
    ).toEqual([
      ["remove", true, "m4"],
      ["remove", false, "m4"],
    ]);
    expect(result("m4")!.textContent).toContain("Removed");
    expect(result("m1")!.textContent).toContain("Added via npx vskill");
  });

  it("stores Keep updated on this machine only and ticks those machines next time", async () => {
    mocks.push.mockImplementation(async ({ input }: { input: Input }) =>
      input.preview
        ? success({ results: previewRows(input.targets.map((target) => target.machineId)) })
        : success({
            results: input.targets.map((target) => ({
              machineId: target.machineId,
              ok: true,
              installedVersion: "1.1.3",
              via: "vskill",
              previous: null,
            })),
          }),
    );
    mocks.keep.mockImplementation(async ({ input }: { input: { operation: string } }) =>
      success({
        records:
          input.operation === "read"
            ? [
                {
                  repo: "anton-abyzov/vskill",
                  skill: "html-report",
                  scope: "user",
                  machineIds: ["m4"],
                  updatedAt: "2026-11-18T00:00:00.000Z",
                },
              ]
            : [],
      }),
    );
    await render();
    // A stored record offers the same machines again, ticked, behind the same Save.
    expect(box("m4").getAttribute("aria-checked")).toBe("true");
    expect(places()).toBe("On M5 and m4.");
    expect(calls().every((input) => input.preview)).toBe(true);
    await click("Save on M5 and m4");
    const set = mocks.keep.mock.calls
      .map(([arg]) => (arg as { input: { operation: string; machineIds?: string[] } }).input)
      .find((input) => input.operation === "set")!;
    expect(set.machineIds).toEqual(["m4"]);
  });

  it("sends nothing when the sign-in cannot maintain machines from here", async () => {
    mocks.scopes.clear();
    await render();
    expect(mocks.push).not.toHaveBeenCalled();
    expect(box("m4").hasAttribute("data-disabled")).toBe(true);
  });
});
