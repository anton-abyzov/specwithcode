// @effect-diagnostics globalDate:off -- Test fixtures format a fixed clock.
import {
  SCREEN_SHARE_CONTROL_ASKS,
  SCREEN_SHARE_GRANT_IDLE_MS,
  SCREEN_SHARE_HELD_SILENCE_MS,
  SCREEN_SHARE_PROMPT_MS,
  SCREEN_SHARE_RECORD,
} from "@specweave-studio/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { AUTHENTICATE_PAUSE_MS, AUTHENTICATE_TRIES } from "./screenShareSession.logic.ts";
import { live, makeDevice, rig, SID, type Rig } from "./screenShareSession.testkit.ts";

type Viewer = Awaited<ReturnType<typeof live>>;

const featuresOf = (viewer: Viewer) => {
  const state = viewer.states.findLast((each) => each.phase === "live");
  return state?.phase === "live" ? state.features : undefined;
};

/** A live view whose person at the machine then allowed control for good. */
async function controlling(r: Rig, device: Awaited<ReturnType<typeof makeDevice>>) {
  const viewer = await live(r, device);
  await viewer.tell(SCREEN_SHARE_RECORD.controlRequest, {});
  await r.sessions.answerPrompt(SID, "always");
  await viewer.drain();
  return viewer;
}

const keyDown = { displayId: "1", events: [{ t: "key", code: "KeyA", down: true }] };

describe("control is announced only where it can work (AC-15)", () => {
  it("a machine without control announces only the picture, and a request ends the session as in slice 1", async () => {
    const r = rig();
    const viewer = await live(r, await makeDevice());
    expect(featuresOf(viewer)).toEqual(["viewport"]);
    await viewer.tell(SCREEN_SHARE_RECORD.controlRequest, {});
    expect(r.closes.at(-1)?.reason).toBe("protocol_error");
  });

  it("a machine that can be controlled says so, and sends nothing about control to a viewer that never asks", async () => {
    const r = rig({ control: true });
    const viewer = await live(r, await makeDevice());
    expect(featuresOf(viewer)).toEqual(["viewport", "control"]);
    // The viewer's reader throws on a record it does not know; none came.
    expect(viewer.controls).toEqual([]);
    expect(r.control.starts).toBe(0);
  });

  it("a machine without Accessibility does not announce control", async () => {
    const r = rig({ control: true });
    r.control.available = false;
    const viewer = await live(r, await makeDevice());
    expect(featuresOf(viewer)).toEqual(["viewport"]);
  });

  it("input from a viewer that never asked for control ends the session", async () => {
    const r = rig({ control: true });
    const viewer = await live(r, await makeDevice());
    await viewer.tell(SCREEN_SHARE_RECORD.input, keyDown);
    expect(r.closes.at(-1)?.reason).toBe("protocol_error");
    expect(r.control.posted).toEqual([]);
  });
});

describe("the control grant (AC-10, D-05)", () => {
  it("a view grant does not skip the control prompt", async () => {
    const r = rig({ control: true });
    const device = await makeDevice();
    const viewer = await live(r, device);
    r.store.addGrant(device.device);
    await viewer.tell(SCREEN_SHARE_RECORD.controlRequest, {});
    expect(r.prompts.at(-1)).toMatchObject({ kind: "control", stage: "ask", label: "Work laptop" });
    expect(r.prompts.at(-1)?.code).toBeUndefined();
    expect(viewer.controls).toEqual([{ mode: "asking" }]);
    expect(r.control.starts).toBe(0);
    expect(r.control.controlled).toBe(false);
  });

  it("Always allow control asks the system, then banner, list, grant, pause and helper, in that order", async () => {
    const r = rig({ control: true });
    const device = await makeDevice();
    const viewer = await controlling(r, device);
    expect(r.authReasons.at(-1)).toContain('always allow "Work laptop" (7F3A) to control this Mac');
    expect(r.banners.at(-1)).toMatchObject({ label: "Work laptop", controlling: true });
    expect(r.store.audit.at(-1)?.control).toMatchObject({ outcome: "allowed_always" });
    expect(r.store.hasControlGrant(device.device.thumbprint)).toBe(true);
    expect(r.control.controlled).toBe(true);
    expect(r.control.starts).toBe(1);
    expect(r.state.promptVisible).toBe(false);
    expect(viewer.controls.at(-1)).toEqual({ mode: "controlling" });
    expect(r.sessions.active()).toMatchObject({ controlling: true });
  });

  it("offers no Allow once for control", async () => {
    const r = rig({ control: true });
    const viewer = await live(r, await makeDevice());
    await viewer.tell(SCREEN_SHARE_RECORD.controlRequest, {});
    await r.sessions.answerPrompt(SID, "once");
    await viewer.drain();
    expect(r.control.starts).toBe(0);
    expect(viewer.controls).toEqual([{ mode: "asking" }]);
  });

  it("with a control grant, control starts with nobody here, and the grant's clock restarts", async () => {
    const r = rig({ control: true });
    const device = await makeDevice();
    r.store.addControlGrant(device.device);
    await r.advance(SCREEN_SHARE_GRANT_IDLE_MS - 60_000);
    const viewer = await live(r, device);
    await viewer.tell(SCREEN_SHARE_RECORD.controlRequest, {});
    expect(r.prompts.filter((prompt) => prompt.kind === "control")).toEqual([]);
    expect(viewer.controls.at(-1)).toEqual({ mode: "controlling" });
    expect(r.store.audit.at(-1)?.control?.outcome).toBe("allowed_by_grant");
    await r.advance(120_000);
    expect(r.store.hasControlGrant(device.device.thumbprint)).toBe(true);
  });

  it("a control grant ends 30 days after its last use", async () => {
    const r = rig({ control: true });
    const device = await makeDevice();
    r.store.addControlGrant(device.device);
    await r.advance(SCREEN_SHARE_GRANT_IDLE_MS + 1);
    expect(r.store.hasControlGrant(device.device.thumbprint)).toBe(false);
  });

  it("Deny goes back to viewing, counts against the device, and the prompt comes at most twice", async () => {
    const r = rig({ control: true });
    const viewer = await live(r, await makeDevice());
    for (let ask = 0; ask < SCREEN_SHARE_CONTROL_ASKS; ask += 1) {
      await viewer.tell(SCREEN_SHARE_RECORD.controlRequest, {});
      await r.sessions.answerPrompt(SID, "deny");
      await viewer.drain();
      expect(viewer.controls.at(-1)).toEqual({ mode: "viewing", reason: "denied" });
    }
    await viewer.tell(SCREEN_SHARE_RECORD.controlRequest, {});
    expect(viewer.controls.at(-1)).toEqual({ mode: "viewing", reason: "asked_too_often" });
    expect(r.prompts.filter((prompt) => prompt.kind === "control")).toHaveLength(2);
    // Viewing goes on.
    expect(r.closes).toEqual([]);
    expect(r.control.starts).toBe(0);
  });

  it("a prompt nobody answers ends after 60 seconds; an answer after that counts for nothing", async () => {
    const r = rig({ control: true });
    const viewer = await live(r, await makeDevice());
    await viewer.tell(SCREEN_SHARE_RECORD.controlRequest, {});
    let answer: (present: boolean) => void = () => {};
    r.state.auth = () => new Promise((resolve) => (answer = resolve));
    const pending = r.sessions.answerPrompt(SID, "always");
    await r.advance(SCREEN_SHARE_PROMPT_MS);
    answer(true);
    await pending;
    await viewer.drain();
    expect(viewer.controls.at(-1)).toEqual({ mode: "viewing", reason: "prompt_timeout" });
    expect(r.control.starts).toBe(0);
    expect(r.control.controlled).toBe(false);
  });

  it("system dialogs that end without a person three times are a refusal", async () => {
    const r = rig({ control: true });
    const viewer = await live(r, await makeDevice());
    await viewer.tell(SCREEN_SHARE_RECORD.controlRequest, {});
    r.state.auth = () => Promise.resolve(false);
    for (let tries = 0; tries < AUTHENTICATE_TRIES; tries += 1) {
      await r.sessions.answerPrompt(SID, "always");
      await r.advance(AUTHENTICATE_PAUSE_MS);
    }
    await viewer.drain();
    expect(viewer.controls.at(-1)).toEqual({ mode: "viewing", reason: "denied" });
    expect(r.control.starts).toBe(0);
  });
});

describe("control fails closed (AC-12)", () => {
  it("no banner, no control: the session ends", async () => {
    const r = rig({ control: true });
    const viewer = await live(r, await makeDevice());
    await viewer.tell(SCREEN_SHARE_RECORD.controlRequest, {});
    r.state.bannerShows = false;
    await r.sessions.answerPrompt(SID, "always");
    await r.sessions.idle();
    expect(r.closes.at(-1)?.reason).toBe("banner_lost");
    expect(r.control.starts).toBe(0);
    expect(r.control.controlled).toBe(false);
  });

  it("no entry in the list, no control: back to viewing", async () => {
    const r = rig({ control: true });
    const viewer = await live(r, await makeDevice());
    await viewer.tell(SCREEN_SHARE_RECORD.controlRequest, {});
    r.file.failWhen = (stored) => JSON.stringify(stored).includes('"control":{');
    await r.sessions.answerPrompt(SID, "always");
    await viewer.drain();
    expect(viewer.controls.at(-1)).toEqual({ mode: "viewing", reason: "unavailable" });
    expect(r.banners.at(-1)?.controlling).toBeUndefined();
    expect(r.control.starts).toBe(0);
  });

  it("a helper without Accessibility: back to viewing, computer use not left paused", async () => {
    const r = rig({ control: true });
    r.control.startResult = "no_permission";
    const viewer = await controlling(r, await makeDevice());
    expect(viewer.controls.at(-1)).toEqual({ mode: "viewing", reason: "no_permission" });
    expect(r.control.controlled).toBe(false);
    expect(r.banners.at(-1)?.controlling).toBeUndefined();
  });

  it("a session that ends while the helper starts stops the helper and resumes computer use", async () => {
    const r = rig({ control: true });
    const device = await makeDevice();
    r.store.addControlGrant(device.device);
    const viewer = await live(r, device);
    let go: () => void = () => {};
    r.control.heldStart = new Promise((resolve) => (go = resolve));
    // Not awaited: the viewer's wait would wait on the helper this test holds.
    const told = viewer.tell(SCREEN_SHARE_RECORD.controlRequest, {});
    await vi.waitFor(() => expect(r.control.starts).toBe(1));
    r.sessions.stop();
    go();
    await told;
    await r.sessions.idle();
    expect(r.control.stops).toBe(1);
    expect(r.control.controlled).toBe(false);
    expect(r.closes.at(-1)?.reason).toBe("stopped_at_machine");
  });
});

describe("input while controlling (AC-13)", () => {
  it("maps frame fractions onto the shown display, in global points", async () => {
    const r = rig({ control: true });
    const viewer = await controlling(r, await makeDevice());
    await viewer.tell(SCREEN_SHARE_RECORD.input, {
      displayId: "1",
      events: [
        { t: "move", x: 0.5, y: 0.5 },
        { t: "button", button: "left", down: true, x: 1, y: 1 },
        { t: "scroll", dx: 0, dy: -120, x: 0, y: 0 },
        { t: "key", code: "KeyA", down: true },
      ],
    });
    expect(r.control.posted).toEqual([
      [
        { t: "move", x: 756, y: 491 },
        { t: "button", button: "left", down: true, x: 1511, y: 981 },
        { t: "scroll", dx: 0, dy: -120, x: 0, y: 0 },
        { t: "key", code: "KeyA", down: true },
      ],
    ]);
  });

  it("drops events for a display that is not the one shown, and while the machine is locked", async () => {
    const r = rig({ control: true });
    const viewer = await controlling(r, await makeDevice());
    await viewer.tell(SCREEN_SHARE_RECORD.input, { ...keyDown, displayId: "2" });
    r.state.grabs.push({ kind: "locked" });
    await r.advance(400);
    await viewer.tell(SCREEN_SHARE_RECORD.input, keyDown);
    expect(r.control.posted).toEqual([]);
    expect(r.closes).toEqual([]);
  });

  it("ends the session on input that is not what a viewer sends", async () => {
    const r = rig({ control: true });
    const viewer = await controlling(r, await makeDevice());
    await viewer.tell(SCREEN_SHARE_RECORD.input, {
      displayId: "1",
      events: [{ t: "key", code: "NotAKey", down: true }],
    });
    expect(r.closes.at(-1)?.reason).toBe("protocol_error");
    expect(r.control.controlled).toBe(false);
  });

  it("tells the viewer why typing is off, and when it is back", async () => {
    const r = rig({ control: true });
    const viewer = await controlling(r, await makeDevice());
    r.control.onBlocked?.("browser");
    r.control.onBlocked?.("browser");
    r.control.onBlocked?.(null);
    await viewer.drain();
    expect(viewer.controls.slice(-2)).toEqual([
      { mode: "controlling", blocked: "browser" },
      { mode: "controlling" },
    ]);
  });
});

describe("every end of control lets go of what is held (AC-14)", () => {
  it("back to viewing: keys let go, helper stopped, banner says viewing, computer use back", async () => {
    const r = rig({ control: true });
    const viewer = await controlling(r, await makeDevice());
    await viewer.tell(SCREEN_SHARE_RECORD.input, keyDown);
    await viewer.tell(SCREEN_SHARE_RECORD.controlEnd, {});
    expect(r.control.releases).toEqual([{ keys: ["KeyA"], buttons: [] }]);
    expect(r.control.stops).toBe(1);
    expect(r.control.controlled).toBe(false);
    expect(r.banners.at(-1)?.controlling).toBeUndefined();
    expect(viewer.controls.at(-1)).toEqual({ mode: "viewing", reason: "ended" });
    expect(r.store.audit.at(-1)?.control?.endedAt).toBeDefined();
    expect(r.closes).toEqual([]);
  });

  it("Stop at the machine ends control and the session at once", async () => {
    const r = rig({ control: true });
    const viewer = await controlling(r, await makeDevice());
    await viewer.tell(SCREEN_SHARE_RECORD.input, {
      displayId: "1",
      events: [{ t: "button", button: "left", down: true, x: 0.2, y: 0.2 }],
    });
    r.sessions.stop();
    expect(r.control.releases).toEqual([{ keys: [], buttons: ["left"] }]);
    expect(r.control.stops).toBe(1);
    expect(r.control.controlled).toBe(false);
    expect(r.state.bannerVisible).toBe(false);
    await r.sessions.idle();
    expect(r.closes.at(-1)?.reason).toBe("stopped_at_machine");
  });

  it("a viewer that goes quiet with a key down has it let go, and stays in control", async () => {
    const r = rig({ control: true });
    const viewer = await controlling(r, await makeDevice());
    await viewer.tell(SCREEN_SHARE_RECORD.input, keyDown);
    await r.advance(SCREEN_SHARE_HELD_SILENCE_MS);
    expect(r.control.releases).toEqual([{ keys: ["KeyA"], buttons: [] }]);
    expect(r.control.controlled).toBe(true);
  });

  it("showing another display lets go first", async () => {
    const r = rig({ control: true });
    const viewer = await controlling(r, await makeDevice());
    await viewer.tell(SCREEN_SHARE_RECORD.input, keyDown);
    await viewer.tell(SCREEN_SHARE_RECORD.showDisplay, { displayId: "2" });
    expect(r.control.releases).toEqual([{ keys: ["KeyA"], buttons: [] }]);
  });

  it("a helper that went away: a fresh one lets go of what it held, and control ends", async () => {
    const r = rig({ control: true });
    const viewer = await controlling(r, await makeDevice());
    await viewer.tell(SCREEN_SHARE_RECORD.input, keyDown);
    r.control.onExit?.();
    await viewer.drain();
    expect(r.control.orphaned).toEqual([{ keys: ["KeyA"], buttons: [] }]);
    expect(r.control.controlled).toBe(false);
    expect(viewer.controls.at(-1)).toEqual({ mode: "viewing", reason: "unavailable" });
  });

  it("the viewer leaving while controlling lets go and resumes computer use", async () => {
    const r = rig({ control: true });
    const viewer = await controlling(r, await makeDevice());
    await viewer.tell(SCREEN_SHARE_RECORD.input, keyDown);
    r.sessions.closed(SID);
    expect(r.control.releases).toEqual([{ keys: ["KeyA"], buttons: [] }]);
    expect(r.control.controlled).toBe(false);
    expect(r.store.audit.at(-1)).toMatchObject({
      reason: "viewer_ended",
      control: { outcome: "allowed_always" },
    });
  });
});
