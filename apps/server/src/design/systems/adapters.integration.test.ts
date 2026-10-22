// @effect-diagnostics nodeBuiltinImport:off - Lays out and inspects the fixture checkout.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  PROJECT_A,
  agentIn,
  layerDesignService,
  makeDesignFixture,
  owner,
  type DesignFixture,
} from "../DesignService.testkit.ts";
import { DesignService } from "../DesignService.ts";
import * as DesignSystems from "./adapters.ts";
import { DesignSystemProposals, DesignSystemService } from "./DesignSystemService.ts";

const fixtures: DesignFixture[] = [];
afterEach(() => {
  for (const fixture of fixtures.splice(0)) fixture.cleanup();
});

const CSS = [
  ":root {",
  ...Array.from({ length: 10 }, (_, index) => `  --acme-space-${index}: ${index * 4}px;`),
  "  --acme-ink: #111;",
  "}",
  ".dark {",
  "  --acme-ink: #eee;",
  "}",
  "",
].join("\n");

const listTree = (root: string): string[] =>
  NodeFS.readdirSync(root, { recursive: true, encoding: "utf8" }).sort();

describe("design systems over the design service", () => {
  it("scans and proposes without touching the checkout; only a confirm writes", async () => {
    const fixture = makeDesignFixture();
    fixtures.push(fixture);
    const checkout = fixture.roots[PROJECT_A]!;
    NodeFS.mkdirSync(NodePath.join(checkout, "src/styles"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(checkout, "src/styles/theme.css"), CSS);
    const before = listTree(checkout);
    const project = { kind: "project" as const, projectId: PROJECT_A };

    const layer = DesignSystems.layer.pipe(
      Layer.provide(DesignSystemProposals.layer),
      Layer.provideMerge(layerDesignService(fixture)),
    );
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const systems = yield* DesignSystemService;
        const scan = yield* systems.scan(agentIn(PROJECT_A), { owner: project });
        const proposal = yield* systems.propose(agentIn(PROJECT_A), {
          owner: project,
          from: { kind: "code", paths: scan.suggestions[0]!.paths },
        });
        yield* systems.rescan(owner, { owner: project, systemId: "missing" }).pipe(Effect.flip);
        const afterScan = listTree(checkout);
        const confirmed = yield* systems.confirm(owner, {
          proposalId: proposal.id,
          excludeTokens: [],
          excludeComponents: [],
        });
        // design_system_get reads through DesignService, so an agent sees the import (AC-10).
        const fetched = yield* (yield* DesignService).systemGet(agentIn(PROJECT_A), {
          owner: project,
          systemId: confirmed.system.id,
        });
        return { scan, afterScan, confirmed, fetched };
      }).pipe(Effect.provide(layer)),
    );

    expect(result.scan.suggestions[0]!.paths).toEqual(["src/styles/theme.css"]);
    // Scan, proposal and a failed rescan left the checkout exactly as it was.
    expect(result.afterScan).toEqual(before);
    expect(result.afterScan.some((path) => path.startsWith(".specweave"))).toBe(false);
    expect(result.confirmed.ref.path).toBe(
      `.specweave/design/systems/${result.confirmed.system.id}/system.json`,
    );
    expect(NodeFS.existsSync(NodePath.join(checkout, result.confirmed.ref.path))).toBe(true);
    expect(result.fetched.system).toEqual(result.confirmed.system);
  });
});
