import type { ServerPrepareServiceUpdateResult } from "@specweave-studio/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const confirm = vi.hoisted(() => vi.fn<(text: string, options?: unknown) => Promise<boolean>>());
vi.mock("../localApi", () => ({ ensureLocalApi: () => ({ dialogs: { confirm } }) }));

import { resetConfirmDialogForTests } from "../confirmDialog";
import {
  callPrepare,
  confirmAppRestartForUpdate,
  forgetPreparesForTests,
  registerPrepare,
} from "./serviceUpdateCalls";

// How "Update now" and an app restart reach the service, and what an app
// restart asks when no dialog of the app's own is mounted.

const RUNNING = {
  idle: false,
  stoppedThreads: 0,
  blockers: [
    {
      kind: "run",
      count: 1,
      threadId: "thread-1",
      threadTitle: "Fix login",
      projectId: "project-1",
      projectTitle: "EasyChamp",
    },
  ],
} as unknown as ServerPrepareServiceUpdateResult;
const IDLE: ServerPrepareServiceUpdateResult = { idle: true, stoppedThreads: 0, blockers: [] };

beforeEach(() => {
  (globalThis as { window?: unknown }).window = globalThis;
  forgetPreparesForTests();
  resetConfirmDialogForTests();
  confirm.mockReset();
});

afterEach(() => {
  forgetPreparesForTests();
});

describe("the way to reach the service", () => {
  it("is gone once the only one registered is unregistered", async () => {
    const prepare = vi.fn(async () => RUNNING);
    const unregister = registerPrepare(prepare);
    unregister();
    expect(await callPrepare({ stopWork: false }, 5_000)).toBeNull();
    expect(prepare).not.toHaveBeenCalled();
  });

  it("is the newest one still registered", async () => {
    registerPrepare(async () => RUNNING);
    const unregister = registerPrepare(async () => IDLE);
    expect(await callPrepare({ stopWork: false }, 5_000)).toEqual(IDLE);
    unregister();
    expect(await callPrepare({ stopWork: false }, 5_000)).toEqual(RUNNING);
  });
});

describe("an app restart while work runs, with no dialog of the app's own", () => {
  it("asks the desktop to confirm, and restarts now when the user agrees", async () => {
    registerPrepare(async () => RUNNING);
    confirm.mockResolvedValue(true);
    await expect(confirmAppRestartForUpdate({ version: "0.2.5" })).resolves.toBe("now");
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("Fix login"), {
      variant: "destructive",
    });
  });

  it("does not restart when the user declines", async () => {
    registerPrepare(async () => RUNNING);
    confirm.mockResolvedValue(false);
    await expect(confirmAppRestartForUpdate({ version: "0.2.5" })).resolves.toBe("cancel");
  });

  it("asks nothing when nothing runs", async () => {
    registerPrepare(async () => IDLE);
    await expect(confirmAppRestartForUpdate({ version: "0.2.5" })).resolves.toBe("now");
    expect(confirm).not.toHaveBeenCalled();
  });
});
