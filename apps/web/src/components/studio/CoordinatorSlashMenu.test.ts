import { ProviderDriverKind, type ServerProvider } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import { HARNESSES, TYPED_PER_HARNESS } from "./CoordinatorHarnesses.testkit";
import { resolveLeadingSkillCommand } from "../../providerSkillSearch";
import { coordinatorSlashItems } from "./CoordinatorSlashMenu";

const provider = {
  driverKind: ProviderDriverKind.make("codex"),
  snapshot: {
    skills: [
      { name: "sw:do", displayName: "SpecWeave Do", path: "/p/do/SKILL.md", enabled: true },
      { name: "sw:handoff", path: "/p/handoff/SKILL.md", enabled: true },
    ],
    slashCommands: [],
  } as unknown as ServerProvider,
};

describe("coordinatorSlashItems", () => {
  it("lists app commands first, then skills by the text that runs them", () => {
    const items = coordinatorSlashItems("", { onAppCommand: () => {}, provider, cwd: "/work" });
    const labels = items.map((item) => item.label);
    expect(labels.slice(0, 2)).toEqual(["/stop", "/continue"]);
    expect(labels).toContain("$sw:do");
    expect(labels).not.toContain("/skill:sw:do");
  });

  it("finds a skill by its id as typed after the slash, with or without the old skill: prefix", () => {
    for (const query of ["sw:do", "skill:sw:do"]) {
      const skills = coordinatorSlashItems(query, { onAppCommand: null, provider, cwd: "/work" });
      expect(skills[0]?.label).toBe("$sw:do");
    }
  });
});

describe.each(HARNESSES)("the $label coordinator", (harness) => {
  const own = harness.snapshot.skills.map((skill) => `$${skill.name}`);
  const coordinator = { driverKind: harness.driverKind, snapshot: harness.snapshot };

  it("lists its own skills and nothing another harness loads", () => {
    const labels = coordinatorSlashItems("", {
      onAppCommand: null,
      provider: coordinator,
      cwd: "/work",
    }).map((item) => item.label);
    expect(labels.toSorted()).toEqual(own.toSorted());
    const foreign = new Set(
      HARNESSES.filter((other) => other.id !== harness.id)
        .flatMap((other) => other.snapshot.skills.map((skill) => `$${skill.name}`))
        .filter((label) => !own.includes(label)),
    );
    expect(labels.filter((label) => foreign.has(label))).toEqual([]);
  });

  it("sends a typed /name as a skill only when this harness runs that skill", () => {
    for (const [typed, sent] of Object.entries(TYPED_PER_HARNESS[harness.id])) {
      expect(resolveLeadingSkillCommand(typed, harness.snapshot, "/work"), typed).toBe(sent);
    }
  });
});
