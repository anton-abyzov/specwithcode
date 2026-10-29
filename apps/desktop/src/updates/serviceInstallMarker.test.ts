import * as DateTime from "effect/DateTime";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Fixture paths use the host's path flavour, as the service does.
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  SERVICE_INSTALL_LIMIT_MS,
  SERVICE_INSTALL_WINDOW_MS,
  type ServiceInstallMarkerFile,
  serviceInstallInProgress,
} from "./serviceInstallMarker.ts";

const NOW = Date.parse("2026-10-12T12:00:00.000Z");
const HOME = NodePath.resolve("/home/m4");
const MARKER = NodePath.join(HOME, "updates", "install-in-progress.json");
const RECEIPT = NodePath.join(HOME, "updates", "receipts", "update-1.0.7-20261012.json");
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const io = (
  files: Readonly<Record<string, string | ServiceInstallMarkerFile>>,
  alive: ReadonlyArray<number> = [],
) => ({
  readFile: (path: string) => {
    const file = files[path];
    if (file === undefined) return null;
    return typeof file === "string" ? { text: file, mtimeMs: NOW } : file;
  },
  isProcessAlive: (pid: number) => alive.includes(pid),
});
const marker = (value: object) => ({ [MARKER]: JSON.stringify(value) });

describe("serviceInstallInProgress", () => {
  it("is false without a marker", () => {
    expect(serviceInstallInProgress(HOME, NOW, io({}))).toBe(false);
  });

  it("reads the marker from the service's updates directory", () => {
    const paths: string[] = [];
    serviceInstallInProgress(HOME, NOW, {
      readFile: (path) => {
        paths.push(path);
        return null;
      },
      isProcessAlive: () => true,
    });
    expect(paths).toEqual([MARKER]);
  });

  it("holds while the marker is inside the install window", () => {
    const files = marker({ version: "1.0.7", at: iso(NOW - 60_000) });
    expect(serviceInstallInProgress(HOME, NOW, io(files))).toBe(true);
  });

  it("lets go once the agent stops waiting for the helper", () => {
    const files = marker({ at: iso(NOW - SERVICE_INSTALL_WINDOW_MS) });
    expect(serviceInstallInProgress(HOME, NOW, io(files))).toBe(false);
  });

  it("ignores a marker dated far ahead of this clock", () => {
    const files = marker({ at: iso(NOW + SERVICE_INSTALL_WINDOW_MS + 1) });
    expect(serviceInstallInProgress(HOME, NOW, io(files))).toBe(false);
  });

  it("dates a marker being written from its file", () => {
    expect(
      serviceInstallInProgress(HOME, NOW, io({ [MARKER]: { text: "{", mtimeMs: NOW - 1_000 } })),
    ).toBe(true);
    expect(
      serviceInstallInProgress(
        HOME,
        NOW,
        io({ [MARKER]: { text: "{", mtimeMs: NOW - SERVICE_INSTALL_WINDOW_MS } }),
      ),
    ).toBe(false);
  });

  describe("after the agent stopped waiting", () => {
    // Past the agent's wait, inside the hard limit.
    const PAST_WINDOW_MS = SERVICE_INSTALL_WINDOW_MS + 5 * 60_000;
    const late = (ageMs: number, receipt: string = RECEIPT) => ({
      ...marker({ version: "1.0.7", receipt, at: iso(NOW - ageMs) }),
      [RECEIPT]: JSON.stringify({ phase: "restart-requested", helperPid: 4242 }),
    });

    it("holds while the helper named in its receipt still runs", () => {
      expect(serviceInstallInProgress(HOME, NOW, io(late(PAST_WINDOW_MS), [4242]))).toBe(true);
    });

    it("lets go once that helper exits", () => {
      expect(serviceInstallInProgress(HOME, NOW, io(late(PAST_WINDOW_MS), []))).toBe(false);
    });

    it("never trusts a live pid past the hard limit", () => {
      expect(serviceInstallInProgress(HOME, NOW, io(late(SERVICE_INSTALL_LIMIT_MS), [4242]))).toBe(
        false,
      );
    });

    it("reads only a receipt kept for this home", () => {
      const elsewhere = "/home/other/updates/receipts/update-1.0.7.json";
      const files = {
        ...late(PAST_WINDOW_MS, elsewhere),
        [elsewhere]: JSON.stringify({ helperPid: 4242 }),
      };
      expect(serviceInstallInProgress(HOME, NOW, io(files, [4242]))).toBe(false);
      const traversal = "/home/m4/updates/receipts/../../../other/x.json";
      expect(serviceInstallInProgress(HOME, NOW, io(late(PAST_WINDOW_MS, traversal), [4242]))).toBe(
        false,
      );
    });

    it("needs a helper pid from an older helper's receipt", () => {
      const files = { ...late(PAST_WINDOW_MS), [RECEIPT]: JSON.stringify({ phase: "prepared" }) };
      expect(serviceInstallInProgress(HOME, NOW, io(files, [4242]))).toBe(false);
    });

    it("never counts this process or a missing receipt", () => {
      const own = {
        ...late(PAST_WINDOW_MS),
        [RECEIPT]: JSON.stringify({ helperPid: process.pid }),
      };
      expect(serviceInstallInProgress(HOME, NOW, io(own, [process.pid]))).toBe(false);
      const missing = marker({ receipt: RECEIPT, at: iso(NOW - PAST_WINDOW_MS) });
      expect(serviceInstallInProgress(HOME, NOW, io(missing, [4242]))).toBe(false);
    });
  });
});
