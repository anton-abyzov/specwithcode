// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  isSpecweaveProject,
  specweaveState,
  unfinishedIncrements,
  type SpecweaveState,
} from "./ThreadIncrementProgress.ts";

const roots: string[] = [];

async function temp(prefix: string): Promise<string> {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), prefix)),
  );
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => NodeFSP.rm(root, { recursive: true, force: true })),
  );
});

async function config(root: string) {
  await NodeFSP.mkdir(NodePath.join(root, ".specweave"), { recursive: true });
  await NodeFSP.writeFile(NodePath.join(root, ".specweave/config.json"), "{}");
}

async function increment(root: string, id: string, title?: string) {
  const folder = NodePath.join(root, ".specweave/increments", id);
  await NodeFSP.mkdir(folder, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(folder, "metadata.json"),
    JSON.stringify(title === undefined ? { status: "planned" } : { status: "planned", title }),
  );
}

const cases: ReadonlyArray<{
  readonly name: string;
  readonly make: () => Promise<string>;
  readonly personal?: boolean;
  readonly state: SpecweaveState;
}> = [
  {
    name: "config at the root",
    make: async () => {
      const root = await temp("state-root-");
      await config(root);
      return root;
    },
    state: "on",
  },
  {
    name: "an umbrella above plans it",
    make: async () => {
      const umbrella = await temp("state-umbrella-");
      await config(umbrella);
      await NodeFSP.mkdir(NodePath.join(umbrella, ".specweave/increments"), { recursive: true });
      const member = NodePath.join(umbrella, "repositories/acme/app");
      await NodeFSP.mkdir(member, { recursive: true });
      return member;
    },
    state: "on",
  },
  {
    name: "increments without a config",
    make: async () => {
      const root = await temp("state-half-");
      await increment(root, "0001-simple-website", "Simple website");
      return root;
    },
    state: "unfinished",
  },
  {
    name: "an empty .specweave",
    make: async () => {
      const root = await temp("state-empty-");
      await NodeFSP.mkdir(NodePath.join(root, ".specweave/increments"), { recursive: true });
      return root;
    },
    state: "off",
  },
  {
    name: "a config.json that is a link",
    make: async () => {
      const elsewhere = await temp("state-link-target-");
      await config(elsewhere);
      const root = await temp("state-link-");
      await NodeFSP.mkdir(NodePath.join(root, ".specweave"), { recursive: true });
      await NodeFSP.symlink(
        NodePath.join(elsewhere, ".specweave/config.json"),
        NodePath.join(root, ".specweave/config.json"),
      );
      return root;
    },
    state: "off",
  },
  {
    name: "a personal assistant",
    make: async () => {
      const root = await temp("state-personal-");
      await config(root);
      return root;
    },
    personal: true,
    state: "off",
  },
  {
    name: "a plain folder",
    make: () => temp("state-plain-"),
    state: "off",
  },
];

describe("specweaveState (1396 AC-01)", () => {
  it.each(cases)("$name: $state", async (entry) => {
    const root = await entry.make();
    expect(await specweaveState(root, { personal: entry.personal === true })).toBe(entry.state);
    if (entry.personal !== true) {
      expect(await isSpecweaveProject(root)).toBe(entry.state === "on");
    }
  });

  it("counts an unfinished folder's increments and names the first three, newest first", async () => {
    const root = await temp("state-titles-");
    await increment(root, "0001-first", "First");
    await increment(root, "0002-second", "Second");
    await increment(root, "0003-third");
    await increment(root, "0004-fourth", "Fourth");
    expect(await unfinishedIncrements(root)).toEqual({
      count: 4,
      titles: ["Fourth", "0003-third", "Second"],
    });
  });
});
