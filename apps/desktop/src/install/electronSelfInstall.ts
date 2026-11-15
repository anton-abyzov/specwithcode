// @effect-diagnostics-next-line nodeBuiltinImport:off -- The install step runs before the app runtime and opens the installed copy with a detached process.
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";

import * as Electron from "electron";

import { nativeTools, runMacSelfInstall, type SelfInstallOutcome } from "./macSelfInstall.ts";
import { resolveSelfInstallLocale } from "./macSelfInstallCopy.ts";

/** Runs the "Install SpecWithCode" step with Electron's native alert. Call after `whenReady`. */
export function runElectronSelfInstall(input: {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly workDir: string;
  readonly log: (message: string, data?: Record<string, unknown>) => void;
}): Promise<SelfInstallOutcome> {
  return runMacSelfInstall({
    platform: input.platform,
    isPackaged: input.isPackaged,
    execPath: process.execPath,
    env: process.env,
    homeDir: NodeOS.homedir(),
    uid: process.getuid?.() ?? -1,
    pid: process.pid,
    workDir: input.workDir,
    locale: resolveSelfInstallLocale(Electron.app.getPreferredSystemLanguages()),
    inApplicationsFolder: () => Electron.app.isInApplicationsFolder(),
    ask: async (prompt) => {
      // A quarantined app opens behind Gatekeeper's alert; bring it forward
      // so the step is not hidden behind other windows.
      Electron.app.focus({ steal: true });
      const result = await Electron.dialog.showMessageBox({
        type: "info",
        message: prompt.title,
        detail: prompt.detail,
        buttons: [...prompt.buttons],
        defaultId: 0,
        cancelId: prompt.cancelId,
        noLink: true,
      });
      return result.response;
    },
    open: (path) => {
      NodeChildProcess.spawn("/usr/bin/open", [path], { detached: true, stdio: "ignore" }).unref();
    },
    log: input.log,
    tools: nativeTools((path) => Electron.shell.trashItem(path)),
  });
}
