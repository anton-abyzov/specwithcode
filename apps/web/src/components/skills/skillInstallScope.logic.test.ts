import { describe, expect, it } from "vite-plus/test";
import { ProjectId } from "@specweave-studio/contracts";

import { resolveSkillInstallScope, skillInstallScopeDefaultPatch } from "./skillInstallScope.logic";

const projectId = ProjectId.make("p1");
const base = {
  userLevel: false,
  projectOverride: undefined,
  personalAssistant: false,
  machineDefault: "project",
} as const;

describe("resolveSkillInstallScope", () => {
  it("installs for you in the machine view, whatever the defaults say", () => {
    expect(
      resolveSkillInstallScope({ ...base, userLevel: true, projectOverride: "project" }),
    ).toEqual({ scope: "user", source: "machine-view" });
  });

  it("lets the project's own setting win over Percy and the machine", () => {
    expect(
      resolveSkillInstallScope({
        ...base,
        projectOverride: "project",
        personalAssistant: true,
        machineDefault: "user",
      }),
    ).toEqual({ scope: "project", source: "project" });
  });

  it("installs for you from Percy's project when it has no setting of its own", () => {
    expect(resolveSkillInstallScope({ ...base, personalAssistant: true })).toEqual({
      scope: "user",
      source: "assistant",
    });
  });

  it("falls back to the machine default", () => {
    expect(resolveSkillInstallScope(base)).toEqual({ scope: "project", source: "machine" });
    expect(resolveSkillInstallScope({ ...base, machineDefault: "user" })).toEqual({
      scope: "user",
      source: "machine",
    });
  });
});

describe("skillInstallScopeDefaultPatch", () => {
  const settings = { projectSettingsOverrides: { [projectId]: { responseStyle: "concise" } } };

  it("writes the machine default as one key", () => {
    expect(
      skillInstallScopeDefaultPatch({
        level: "machine",
        scope: "user",
        projectId,
        settings: settings as never,
        perKey: true,
      }),
    ).toEqual({ skillInstallScope: "user" });
  });

  it("sets and clears only this project's key on a per-key server", () => {
    expect(
      skillInstallScopeDefaultPatch({
        level: "project",
        scope: "user",
        projectId,
        settings: settings as never,
        perKey: true,
      }),
    ).toEqual({
      projectSettingsOverrideChanges: { [projectId]: { set: { skillInstallScope: "user" } } },
    });
    expect(
      skillInstallScopeDefaultPatch({
        level: "project",
        scope: null,
        projectId,
        settings: settings as never,
        perKey: true,
      }),
    ).toEqual({
      projectSettingsOverrideChanges: { [projectId]: { clear: ["skillInstallScope"] } },
    });
  });

  it("keeps the project's other overrides on an older server that replaces the entry", () => {
    expect(
      skillInstallScopeDefaultPatch({
        level: "project",
        scope: "project",
        projectId,
        settings: settings as never,
        perKey: false,
      }),
    ).toEqual({
      projectSettingsOverrides: {
        [projectId]: { responseStyle: "concise", skillInstallScope: "project" },
      },
    });
  });
});

describe("install scope phrases", () => {
  it("has a translation for every phrase in every language", async () => {
    const NodeFS = await import("node:fs");
    const NodePath = await import("node:path");
    const NodeURL = await import("node:url");
    const here = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
    const logic = await import("./skillInstallScope.logic");
    const scanned = [
      "SkillInstallScopeChoice.tsx",
      "SkillSearch.tsx",
      "SkillUpdateRepos.tsx",
    ].flatMap((file) =>
      [
        ...NodeFS.readFileSync(NodePath.join(here, file), "utf8").matchAll(
          /\btx\(\s*("(?:[^"\\]|\\.)*")/g,
        ),
      ].map((match) => JSON.parse(match[1]!) as string),
    );
    const phrases = [
      ...new Set([
        ...scanned,
        ...Object.values(logic.SCOPE_LABELS),
        ...Object.values(logic.SCOPE_WHERE),
        ...Object.values(logic.SOURCE_PHRASES),
        ...Object.values(logic.PROGRESS_PHRASES),
        ...Object.values(logic.RECEIPT_SCOPE_PHRASES),
        logic.PROJECT_ROLLOUT_NOTE,
        logic.OLDER_SERVER_NOTE,
        "Where new skills install",
      ]),
    ];
    const catalogs = await Promise.all(
      ["de", "es", "fr", "ja", "ko", "pt", "ru", "zh"].map(
        async (locale) =>
          [locale, (await import(`../../i18n/phrases/${locale}.ts`))[locale]] as const,
      ),
    );
    for (const [locale, catalog] of catalogs)
      expect({
        locale,
        missing: phrases.filter((english) => !Object.hasOwn(catalog, english)),
      }).toEqual({
        locale,
        missing: [],
      });
  });
});
