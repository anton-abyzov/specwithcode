// @effect-diagnostics nodeBuiltinImport:off -- Desktop-only one-time import of a private preference file.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import type { DesktopLegacyVoicePreferences } from "@specweave-studio/contracts";

const FILE_NAME = "voice-preferences.json";

export interface VoiceDecrypt {
  decryptString(value: Buffer): string;
}

/**
 * Earlier builds kept voice settings in the desktop state folder, which
 * differs with how the app was launched (`<home>/userdata` or
 * `<home>/<machine>/userdata`). A save made in one launch was invisible to the
 * next. Every candidate is checked; the newest one wins.
 */
export async function legacyVoicePreferencePaths(
  stateDir: string,
  baseDir: string,
): Promise<string[]> {
  const candidates = new Set([
    NodePath.join(stateDir, FILE_NAME),
    NodePath.join(baseDir, "userdata", FILE_NAME),
  ]);
  const children = await NodeFSP.readdir(baseDir, { withFileTypes: true }).catch(() => []);
  for (const child of children) {
    if (child.isDirectory())
      candidates.add(NodePath.join(baseDir, child.name, "userdata", FILE_NAME));
  }
  const found: { path: string; mtimeMs: number }[] = [];
  for (const path of candidates) {
    const info = await NodeFSP.stat(path).catch(() => null);
    if (info?.isFile()) found.push({ path, mtimeMs: info.mtimeMs });
  }
  return [...found].sort((a, b) => b.mtimeMs - a.mtimeMs).map((entry) => entry.path);
}

/** The newest readable legacy file, with its key unlocked, or `null`. */
export async function readLegacyVoicePreferences(
  paths: readonly string[],
  crypto: VoiceDecrypt,
): Promise<DesktopLegacyVoicePreferences | null> {
  for (const path of paths) {
    let value: Record<string, unknown>;
    try {
      value = JSON.parse(await NodeFSP.readFile(path, "utf8"));
    } catch {
      continue;
    }
    if (
      !value ||
      (value.provider !== "local" && value.provider !== "elevenlabs") ||
      typeof value.localVoiceId !== "string" ||
      typeof value.elevenLabsVoiceId !== "string" ||
      typeof value.rate !== "number" ||
      value.rate < 0.35 ||
      value.rate > 0.6
    )
      continue;
    let apiKey = "";
    if (typeof value.encryptedKey === "string" && value.encryptedKey) {
      try {
        apiKey = crypto.decryptString(Buffer.from(value.encryptedKey, "base64")).trim();
      } catch {
        // A key this Mac cannot unlock is dropped; the user enters it again.
      }
    }
    return {
      provider: value.provider === "elevenlabs" && apiKey ? "elevenlabs" : "local",
      localVoiceId: value.localVoiceId.slice(0, 200),
      rate: value.rate,
      elevenLabsVoiceId: /^[a-zA-Z0-9_-]{0,100}$/.test(value.elevenLabsVoiceId)
        ? value.elevenLabsVoiceId
        : "",
      apiKey,
    };
  }
  return null;
}

export async function removeLegacyVoicePreferences(paths: readonly string[]): Promise<void> {
  await Promise.all(paths.map((path) => NodeFSP.rm(path, { force: true }).catch(() => undefined)));
}
