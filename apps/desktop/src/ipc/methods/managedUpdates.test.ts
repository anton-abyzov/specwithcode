// @effect-diagnostics nodeBuiltinImport:off -- Synthetic receipt and inert helper graph fixtures only.
import * as FS from "node:fs";
import * as ChildProcess from "node:child_process";
import * as OS from "node:os";
import * as Path from "node:path";
import { describe, expect, it, vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Electron from "electron";
import { ManagedUpdateError, type ManagedUpdateStatus } from "@specweave-studio/contracts";

vi.mock("electron", () => ({}));

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import * as DesktopLocalService from "../../backend/DesktopLocalService.ts";
import * as ElectronWindow from "../../electron/ElectronWindow.ts";
import * as ElectronDialog from "../../electron/ElectronDialog.ts";
import * as ManagedInstallations from "../../updates/managedUpdateInstallations.ts";
import { MAC_SERVICE_UPDATER_FILES } from "../../../../../scripts/lib/studio-service-updater.ts";
import {
  makeManagedUpdateConsentMethod,
  resolveManagedUpdateConsentInstallation,
  type ManagedUpdateConsentAdapter,
} from "./managedUpdates.ts";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: vi.fn(() => {
    throw new Error("Unexpected live process probe in test");
  }),
}));

const input = {
  action: "enroll",
  installationId: "work-mac",
  environmentId: "environment-7",
  expectedRevision: 4,
};
const status: ManagedUpdateStatus = {
  environmentId: "environment-7" as never,
  installationId: "work-mac",
  support: "supported",
  localAutomation: "disabled",
  remoteConsent: "enrolled",
  revision: 5,
  operation: "idle",
  currentVersion: "1.0.17",
  availableVersion: null,
  checkedAt: null,
};
function fixture() {
  const frame = {};
  let url = "studio://app/settings";
  const webContents = { id: 7, mainFrame: frame, getURL: () => url };
  const event = { sender: webContents, senderFrame: frame };
  let attached: DesktopLocalService.AttachedLocalService | null = {
    baseDir: "/Users/owner/.specweave-studio/work-mac",
    runtime: { pid: 7, port: 8320, origin: "http://127.0.0.1:8320", serviceManaged: true },
    descriptor: {
      environmentId: "environment-7",
      platform: { os: "darwin", arch: "arm64" },
      label: "Mac",
      serverVersion: "1.0.17",
      capabilities: {},
    } as DesktopLocalService.AttachedLocalService["descriptor"],
    httpBaseUrl: new URL("http://127.0.0.1:8320"),
  };
  const getBearer = vi.fn(
    () =>
      `${Buffer.from(JSON.stringify({ v: 1, kind: "session", sid: "main-session", sub: "browser", method: "bearer-access-token", scopes: ["environment:maintain"], exp: 4102444800000 })).toString("base64url")}.fixture`,
  );
  const dialog = vi.fn<
    (options: Electron.MessageBoxOptions) => Promise<Electron.MessageBoxReturnValue>
  >(async () => ({ response: 1, checkboxChecked: false }));
  const resolve = vi.fn<ManagedUpdateConsentAdapter["resolve"]>((_environment, service, target) => {
    if (
      target.installationId !== "work-mac" ||
      target.environmentId !== service.descriptor.environmentId
    )
      throw new Error("wrong binding");
    return {
      owner: { uid: 502, user: "owner", homeDirectory: "/Users/owner" },
      installation: {
        installationId: "work-mac",
        studioHome: service.baseDir,
        stateDir: `${service.baseDir}/userdata`,
        release: "/Users/owner/.local/share/specweave-studio/releases/aaaaaaaaaaaaaaaaaaaa",
        port: 8320,
        version: "1.0.17",
      },
      helper: "/owned/managed_updates.py",
    };
  });
  const invoke = vi.fn<ManagedUpdateConsentAdapter["invoke"]>(async () => status);
  const env = {
    platform: "darwin",
    isDevelopment: false,
    devServerUrl: Option.none(),
  } as DesktopEnvironment.DesktopEnvironment["Service"];
  const layer = Layer.mergeAll(
    Layer.succeed(DesktopEnvironment.DesktopEnvironment, env),
    Layer.succeed(ElectronWindow.ElectronWindow, {
      main: Effect.sync(() => Option.some({ webContents } as Electron.BrowserWindow)),
    } as ElectronWindow.ElectronWindow["Service"]),
    Layer.succeed(ElectronDialog.ElectronDialog, {
      showMessageBox: (options) => Effect.promise(() => dialog(options)),
      pickFolder: () => Effect.die("unexpected folder picker"),
      pickFiles: () => Effect.die("unexpected file picker"),
      showErrorBox: () => Effect.die("unexpected error dialog"),
    }),
    Layer.succeed(DesktopLocalService.DesktopLocalService, {
      attached: Effect.sync(() => Option.fromNullishOr(attached)),
      bearerToken: Effect.sync(getBearer),
      discover: () => Effect.die("unexpected discovery"),
      attach: () => Effect.die("unexpected attach"),
      markSpawned: Effect.die("unexpected spawn"),
      ownsBundledService: Effect.succeed(false),
    }),
  );
  const method = makeManagedUpdateConsentMethod({ resolve, invoke });
  return {
    event,
    dialog,
    invoke,
    getBearer,
    resolve,
    env,
    setUrl: (value: string) => {
      url = value;
    },
    changeAttached: (change: Partial<DesktopLocalService.AttachedLocalService> | null) => {
      attached = change === null ? null : { ...attached!, ...change };
    },
    run: (raw: unknown = input, sender: typeof event | undefined = event) =>
      Effect.runPromise(method.handler(raw, sender).pipe(Effect.provide(layer))),
    failure: (raw: unknown = input, sender: typeof event | undefined = event) =>
      Effect.runPromise(
        method.handler(raw, sender).pipe(
          Effect.match({
            onFailure: (error) => error,
            onSuccess: () => {
              throw new Error("Expected rejection");
            },
          }),
          Effect.provide(layer),
        ),
      ),
  };
}

describe("native managed update consent", () => {
  it("uses only the attached receipt's secure runtime helper without installing a scheduler", () => {
    const root = FS.realpathSync(
      FS.mkdtempSync(Path.join(OS.userInfo().homedir, ".managed-runtime-helper-test-")),
    );
    const home = Path.join(root, "home");
    const owner = { uid: process.getuid!(), user: "fixture-owner", homeDirectory: home };
    const ownerSpy = vi
      .spyOn(ManagedInstallations, "managedInstallationOwner")
      .mockReturnValue(owner);
    const processSpy = vi.spyOn(ChildProcess, "execFileSync").mockImplementation((command) => {
      if (command === "/bin/launchctl")
        return `state = running\npid = 7\npath = ${Path.join(home, "Library/LaunchAgents/com.specweave.studio.work-mac.plist")}\n`;
      if (command === "/bin/ps") return `${owner.uid}\n`;
      throw new Error("unexpected process probe");
    });
    try {
      const studioHome = Path.join(home, ".specweave-studio/work-mac");
      const release = Path.join(home, ".local/share/specweave-studio/releases", "a".repeat(20));
      const runtimeHelper = Path.join(release, "studio-updater/managed_updates.py");
      const bundleRoot = Path.join(root, "Applications");
      const bundledHelper = Path.join(
        bundleRoot,
        "Fixture.app/Contents/Resources/studio-updater/managed_updates.py",
      );
      for (const helper of [runtimeHelper, bundledHelper]) {
        FS.mkdirSync(Path.dirname(helper), { recursive: true, mode: 0o700 });
        for (const name of new Set([...MAC_SERVICE_UPDATER_FILES, "managed_updates.py"]))
          FS.writeFileSync(Path.join(Path.dirname(helper), name), "# inert", { mode: 0o600 });
      }
      FS.chmodSync(bundleRoot, 0o775);
      FS.mkdirSync(studioHome, { recursive: true, mode: 0o700 });
      const receipt = {
        schemaVersion: 1,
        identity: "work-mac",
        uid: owner.uid,
        user: owner.user,
        studioHome,
        stateDir: Path.join(studioHome, "userdata"),
        cliWrapper: Path.join(home, ".local/bin/specweave-studio-work-mac"),
        host: "127.0.0.1",
        port: 8320,
        version: "1.0.18",
        webSessionPolicy: "worker-relay",
        archiveSha256: "a".repeat(64),
        release,
        service: {
          installed: true,
          label: "com.specweave.studio.work-mac",
          domain: `gui/${owner.uid}`,
        },
      };
      const receiptPath = Path.join(studioHome, "installation.json");
      FS.writeFileSync(receiptPath, JSON.stringify(receipt));
      FS.mkdirSync(receipt.stateDir, { recursive: true, mode: 0o700 });
      const runtimePath = Path.join(receipt.stateDir, "server-runtime.json");
      const environmentPath = Path.join(receipt.stateDir, "environment-id");
      FS.writeFileSync(
        runtimePath,
        JSON.stringify({ pid: 7, port: 8320, origin: "http://127.0.0.1:8320" }),
        { mode: 0o600 },
      );
      FS.writeFileSync(environmentPath, "environment-7", { mode: 0o600 });
      const plist = Path.join(home, "Library/LaunchAgents/com.specweave.studio.work-mac.plist");
      FS.mkdirSync(Path.dirname(plist), { recursive: true, mode: 0o700 });
      FS.writeFileSync(plist, "synthetic LaunchAgent", { mode: 0o600 });
      const environment = {
        homeDirectory: home,
        isDevelopment: false,
        path: Path,
        resolveResourcePathCandidates: () => [bundledHelper],
      } as unknown as DesktopEnvironment.DesktopEnvironment["Service"];
      const attached = {
        baseDir: studioHome,
        runtime: { pid: 7, port: 8320, origin: "http://127.0.0.1:8320", serviceManaged: false },
        descriptor: { environmentId: "environment-7", platform: { os: "darwin", arch: "arm64" } },
        httpBaseUrl: new URL("http://127.0.0.1:8320"),
      } as DesktopLocalService.AttachedLocalService;
      const target = {
        ...input,
        action: "enroll" as const,
        environmentId: "environment-7" as never,
      };
      const resolve = () => resolveManagedUpdateConsentInstallation(environment, attached, target);
      expect(resolve().helper).toBe(runtimeHelper);
      expect(resolve().installation.release).toBe(release);
      const runtimeBefore = FS.readFileSync(runtimePath, "utf8");
      FS.writeFileSync(
        runtimePath,
        JSON.stringify({ pid: 8, port: 8320, origin: "http://127.0.0.1:8320" }),
      );
      expect(resolve).toThrow(ManagedUpdateError);
      FS.writeFileSync(runtimePath, runtimeBefore);
      expect(resolve().helper).toBe(runtimeHelper);
      expect(FS.existsSync(Path.join(home, ".local/share/specweave-studio/updater"))).toBe(false);
      expect(FS.existsSync(Path.join(studioHome, "updates"))).toBe(false);
      expect(FS.readFileSync(receiptPath, "utf8")).toBe(JSON.stringify(receipt));
      FS.chmodSync(release, 0o777);
      expect(resolve).toThrow(ManagedUpdateError);
      FS.chmodSync(release, 0o700);
      FS.renameSync(release, `${release}.saved`);
      FS.symlinkSync(`${release}.saved`, release);
      expect(resolve).toThrow(ManagedUpdateError);
      FS.unlinkSync(release);
      FS.renameSync(`${release}.saved`, release);
      FS.writeFileSync(receiptPath, JSON.stringify({ ...receipt, release: Path.dirname(release) }));
      expect(resolve).toThrow(ManagedUpdateError);
    } finally {
      processSpy.mockRestore();
      ownerSpy.mockRestore();
      FS.rmSync(root, { recursive: true, force: true });
    }
  });
  it("uses the exact target, revision and main-process controller after a native confirmation", async () => {
    const f = fixture();
    expect(
      await f.run({
        ...input,
        controller: { sessionId: "renderer-session", subject: "admin" },
        token: "renderer-token",
      }),
    ).toEqual(status);
    expect(f.dialog).toHaveBeenCalledOnce();
    expect(f.dialog.mock.calls[0]?.[0]).toMatchObject({
      defaultId: 0,
      cancelId: 0,
      buttons: ["Cancel", "Allow management"],
    });
    expect(f.resolve).toHaveBeenCalledTimes(3);
    expect(f.invoke.mock.calls[0]?.[1]).toEqual({
      action: "enroll-local",
      environmentId: "environment-7",
      controller: { sessionId: "main-session", subject: "browser" },
      input: {
        installationId: "work-mac",
        environmentId: "environment-7",
        expectedRevision: 4,
        consent: true,
      },
      approval: {
        kind: "native-owner",
        confirmed: true,
        installationId: "work-mac",
        environmentId: "environment-7",
        expectedRevision: 4,
      },
    });
  });
  it("cancels without resolving a bearer or invoking any helper", async () => {
    const f = fixture();
    f.dialog.mockResolvedValue({ response: 0, checkboxChecked: false });
    expect(await f.run()).toBeNull();
    expect(f.getBearer).not.toHaveBeenCalled();
    expect(f.invoke).not.toHaveBeenCalled();
  });
  it("revokes through its own explicit native action without an enrollment consent flag", async () => {
    const f = fixture();
    await f.run({ ...input, action: "revoke" });
    expect(f.invoke.mock.calls[0]?.[1]).toMatchObject({ action: "revoke-local" });
    expect(f.invoke.mock.calls[0]?.[1].input).not.toHaveProperty("consent");
  });
  it.each(["missing-frame", "subframe", "foreign-sender", "navigated-main", "secondary-window"])(
    "rejects %s before prompting",
    async (kind) => {
      const f = fixture();
      const event = { ...f.event };
      if (kind === "missing-frame") event.senderFrame = undefined as never;
      if (kind === "subframe") event.senderFrame = {};
      if (kind === "foreign-sender" || kind === "secondary-window")
        event.sender = { ...f.event.sender, id: 99 };
      if (kind === "navigated-main") f.setUrl("https://untrusted.invalid/");
      expect(await f.failure(input, event)).toMatchObject({ code: "unauthorized" });
      expect(f.dialog).not.toHaveBeenCalled();
      expect(f.invoke).not.toHaveBeenCalled();
    },
  );
  it("fails an unattached desktop and a wrong target before prompting", async () => {
    const f = fixture();
    expect(await f.failure({ ...input, installationId: "another" })).toMatchObject({
      code: "unavailable",
    });
    f.changeAttached(null);
    expect(await f.failure()).toMatchObject({ code: "unmanaged" });
    expect(f.dialog).not.toHaveBeenCalled();
  });
  it.each(["attachment", "navigation", "receipt"])(
    "revalidates %s when the dialog resolves",
    async (kind) => {
      const f = fixture();
      f.dialog.mockImplementation(async () => {
        if (kind === "attachment")
          f.changeAttached({ baseDir: "/Users/owner/.specweave-studio/other" });
        if (kind === "navigation") f.setUrl("https://untrusted.invalid");
        if (kind === "receipt")
          f.resolve.mockImplementation(() => {
            throw new Error("receipt changed");
          });
        return { response: 1, checkboxChecked: false };
      });
      await f.failure();
      expect(f.getBearer).not.toHaveBeenCalled();
      expect(f.invoke).not.toHaveBeenCalled();
    },
  );
  it("rechecks attachment after resolving the trusted credential", async () => {
    const f = fixture();
    const original = f.getBearer.getMockImplementation()!;
    f.getBearer.mockImplementation(() => {
      f.changeAttached(null);
      return original();
    });
    expect(await f.failure()).toMatchObject({ code: "binding-changed" });
    expect(f.invoke).not.toHaveBeenCalled();
  });
  it("does not trust a response bound to another installation", async () => {
    const f = fixture();
    f.invoke.mockResolvedValue({ ...status, installationId: "other" });
    expect(await f.failure()).toMatchObject({ code: "binding-changed" });
  });
  it.each(["conflict", "revoked", "busy", "unsupported"] as const)(
    "preserves authoritative helper refusal %s",
    async (code) => {
      const f = fixture();
      f.invoke.mockRejectedValue(new ManagedUpdateError({ code }));
      expect(await f.failure()).toMatchObject({ code });
      expect(f.invoke).toHaveBeenCalledOnce();
    },
  );
  it("refuses unsupported platforms before the native dialog", async () => {
    const f = fixture();
    Object.assign(f.env, { platform: "linux" });
    expect(await f.failure()).toMatchObject({ code: "unsupported" });
    expect(f.dialog).not.toHaveBeenCalled();
  });
  it("requires explicit schema action and a nonnegative revision", async () => {
    for (const change of [
      { action: "check" },
      { expectedRevision: -1 },
      { expectedRevision: 1.5 },
    ]) {
      const f = fixture();
      await f.failure({ ...input, ...change });
      expect(f.dialog).not.toHaveBeenCalled();
    }
  });
});
