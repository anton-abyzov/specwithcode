import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  type ProjectSkillSourceStatus,
  type ProjectSkillsFleetPushResult,
} from "@specweave-studio/contracts";
import type { StudioFleetMachine } from "@specweave-studio/contracts/studioFleet";

import {
  placesPhrase,
  retryMachineIds,
  rolloutMachines,
  rolloutResultWords,
  rolloutSourceOf,
  savePhrase,
  undoPlanOf,
  withPreviewRefusals,
} from "./SkillRollout.logic";

type Row = ProjectSkillsFleetPushResult["results"][number];

const COMMIT = "c".repeat(40);
const HASH = "d".repeat(64);
const self = EnvironmentId.make("env-m5");

const status = (fields: Partial<ProjectSkillSourceStatus> = {}): ProjectSkillSourceStatus => ({
  skill: "html-report",
  repo: "anton-abyzov/vskill",
  lockScope: "user",
  installed: { version: "1.1.3", commit: COMMIT, contentHash: HASH },
  installedSource: { path: "skills/html-report/SKILL.md", branch: "main" },
  latest: null,
  state: "current",
  ...fields,
});

const machine = (id: string, fields: Partial<StudioFleetMachine> = {}): StudioFleetMachine => ({
  id: id as never,
  label: id,
  environmentId: EnvironmentId.make(`env-${id}`),
  url: `http://${id}:8319`,
  status: "reachable",
  pairingConfigured: true,
  ...fields,
});

const text = (phrase: { text: string; values?: Record<string, string> }) =>
  phrase.text.replace(/\{(\w+)\}/g, (_, key: string) => phrase.values?.[key] ?? "");

describe("the source a rollout sends", () => {
  it("is one connected repo at one commit with its content hash", () => {
    expect(rolloutSourceOf(status())).toEqual({
      ok: true,
      source: {
        skillId: "anton-abyzov/vskill/html-report",
        repo: "anton-abyzov/vskill",
        skill: "html-report",
        version: "1.1.3",
        contentHash: HASH,
        scope: "user",
        github: {
          kind: "github",
          path: "skills/html-report/SKILL.md",
          branch: "main",
          commit: COMMIT,
        },
      },
    });
  });

  it("names why a skill cannot roll out", () => {
    expect(rolloutSourceOf(status({ repo: null }))).toMatchObject({ ok: false });
    expect(
      rolloutSourceOf(status({ installed: { version: null, commit: COMMIT, contentHash: HASH } })),
    ).toMatchObject({ ok: false, reason: { text: expect.stringMatching(/version/) } });
    expect(rolloutSourceOf(status({ lockScope: "project" }))).toMatchObject({ ok: false });
    const { installedSource: _drop, ...noSource } = status();
    expect(rolloutSourceOf(noSource)).toMatchObject({ ok: false });
  });
});

describe("the machines offered", () => {
  it("lists every other machine unticked and disables the ones nothing may be sent to", () => {
    const list = rolloutMachines(
      [
        machine("m5", { environmentId: self }),
        machine("m4"),
        machine("linux-mini", { status: "unreachable" }),
        machine("m1", { pairingConfigured: false }),
        machine("old", { status: "identity-mismatch" }),
      ],
      self,
    );
    expect(list.map((entry) => entry.machineId)).toEqual(["m4", "linux-mini", "m1", "old"]);
    expect(list[0]!.disabled).toBeNull();
    expect(text(list[1]!.disabled!)).toBe("linux-mini is offline");
    expect(text(list[2]!.disabled!)).toMatch(/sign-in cannot change skills on m1/);
    expect(text(list[3]!.disabled!)).toMatch(/old/);
  });

  it("disables a machine whose preview says it is too old or the sign-in cannot write", () => {
    const list = withPreviewRefusals(rolloutMachines([machine("m4"), machine("m1")], self), [
      { machineId: "m4", ok: false, reason: "unsupported", message: "update it first" },
      { machineId: "m1", ok: false, reason: "unauthorized", message: "token" },
    ]);
    expect(text(list[0]!.disabled!)).toMatch(/m4 needs a newer SpecWithCode/);
    expect(text(list[1]!.disabled!)).toMatch(/sign-in cannot change skills on m1/);
  });

  it("keeps a machine enabled when its preview has a reason the review shows", () => {
    const list = withPreviewRefusals(rolloutMachines([machine("m4")], self), [
      { machineId: "m4", ok: false, reason: "no-access", message: "No GitHub access" },
    ]);
    expect(list[0]!.disabled).toBeNull();
  });
});

describe("the words around Save", () => {
  it("says where the change goes", () => {
    expect(text(placesPhrase("M5", []))).toBe("On M5 only.");
    expect(text(placesPhrase("M5", ["m4"]))).toBe("On M5 and m4.");
    expect(text(placesPhrase("M5", ["m4", "linux-mini"]))).toBe("On M5, m4 and linux-mini.");
    expect(text(savePhrase("M5", ["m4"]))).toBe("Save on M5 and m4");
    expect(text(savePhrase("M5", []))).toBe("Save on M5");
  });
});

describe("one result row per machine", () => {
  const ok = (fields: Partial<Row> = {}): Row => ({
    machineId: "m4",
    ok: true,
    installedVersion: "1.1.3",
    via: "vskill",
    previous: null,
    ...fields,
  });

  it("uses the shared and skill-only words", () => {
    expect(text(rolloutResultWords(ok()))).toBe("Added");
    expect(text(rolloutResultWords(ok({ via: "npx" })))).toBe("Added via npx vskill");
    expect(
      text(
        rolloutResultWords(
          ok({
            previous: {
              version: "1.1.2",
              commit: null,
              contentHash: null,
              branch: null,
              path: null,
            },
          }),
        ),
      ),
    ).toBe("Updated to 1.1.3");
    expect(
      text(rolloutResultWords({ machineId: "m4", ok: false, reason: "name-taken", message: "x" })),
    ).toBe("Skipped, the name is already used there");
    expect(
      text(
        rolloutResultWords({ machineId: "m4", ok: false, reason: "vskill-missing", message: "x" }),
      ),
    ).toBe("vskill and npx missing");
    expect(
      text(rolloutResultWords({ machineId: "m4", ok: false, reason: "no-access", message: "x" })),
    ).toBe("No access");
    expect(
      text(
        rolloutResultWords({
          machineId: "m4",
          ok: false,
          reason: "install-failed",
          message: "vskill exited 1",
        }),
      ),
    ).toBe("Failed: vskill exited 1");
    expect(text(rolloutResultWords(ok({ removed: true })))).toBe("Removed");
  });

  it("retries only machines that failed, never a verified success or a skip", () => {
    expect(
      retryMachineIds([
        ok({ machineId: "m4" }),
        { machineId: "linux-mini", ok: false, reason: "unreachable", message: "offline" },
        { machineId: "m1", ok: false, reason: "name-taken", message: "taken" },
        { machineId: "m2", ok: false, reason: "no-access", message: "no" },
      ]),
    ).toEqual(["linux-mini", "m2"]);
  });

  it("undoes a new install by removing it and an update by restoring the copy it replaced", () => {
    const source = rolloutSourceOf(status());
    if (!source.ok) throw new Error("no source");
    expect(undoPlanOf(ok(), source.source)).toEqual({
      kind: "remove",
      version: "1.1.3",
      contentHash: HASH,
      github: source.source.github,
    });
    const previous = {
      version: "1.1.2",
      commit: "e".repeat(40),
      contentHash: "f".repeat(64),
      branch: "main",
      path: "skills/html-report/SKILL.md",
    };
    expect(undoPlanOf(ok({ previous }), source.source)).toEqual({
      kind: "restore",
      version: "1.1.2",
      contentHash: "f".repeat(64),
      github: {
        kind: "github",
        path: "skills/html-report/SKILL.md",
        branch: "main",
        commit: "e".repeat(40),
      },
    });
    expect(
      undoPlanOf(ok({ previous: { ...previous, commit: null } }), source.source),
    ).toMatchObject({ kind: "none" });
    expect(undoPlanOf(ok({ removed: true }), source.source)).toMatchObject({ kind: "none" });
  });
});
