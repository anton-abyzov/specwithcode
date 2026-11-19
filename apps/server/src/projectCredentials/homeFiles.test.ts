// @effect-diagnostics nodeBuiltinImport:off - a temp home folder holding stand-in credential files.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { PROJECT_CREDENTIAL_IDS } from "@specweave-studio/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { isDotnetUserSecretsFile } from "../fleet/folderTransfer/secretLocations.ts";
import { readSecretBytes } from "../fleet/folderTransfer/sourceSecrets.ts";
import { CREDENTIAL_HOME_FILES } from "./catalog.ts";

let base: string;
let home: string;
let folder: string;

const put = async (relative: string) => {
  const path = NodePath.join(home, relative);
  await NodeFSP.mkdir(NodePath.dirname(path), { recursive: true });
  await NodeFSP.writeFile(path, "stand-in\n");
};

beforeEach(async () => {
  base = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "credentials-home-")),
  );
  home = NodePath.join(base, "home");
  folder = NodePath.join(base, "project");
  await NodeFSP.mkdir(home);
  await NodeFSP.mkdir(folder);
});
afterEach(async () => {
  await NodeFSP.rm(base, { recursive: true, force: true });
});

const read = (path: string) =>
  readSecretBytes({ folder, home, platform: "linux" }, path).then(
    (bytes) => (bytes === null ? "nothing" : "bytes"),
    () => "refused",
  );

describe("home credential files", () => {
  it("names at least one for every credential in the list", () => {
    for (const id of PROJECT_CREDENTIAL_IDS)
      expect(CREDENTIAL_HOME_FILES[id].length).toBeGreaterThan(0);
  });

  it("are never read for a copy, even when they exist", async () => {
    for (const id of PROJECT_CREDENTIAL_IDS)
      for (const relative of CREDENTIAL_HOME_FILES[id]) {
        await put(relative);
        expect(isDotnetUserSecretsFile(relative), relative).toBe(false);
        expect(await read(`~/${relative}`), relative).not.toBe("bytes");
        // Reached through the project folder instead, the path still does not leave it.
        expect(await read(`../home/${relative}`), relative).not.toBe("bytes");
      }
  });

  it("while the one home file a copy does carry is still read", async () => {
    const secrets = ".microsoft/usersecrets/app-1/secrets.json";
    await put(secrets);
    expect(await read(`~/${secrets}`)).toBe("bytes");
  });
});
