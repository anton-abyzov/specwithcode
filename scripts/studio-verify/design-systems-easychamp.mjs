// Local-only: runs the design-system extractors against real systems on this
// Mac, read in place (ec-uikit is private; nothing is copied). Writes a
// receipt of counts and file:line samples to the folder given as the first
// argument. Optional environment: EC_UIKIT_ROOT, SPECWEAVE_UMBRELLA.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const output = resolve(
  process.argv[2] ??
    join(
      homedir(),
      "Projects/github/studio-research-notes/design-workspace-2026-10-20/design-systems",
    ),
);
const env = {
  ...process.env,
  DESIGN_SYSTEMS_RECEIPT: join(output, "receipt-local-systems.json"),
  DESIGN_SYSTEMS_EC_UIKIT:
    process.env.EC_UIKIT_ROOT ??
    join(homedir(), "Projects/sw-easychamp/repositories/anton-abyzov/ec-uikit"),
  DESIGN_SYSTEMS_UMBRELLA:
    process.env.SPECWEAVE_UMBRELLA ?? join(homedir(), "Projects/github/specweave-umb"),
  DESIGN_SYSTEMS_APP: resolve("."),
};
for (const key of ["DESIGN_SYSTEMS_EC_UIKIT", "DESIGN_SYSTEMS_UMBRELLA"]) {
  if (!existsSync(env[key])) {
    console.error(`${key} not found: ${env[key]}`);
    process.exit(1);
  }
}
const run = spawnSync(
  process.execPath,
  [
    "node_modules/vite-plus/bin/vp",
    "test",
    "run",
    "apps/server/src/design/systems/localSources.test.ts",
  ],
  { env, stdio: "inherit" },
);
if (run.status === 0) console.log(`Receipt: ${env.DESIGN_SYSTEMS_RECEIPT}`);
process.exit(run.status ?? 1);
