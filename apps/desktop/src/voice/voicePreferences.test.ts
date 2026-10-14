import { afterEach, expect, it } from "vite-plus/test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VoicePreferencesStore, DEFAULT_VOICE_PREFERENCES } from "./voicePreferences.ts";
const folders: string[] = [];
afterEach(async () => {
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});
async function setup(available = true) {
  const folder = await mkdtemp(join(tmpdir(), "studio-voice-test-"));
  folders.push(folder);
  const path = join(folder, "prefs.json");
  const store = new VoicePreferencesStore(path, {
    isEncryptionAvailable: () => available,
    encryptString: (value) => Buffer.from([...value].reverse().join("")),
    decryptString: (value) => [...value.toString()].reverse().join(""),
  });
  return { store, path };
}
it("defaults to local speech without reading any provider environment key", async () => {
  const { store } = await setup();
  expect(await store.get()).toEqual(DEFAULT_VOICE_PREFERENCES);
  expect((await store.speechConfig()).cloud).toBeNull();
});
it("encrypts a personal key, redacts reads, and keeps the file private", async () => {
  const { store, path } = await setup();
  const result = await store.set({
    ...DEFAULT_VOICE_PREFERENCES,
    provider: "elevenlabs",
    elevenLabsVoiceId: "own-voice",
    apiKey: "my-private-key",
  });
  expect(result.hasApiKey).toBe(true);
  expect(JSON.stringify(result)).not.toContain("my-private-key");
  expect(JSON.stringify(await store.get())).not.toContain("encryptedKey");
  expect(await readFile(path, "utf8")).not.toContain("my-private-key");
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect((await store.speechConfig()).cloud?.apiKey).toBe("my-private-key");
});
it("requires both personal credentials before selecting paid voice", async () => {
  const { store } = await setup();
  await expect(store.set({ ...DEFAULT_VOICE_PREFERENCES, provider: "elevenlabs" })).rejects.toThrow(
    "own ElevenLabs",
  );
  expect((await store.get()).provider).toBe("local");
});
it("refuses insecure storage and permits local preferences afterwards", async () => {
  const { store } = await setup(false);
  await expect(store.set({ ...DEFAULT_VOICE_PREFERENCES, apiKey: "private" })).rejects.toThrow(
    "Secure key storage",
  );
  await expect(store.set({ ...DEFAULT_VOICE_PREFERENCES, rate: 0.42 })).resolves.toMatchObject({
    provider: "local",
    rate: 0.42,
  });
});
it("preserves saved keys on blank input and serializes removal after saves", async () => {
  const { store } = await setup();
  await store.set({
    ...DEFAULT_VOICE_PREFERENCES,
    provider: "elevenlabs",
    elevenLabsVoiceId: "voice",
    apiKey: "private",
  });
  await store.set({
    ...DEFAULT_VOICE_PREFERENCES,
    provider: "elevenlabs",
    elevenLabsVoiceId: "voice",
    apiKey: "",
  });
  expect((await store.speechConfig()).cloud?.apiKey).toBe("private");
  await Promise.all([
    store.set({ ...DEFAULT_VOICE_PREFERENCES, apiKey: "new-key" }),
    store.set({ ...DEFAULT_VOICE_PREFERENCES, clearApiKey: true }),
  ]);
  expect(await store.get()).toMatchObject({ provider: "local", hasApiKey: false });
});
