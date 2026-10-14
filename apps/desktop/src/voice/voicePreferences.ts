// @effect-diagnostics nodeBuiltinImport:off -- Desktop-only private preference storage.
import { readFile, writeFile, rename, mkdir, rm } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";
import type {
  DesktopVoicePreferences,
  DesktopVoicePreferencesInput,
} from "@specweave-studio/contracts";

export const DEFAULT_VOICE_PREFERENCES: DesktopVoicePreferences = {
  provider: "local",
  localVoiceId: "",
  rate: 0.47,
  elevenLabsVoiceId: "",
  hasApiKey: false,
};
interface StoredVoice {
  provider: "local" | "elevenlabs";
  localVoiceId: string;
  rate: number;
  elevenLabsVoiceId: string;
  encryptedKey?: string;
}
export interface VoiceCrypto {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(value: string): Uint8Array;
  decryptString(value: Buffer): string;
}

export class VoicePreferencesStore {
  private pending: Promise<unknown> = Promise.resolve();
  private readonly path: string;
  private readonly crypto: VoiceCrypto;
  constructor(path: string, crypto: VoiceCrypto) {
    this.path = path;
    this.crypto = crypto;
  }

  private async read(): Promise<StoredVoice> {
    try {
      const value = JSON.parse(await readFile(this.path, "utf8"));
      if (
        !value ||
        !["local", "elevenlabs"].includes(value.provider) ||
        typeof value.localVoiceId !== "string" ||
        typeof value.elevenLabsVoiceId !== "string" ||
        typeof value.rate !== "number" ||
        value.rate < 0.35 ||
        value.rate > 0.6 ||
        (value.encryptedKey !== undefined && typeof value.encryptedKey !== "string")
      )
        throw new Error();
      return value;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT")
        return { ...DEFAULT_VOICE_PREFERENCES };
      throw new Error("Could not read voice preferences. No cloud voice request was sent.");
    }
  }
  async get(): Promise<DesktopVoicePreferences> {
    await this.pending;
    const { encryptedKey, ...preferences } = await this.read();
    return {
      provider: preferences.provider,
      localVoiceId: preferences.localVoiceId,
      rate: preferences.rate,
      elevenLabsVoiceId: preferences.elevenLabsVoiceId,
      hasApiKey: Boolean(encryptedKey),
    };
  }
  async speechConfig() {
    await this.pending;
    const value = await this.read();
    if (value.provider === "local") return { ...value, cloud: null };
    if (!value.encryptedKey || !value.elevenLabsVoiceId)
      throw new Error("Add your ElevenLabs API key and voice ID in Voice settings.");
    let apiKey: string;
    try {
      apiKey = this.crypto.decryptString(Buffer.from(value.encryptedKey, "base64"));
    } catch {
      throw new Error(
        "Your ElevenLabs key could not be unlocked. Save it again in Voice settings.",
      );
    }
    return {
      ...value,
      cloud: { apiKey, voiceId: value.elevenLabsVoiceId, modelId: "eleven_flash_v2_5" },
    };
  }
  async set(input: DesktopVoicePreferencesInput): Promise<DesktopVoicePreferences> {
    const save = this.pending.then(async () => {
      const current = await this.read();
      const key = input.apiKey?.trim();
      let encryptedKey = input.clearApiKey ? undefined : current.encryptedKey;
      if (key) {
        if (
          !this.crypto.isEncryptionAvailable() ||
          this.crypto.getSelectedStorageBackend?.() === "basic_text"
        )
          throw new Error("Secure key storage is unavailable. Use the free local voice.");
        try {
          encryptedKey = Buffer.from(this.crypto.encryptString(key)).toString("base64");
        } catch {
          throw new Error("Could not securely store your key. Use the free local voice.");
        }
      }
      const voiceId = input.elevenLabsVoiceId.trim();
      if (voiceId && !/^[a-zA-Z0-9_-]+$/.test(voiceId))
        throw new Error("Enter a valid ElevenLabs voice ID.");
      if (input.provider === "elevenlabs" && (!encryptedKey || !voiceId))
        throw new Error("Add your own ElevenLabs API key and voice ID first.");
      const next: StoredVoice = {
        provider: input.provider,
        localVoiceId: input.localVoiceId,
        rate: input.rate,
        elevenLabsVoiceId: voiceId,
        ...(encryptedKey ? { encryptedKey } : {}),
      };
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const temp = `${this.path}.${randomUUID()}.tmp`;
      try {
        await writeFile(temp, JSON.stringify(next), { mode: 0o600 });
        await rename(temp, this.path);
      } finally {
        await rm(temp, { force: true });
      }
      return {
        provider: next.provider,
        localVoiceId: next.localVoiceId,
        rate: next.rate,
        elevenLabsVoiceId: next.elevenLabsVoiceId,
        hasApiKey: Boolean(encryptedKey),
      };
    });
    this.pending = save.catch(() => undefined);
    return save;
  }
}
