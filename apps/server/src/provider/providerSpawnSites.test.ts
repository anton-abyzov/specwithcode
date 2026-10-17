// @effect-diagnostics nodeBuiltinImport:off - a structural test that reads server source files.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

import {
  HEADLESS_ENVIRONMENT_HELPERS,
  NON_AGENT_PROVIDER_SPAWNS,
  PROCESS_SPAWN_PATTERN,
  PROVIDER_ADAPTER_PROCESS_CHAINS,
  PROVIDER_PROCESS_SPAWN_SITES,
  PROVIDER_SPAWN_SCAN_DIRECTORIES,
} from "./providerSpawnSites.ts";

const sourceRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const read = (path: string) => NodeFS.readFileSync(NodePath.join(sourceRoot, path), "utf8");
const isProductionSource = (path: string) =>
  /\.(?:[cm]?[jt]s)$/.test(path) &&
  !/\.test\.|\.testkit\.|\.fixture\.|\.testFixtures\.|\/testing\/|\/testkit\//.test(path);

function listSources(directory: string): Array<string> {
  return NodeFS.readdirSync(NodePath.join(sourceRoot, directory), { withFileTypes: true }).flatMap(
    (entry) => {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory()) return listSources(path);
      return isProductionSource(path) ? [path] : [];
    },
  );
}

const appliesHeadlessEnvironment = (source: string) =>
  HEADLESS_ENVIRONMENT_HELPERS.some((helper) => source.includes(helper));

describe("provider spawn sites", () => {
  it("apply the headless browser environment at every listed spawn site", () => {
    const missing = Object.keys(PROVIDER_PROCESS_SPAWN_SITES).filter(
      (path) => !appliesHeadlessEnvironment(read(path)),
    );
    expect(missing).toEqual([]);
  });

  it("no longer spread the constant by hand, so the override order cannot drift", () => {
    const handSpread = Object.keys(PROVIDER_PROCESS_SPAWN_SITES).filter((path) =>
      read(path).includes("...HEADLESS_BROWSER_ENVIRONMENT"),
    );
    expect(handSpread).toEqual([]);
  });

  it("classify every process spawn in the provider directories", () => {
    // A new spawn fails here until it is listed as a provider spawn site
    // (and applies the helper) or as a probe that runs no agent.
    const classified = new Set([
      ...Object.keys(PROVIDER_PROCESS_SPAWN_SITES),
      ...Object.keys(NON_AGENT_PROVIDER_SPAWNS),
    ]);
    const spawning = PROVIDER_SPAWN_SCAN_DIRECTORIES.flatMap(listSources).filter((path) =>
      PROCESS_SPAWN_PATTERN.test(read(path)),
    );
    expect(spawning.filter((path) => !classified.has(path))).toEqual([]);
    // Stale entries would hide a removed or renamed site.
    expect([...classified].filter((path) => !spawning.includes(path))).toEqual([]);
  });

  it("reach a listed spawn site from every provider adapter", () => {
    const adapters = listSources("orchestration-v2/Adapters").filter((path) =>
      path.endsWith("AdapterV2.ts"),
    );
    expect(adapters.toSorted()).toEqual(Object.keys(PROVIDER_ADAPTER_PROCESS_CHAINS).toSorted());
    for (const [adapter, { chain }] of Object.entries(PROVIDER_ADAPTER_PROCESS_CHAINS)) {
      if (chain === null) continue;
      const steps = [adapter, ...chain.filter((step) => step !== adapter)];
      for (let index = 1; index < steps.length; index += 1) {
        const importer = steps[index - 1]!;
        const imported = NodePath.basename(steps[index]!);
        expect(read(importer), `${importer} imports ${imported}`).toMatch(
          new RegExp(`from "[^"]*/${imported.replaceAll(".", "\\.")}"`),
        );
      }
      expect(PROVIDER_PROCESS_SPAWN_SITES).toHaveProperty([steps.at(-1)!]);
    }
  });
});
