// @effect-diagnostics-next-line nodeBuiltinImport:off - the test reads the file mode and a temp folder directly.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { join } from "../nodePath.ts";
import {
  ACCOUNT_JOIN_NEWS_MS,
  FLEET_ACCOUNT_JOINS_FILE,
  readAccountJoins,
  recordAccountJoin,
} from "./accountJoins.ts";

const dirs: string[] = [];
const makeDir = async () => {
  const dir = await NodeFSP.mkdtemp(join(NodeOS.tmpdir(), "account-joins-"));
  dirs.push(dir);
  return dir;
};
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => NodeFSP.rm(dir, { recursive: true, force: true })));
});

const NOW = Date.parse("2026-11-12T22:00:00.000Z");

describe("account joins", () => {
  it("reads no joins where nothing was recorded or the file is damaged", async () => {
    const dir = await makeDir();
    expect(await readAccountJoins(dir, NOW)).toEqual([]);
    await NodeFSP.writeFile(join(dir, FLEET_ACCOUNT_JOINS_FILE), "{ not json");
    expect(await readAccountJoins(dir, NOW)).toEqual([]);
    await recordAccountJoin(dir, { id: "m5", label: "MacBook Pro" }, NOW);
    expect(await readAccountJoins(dir, NOW)).toEqual([
      { id: "m5", label: "MacBook Pro", joinedAt: "2026-11-12T22:00:00.000Z" },
    ]);
  });

  it("keeps one note per machine, the newest, in an owner-only file", async () => {
    const dir = await makeDir();
    await Promise.all([
      recordAccountJoin(dir, { id: "m5", label: "MacBook Pro" }, NOW - 60_000),
      recordAccountJoin(dir, { id: "m3", label: "Mac mini" }, NOW - 30_000),
      recordAccountJoin(dir, { id: "m5", label: "MacBook Pro (2)" }, NOW),
    ]);
    expect((await readAccountJoins(dir, NOW)).map((entry) => [entry.id, entry.label])).toEqual([
      ["m3", "Mac mini"],
      ["m5", "MacBook Pro (2)"],
    ]);
    const stat = await NodeFSP.stat(join(dir, FLEET_ACCOUNT_JOINS_FILE));
    expect(stat.mode & 0o777).toBe(0o600);
    expect((await NodeFSP.readdir(dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("forgets a join after a week and keeps the ten newest", async () => {
    const dir = await makeDir();
    await recordAccountJoin(dir, { id: "old", label: "Old" }, NOW - ACCOUNT_JOIN_NEWS_MS - 1);
    for (let n = 0; n < 12; n += 1)
      await recordAccountJoin(dir, { id: `m${n}`, label: `M${n}` }, NOW - (12 - n) * 1000);
    const joins = await readAccountJoins(dir, NOW);
    expect(joins).toHaveLength(10);
    expect(joins[0]?.id).toBe("m2");
    expect(joins.some((entry) => entry.id === "old")).toBe(false);
  });
});
