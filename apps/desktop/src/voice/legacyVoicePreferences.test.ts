import { afterEach, expect, it } from "vite-plus/test";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native fixtures for a desktop-only file import.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native fixtures for a desktop-only file import.
import * as NodePath from "node:path";
import {
  legacyVoicePreferencePaths,
  readLegacyVoicePreferences,
  removeLegacyVoicePreferences,
} from "./legacyVoicePreferences.ts";

const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0))
    await NodeFSP.rm(folder, { recursive: true, force: true });
});
const crypto = { decryptString: (value: Buffer) => [...value.toString()].toReversed().join("") };
const encrypt = (value: string) => Buffer.from([...value].toReversed().join("")).toString("base64");

async function home() {
  const base = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "studio-legacy-voice-"));
  folders.push(base);
  const write = async (folder: string, value: unknown, mtime: number) => {
    await NodeFSP.mkdir(NodePath.join(base, folder), { recursive: true });
    const path = NodePath.join(base, folder, "voice-preferences.json");
    await NodeFSP.writeFile(path, JSON.stringify(value));
    await NodeFSP.utimes(path, mtime, mtime);
    return path;
  };
  return { base, write };
}

it("finds a save made under another launch's state folder and prefers the newest", async () => {
  const { base, write } = await home();
  await write(
    "userdata",
    { provider: "local", localVoiceId: "", rate: 0.47, elevenLabsVoiceId: "" },
    1,
  );
  const machine = await write(
    "m4/userdata",
    {
      provider: "elevenlabs",
      localVoiceId: "",
      rate: 0.47,
      elevenLabsVoiceId: "voice-1",
      encryptedKey: encrypt("xi-key"),
    },
    2,
  );
  const paths = await legacyVoicePreferencePaths(NodePath.join(base, "userdata"), base);
  expect(paths[0]).toBe(machine);
  expect(await readLegacyVoicePreferences(paths, crypto)).toEqual({
    provider: "elevenlabs",
    localVoiceId: "",
    rate: 0.47,
    elevenLabsVoiceId: "voice-1",
    apiKey: "xi-key",
  });
  await removeLegacyVoicePreferences(paths);
  expect(await legacyVoicePreferencePaths(NodePath.join(base, "userdata"), base)).toEqual([]);
});

it("falls back to the free voice when the saved key cannot be unlocked", async () => {
  const { base, write } = await home();
  await write(
    "userdata",
    {
      provider: "elevenlabs",
      localVoiceId: "",
      rate: 0.5,
      elevenLabsVoiceId: "voice-1",
      encryptedKey: "bm90LWEta2V5",
    },
    1,
  );
  const failing = {
    decryptString: () => {
      throw new Error("locked");
    },
  };
  const paths = await legacyVoicePreferencePaths(NodePath.join(base, "userdata"), base);
  expect(await readLegacyVoicePreferences(paths, failing)).toMatchObject({
    provider: "local",
    apiKey: "",
    rate: 0.5,
  });
});

it("skips unreadable files and reports nothing when none exist", async () => {
  const { base, write } = await home();
  expect(
    await readLegacyVoicePreferences(await legacyVoicePreferencePaths(base, base), crypto),
  ).toBeNull();
  await write("userdata", { provider: "cloud" }, 1);
  const paths = await legacyVoicePreferencePaths(NodePath.join(base, "userdata"), base);
  expect(await readLegacyVoicePreferences(paths, crypto)).toBeNull();
});
