// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native filesystem checks verify the deployable updater files rather than an Effect service mock.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native path resolves independent deployment fixture files.
import * as NodePath from "node:path";
import { assert, it } from "@effect/vitest";

import {
  MAC_SERVICE_UPDATER_FILES,
  MAC_SERVICE_UPDATER_EXTRA_RESOURCES,
} from "./studio-service-updater.ts";

it("ships the complete local dependency graph of the installed service updater", () => {
  const fleet = NodePath.join(import.meta.dirname, "..", "studio-fleet");
  const local = new Set(NodeFS.readdirSync(fleet).filter((name) => name.endsWith(".py")));
  const required = new Set<string>();
  // Migration and relay ownership are independent installed entry points.
  const pending = [
    "update_agent.py",
    "managed_updates.py",
    "migrate_home.py",
    "relay_ownership.py",
  ];
  while (pending.length > 0) {
    const name = pending.pop()!;
    if (required.has(name)) continue;
    required.add(name);
    const source = NodeFS.readFileSync(NodePath.join(fleet, name), "utf8");
    for (const match of source.matchAll(/^(?:import|from) ([a-z_]+)\b/gm)) {
      const sibling = `${match[1]}.py`;
      if (local.has(sibling)) pending.push(sibling);
    }
  }
  assert.include([...required], "installation_descriptor.py");
  assert.include([...required], "managed_updates.py");
  assert.include([...required], "update_agent_cache.py");
  assert.include([...required], "update_agent_recovery.py");
  assert.deepStrictEqual([...MAC_SERVICE_UPDATER_FILES].sort(), [...required].sort());
  assert.equal(new Set(MAC_SERVICE_UPDATER_FILES).size, MAC_SERVICE_UPDATER_FILES.length);
  for (const file of MAC_SERVICE_UPDATER_FILES) {
    assert.isTrue(NodeFS.statSync(NodePath.join(fleet, file)).isFile(), file);
  }
});

it("retains the installed resource location used by existing desktop updates", () => {
  assert.deepStrictEqual(MAC_SERVICE_UPDATER_EXTRA_RESOURCES, [
    { from: "apps/desktop/prod-resources/studio-updater", to: "studio-updater" },
  ]);
});
