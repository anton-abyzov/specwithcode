// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native fixtures independently verify Electron and installed operating-system behavior.
import { execFileSync } from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native fixtures independently verify Electron and installed operating-system behavior.
import { createHash } from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native fixtures independently verify Electron and installed operating-system behavior.
import * as FS from "node:fs";
import * as OS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Native fixtures independently verify Electron and installed operating-system behavior.
import * as Path from "node:path";

import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { makeMacSwapUpdater } from "./ElectronMacSwapUpdater.ts";

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) FS.rmSync(dir, { recursive: true, force: true });
});

// A release zip whose app reports `version`.
const makeZip = (dir: string, name: string, version: string) => {
  const app = Path.join(dir, `build-${name}`, "Studio.app");
  FS.mkdirSync(Path.join(app, "Contents"), { recursive: true });
  FS.writeFileSync(
    Path.join(app, "Contents", "Info.plist"),
    `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.specweave.studio</string><key>CFBundleShortVersionString</key><string>${version}</string></dict></plist>`,
  );
  const zip = Path.join(dir, name);
  execFileSync("/usr/bin/ditto", ["-c", "-k", "--keepParent", app, zip]);
  const bytes = FS.readFileSync(zip);
  return { bytes, sha512: createHash("sha512").update(bytes).digest("base64") };
};

describe.skipIf(process.platform !== "darwin")("makeMacSwapUpdater", () => {
  it("forgets a staged update once a newer download replaces it and fails", async () => {
    const dir = FS.mkdtempSync(Path.join(OS.tmpdir(), "studio-swap-updater-"));
    scratch.push(dir);
    const good = makeZip(dir, "Studio-0.2.9-arm64.zip", "0.2.9");
    // The 0.2.10 release ships an app that reports the wrong version.
    const bad = makeZip(dir, "Studio-0.2.10-arm64.zip", "0.2.99");
    const releases = [
      { tag_name: "v0.2.9", version: "0.2.9", zip: good, base: 10 },
      { tag_name: "v0.2.10", version: "0.2.10", zip: bad, base: 20 },
    ];
    let published = 1;
    const assets = new Map<number, Uint8Array>();
    for (const release of releases) {
      const name = `Studio-${release.version}-arm64.zip`;
      assets.set(
        release.base,
        new TextEncoder().encode(
          `version: ${release.version}\nfiles:\n  - url: ${name}\n    sha512: ${release.zip.sha512}\n    size: ${release.zip.bytes.length}\n`,
        ),
      );
      assets.set(release.base + 1, release.zip.bytes);
    }
    const fetchImpl = (async (input: string | URL) => {
      const url = String(input);
      if (url.includes("/releases?")) {
        return Response.json(
          releases.slice(0, published).map((release) => ({
            tag_name: release.tag_name,
            assets: [
              { id: release.base, name: "latest-mac.yml", size: 0 },
              {
                id: release.base + 1,
                name: `Studio-${release.version}-arm64.zip`,
                size: release.zip.bytes.length,
              },
            ],
          })),
        );
      }
      const id = Number(url.split("/").at(-1));
      const body = assets.get(id);
      return body === undefined
        ? new Response(null, { status: 404 })
        : new Response(body as unknown as BodyInit);
    }) as typeof fetch;

    const updater = makeMacSwapUpdater({
      app: {
        getPath: () => dir,
        getVersion: () => "0.2.8",
        quit: () => undefined,
        on: () => undefined as never,
      },
      fetch: fetchImpl,
      resolveToken: async () => null,
      arch: "arm64",
      // Not inside an app bundle, so an install attempt can never swap anything.
      execPath: Path.join(dir, "bin", "electron"),
      pid: 999_999,
    });
    await Effect.runPromise(
      updater.setFeedURL({ provider: "github", owner: "o", repo: "r" } as never),
    );

    await Effect.runPromise(updater.checkForUpdates);
    await Effect.runPromise(updater.downloadUpdate);
    const staged = Path.join(dir, "pending-update", "staged.noindex", "Studio.app");
    expect(FS.existsSync(staged)).toBe(true);

    published = 2;
    await Effect.runPromise(updater.checkForUpdates);
    const failed = await Effect.runPromiseExit(updater.downloadUpdate);
    expect(Exit.isFailure(failed)).toBe(true);

    // The 0.2.9 copy is gone; installing must not pick up the rejected bundle.
    const install = await Effect.runPromiseExit(
      updater.quitAndInstall({ isSilent: false, isForceRunAfter: true }),
    );
    const installError = Exit.isFailure(install) ? Cause.squash(install.cause) : null;
    expect((installError as { cause?: Error } | null)?.cause?.message).toBe(
      "No downloaded update is ready to install.",
    );
  });
});
