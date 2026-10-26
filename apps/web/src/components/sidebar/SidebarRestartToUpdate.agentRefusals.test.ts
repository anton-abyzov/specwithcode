// @effect-diagnostics-next-line nodeBuiltinImport:off -- a test that reads the agent's source.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- a test that reads the agent's source.
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import type { StudioServiceUpdateState } from "@specweave-studio/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  DETACHED_DATABASE_REFUSAL,
  isRestartRefusalWithRelease,
  isServiceErrorWithRelease,
  LOCKS_LOST_REFUSAL,
  serviceRefusalText,
} from "./SidebarRestartToUpdate.logic";

/**
 * The refusals Update now gets past are matched by their exact text, so the
 * web copy must stay the agent's: scripts/studio-fleet/service_handles.py
 * words them (DETACHED_DATABASE, LOCKS_LOST) and update_agent writes them
 * after "SpecWithCode cannot be updated right now: ".
 */
const sidebar = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const SERVICE_HANDLES = NodePath.resolve(
  sidebar,
  "../../../../../scripts/studio-fleet/service_handles.py",
);

/** A module-level `NAME = ('...' '...')` string constant, its pieces joined as Python does. */
function pythonConstant(source: string, name: string): string {
  const start = source.search(new RegExp(`^${name} = \\(`, "m"));
  expect(start).toBeGreaterThanOrEqual(0);
  const end = source.indexOf(")", start);
  const pieces = [...source.slice(start, end).matchAll(/'((?:[^'\\]|\\.)*)'/g)];
  return pieces.map((piece) => piece[1]).join("");
}

const PREFIX = "SpecWithCode cannot be updated right now: ";

const refused = (message: string): StudioServiceUpdateState => ({
  status: "error",
  identity: "m4",
  installedVersion: "1.0.62",
  availableVersion: "1.0.63",
  downloadedVersion: "1.0.63",
  checkedAt: "2026-10-26T14:00:00.000Z",
  quietSince: null,
  message,
  lastInstall: null,
});

describe("the agent's restart-needed refusals", () => {
  const source = NodeFS.readFileSync(SERVICE_HANDLES, "utf8");

  it("are the texts service_handles.py writes", () => {
    expect(pythonConstant(source, "DETACHED_DATABASE")).toBe(DETACHED_DATABASE_REFUSAL);
    expect(pythonConstant(source, "LOCKS_LOST")).toBe(LOCKS_LOST_REFUSAL);
  });

  it("offer Update now for either, as the agent writes it", () => {
    for (const name of ["DETACHED_DATABASE", "LOCKS_LOST"]) {
      const message = `${PREFIX}${pythonConstant(source, name)}`;
      expect(isServiceErrorWithRelease(refused(message))).toBe(true);
      expect(isRestartRefusalWithRelease(refused(message))).toBe(true);
      expect(serviceRefusalText(message)).toBe(message);
    }
  });

  it("does not offer Update now as the fix for any other restart-needed text", () => {
    for (const message of [
      `${PREFIX}The SpecWithCode service lost its hold on its database. SpecWithCode will try again`,
      `${PREFIX}The SpecWithCode service needs a restart. SpecWithCode will try again`,
      "SpecWithCode will try again",
    ]) {
      expect(isServiceErrorWithRelease(refused(message))).toBe(false);
      expect(isRestartRefusalWithRelease(refused(message))).toBe(false);
      // Its words are shown as the agent wrote them.
      expect(serviceRefusalText(message)).toBe(message);
    }
  });
});
