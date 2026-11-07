import { describe, expect, it, vi } from "vite-plus/test";

import {
  installSignedDeb,
  saveFeedSignature,
  type DebUpdaterInstall,
  type SignedDebInstallTools,
  unattendedDebInstallReadiness,
  UPDATE_HELPER_PATH,
  useSignedDebInstall,
} from "./signedDebInstall.ts";

const DEB = "/home/a/.cache/studio-updater/pending/SpecWithCode-1.0.170-amd64.deb";

const makeTools = (
  options: {
    readonly files?: ReadonlyArray<string>;
    readonly status?: number | null;
    readonly stderr?: string;
    readonly error?: NodeJS.ErrnoException;
    readonly actionAllowed?: boolean;
  } = {},
) => {
  const written: Array<[string, string]> = [];
  const removed: Array<string> = [];
  const files = options.files ?? [UPDATE_HELPER_PATH, `${DEB}.sig`];
  const runHelper = vi.fn(() => ({
    error: options.error,
    status: options.status === undefined ? 0 : options.status,
    stderr: options.stderr ?? "",
  }));
  const tools: SignedDebInstallTools = {
    exists: (path) => files.includes(path),
    writeSignature: (path, signature) => written.push([path, signature.toString()]),
    removeSignature: (path) => removed.push(path),
    actionAllowed: () => options.actionAllowed ?? true,
    runHelper,
  };
  return { tools, runHelper, written, removed };
};

describe("installSignedDeb", () => {
  it("installs through the helper with the signature beside the package", () => {
    const { tools, runHelper } = makeTools();
    expect(installSignedDeb(DEB, tools)).toBe("installed");
    expect(runHelper).toHaveBeenCalledWith(DEB, `${DEB}.sig`);
  });

  it("uses the password prompt on an install without the helper", () => {
    const { tools, runHelper } = makeTools({ files: [] });
    expect(installSignedDeb(DEB, tools)).toBe("password");
    expect(runHelper).not.toHaveBeenCalled();
  });

  it("refuses an unsigned package instead of asking for the password", () => {
    const { tools, runHelper } = makeTools({ files: [UPDATE_HELPER_PATH] });
    expect(() => installSignedDeb(DEB, tools)).toThrow(/no signature/);
    expect(runHelper).not.toHaveBeenCalled();
  });

  it.each([65, 66, 67, 64, 1])("reports the helper's refusal %i, without a prompt", (status) => {
    const { tools } = makeTools({ status, stderr: "SpecWithCode update refused: why.\n" });
    expect(() => installSignedDeb(DEB, tools)).toThrow("SpecWithCode update refused: why.");
  });

  it("names the exit code when the helper said nothing", () => {
    const { tools } = makeTools({ status: 65 });
    expect(() => installSignedDeb(DEB, tools)).toThrow(/exited with 65/);
  });

  it.each([
    [3, "a downgrade someone chose"],
    [126, "a dismissed polkit request"],
    [127, "a session polkit does not allow"],
  ])("leaves exit %i to the password prompt: %s", (status) => {
    const { tools } = makeTools({ status });
    expect(installSignedDeb(DEB, tools)).toBe("password");
  });

  it("uses the password prompt when pkexec is missing", () => {
    const error: NodeJS.ErrnoException = new Error("spawn pkexec ENOENT");
    error.code = "ENOENT";
    const { tools } = makeTools({ status: null, error });
    expect(installSignedDeb(DEB, tools)).toBe("password");
  });

  it("does not treat a helper that timed out as installed or as a prompt", () => {
    const error: NodeJS.ErrnoException = new Error("spawnSync pkexec ETIMEDOUT");
    error.code = "ETIMEDOUT";
    const { tools } = makeTools({ status: null, error });
    expect(() => installSignedDeb(DEB, tools)).toThrow(/ETIMEDOUT/);
  });
});

describe("unattendedDebInstallReadiness", () => {
  it("is ready only with the helper, the signature and polkit's yes", () => {
    expect(unattendedDebInstallReadiness(DEB, makeTools().tools)).toBe("ready");
  });

  it.each([
    ["no-helper", { files: [] }],
    ["no-signature", { files: [UPDATE_HELPER_PATH] }],
    ["needs-authentication", { actionAllowed: false }],
  ] as const)("answers %s and never runs the helper", (answer, options) => {
    const { tools, runHelper } = makeTools(options);
    expect(unattendedDebInstallReadiness(DEB, tools)).toBe(answer);
    expect(runHelper).not.toHaveBeenCalled();
  });
});

describe("saveFeedSignature", () => {
  it("decodes the feed's signature beside the download", () => {
    const { tools, written } = makeTools();
    saveFeedSignature(
      { downloadedFile: DEB, debSignature: Buffer.from("sig").toString("base64") },
      tools,
    );
    expect(written).toEqual([[`${DEB}.sig`, "sig"]]);
  });

  it("removes an older signature when the feed has none", () => {
    const { tools, written, removed } = makeTools();
    saveFeedSignature({ downloadedFile: DEB }, tools);
    expect(written).toEqual([]);
    expect(removed).toEqual([`${DEB}.sig`]);
  });
});

describe("useSignedDebInstall", () => {
  const makeUpdater = () => {
    const listeners: Array<(info: { downloadedFile?: unknown; debSignature?: unknown }) => void> =
      [];
    const passwordInstall = vi.fn(() => true);
    const relaunch = vi.fn();
    const updater: DebUpdaterInstall = {
      doInstall: passwordInstall,
      downloadedUpdateHelper: { file: DEB },
      app: { relaunch },
      on: (_event, listener) => listeners.push(listener),
    };
    return { updater, passwordInstall, relaunch, listeners };
  };

  it("installs and relaunches without the updater's dpkg and pkexec", () => {
    const { updater, passwordInstall, relaunch } = makeUpdater();
    useSignedDebInstall(updater, makeTools().tools);
    expect(updater.doInstall({ isForceRunAfter: true })).toBe(true);
    expect(passwordInstall).not.toHaveBeenCalled();
    expect(relaunch).toHaveBeenCalledOnce();
  });

  it("does not relaunch an install made on the way out of the app", () => {
    const { updater, relaunch } = makeUpdater();
    useSignedDebInstall(updater, makeTools().tools);
    expect(updater.doInstall({ isForceRunAfter: false })).toBe(true);
    expect(relaunch).not.toHaveBeenCalled();
  });

  it("falls through to the updater's own install where the helper cannot run", () => {
    const { updater, passwordInstall, relaunch } = makeUpdater();
    useSignedDebInstall(updater, makeTools({ files: [] }).tools);
    expect(updater.doInstall({ isForceRunAfter: true })).toBe(true);
    expect(passwordInstall).toHaveBeenCalledWith({ isForceRunAfter: true });
    expect(relaunch).not.toHaveBeenCalled();
  });

  it("lets a refusal reach the updater's error handling, with no prompt and no relaunch", () => {
    const { updater, passwordInstall, relaunch } = makeUpdater();
    useSignedDebInstall(updater, makeTools({ status: 65, stderr: "bad signature" }).tools);
    expect(() => updater.doInstall({ isForceRunAfter: true })).toThrow("bad signature");
    expect(passwordInstall).not.toHaveBeenCalled();
    expect(relaunch).not.toHaveBeenCalled();
  });

  it("saves the signature of each downloaded version", () => {
    const { updater, listeners } = makeUpdater();
    const { tools, written } = makeTools();
    useSignedDebInstall(updater, tools);
    listeners[0]!({ downloadedFile: DEB, debSignature: Buffer.from("s").toString("base64") });
    expect(written).toEqual([[`${DEB}.sig`, "s"]]);
  });
});
