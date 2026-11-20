// Clock's icon tabs on iOS 27 and the Settings scroll, as run pr746-1 met them.

import { describe, expect, it } from "vite-plus/test";

import { runCheck, simulatedPhone } from "./iphone-mirroring-check.mjs";

describe("icon tabs and scrolling", () => {
  it("judges Stopwatch pages by their words when the big digits read as specks", async () => {
    const phone = simulatedPhone({ iconTabs: true, timerNoise: true });
    const result = await runCheck(phone.deps);
    expect(result.lines).toContain("Clicks landed: 20 of 20");
    expect(result.lines.at(-1)).toMatch(/^Result: PASS/);
  });

  it("still fails a tap that leaves the other tab's page", async () => {
    const phone = simulatedPhone({ iconTabs: true, timerNoise: true, missClick: 5 });
    const result = await runCheck(phone.deps);
    expect(result.lines).toContainEqual(
      expect.stringMatching(/^FAIL click 5\/20: .*page did not change/),
    );
  });

  it("calls a tap that only expanded the tab pill a miss, and says so", async () => {
    // Tap 9 after the setup tap is click 9: the pill opens and stays open.
    const phone = simulatedPhone({
      iconTabs: true,
      pillExpands: (n) => (n === 9 ? "stays" : undefined),
    });
    const result = await runCheck(phone.deps);
    expect(result.lines).toContainEqual(
      expect.stringMatching(
        /^FAIL click 9\/20: .*the tap reached the tab pill, which expanded to show its labels instead of switching tabs \(still expanded on the next reading\)/,
      ),
    );
  });

  it("never calls nearby text outside the bar an expanded pill", async () => {
    const phone = simulatedPhone({ iconTabs: true, missClick: 9 });
    const ocr = phone.deps.ocr;
    // Beside and above the column (x 920, y 580 to 740), as the review's counterexample.
    phone.deps.ocr = async (...args) => [
      ...(await ocr(...args)),
      { text: "Timers unavailable", x: 859, y: 559, width: 60, height: 10 },
      { text: "Timers", x: 859, y: 559, width: 60, height: 10 },
    ];
    const result = await runCheck(phone.deps);
    const click = result.lines.find((entry) => entry.startsWith("FAIL click 9/20"));
    expect(click).toMatch(/page did not change/);
    expect(click).not.toMatch(/pill/);
  });

  it("counts a tap whose page switches once the expanded pill settles", async () => {
    const phone = simulatedPhone({
      iconTabs: true,
      pillExpands: (n) => (n === 9 ? "switches" : undefined),
    });
    const result = await runCheck(phone.deps);
    expect(result.lines).toContainEqual(
      expect.stringMatching(
        /^PASS click 9\/20: .*the tab pill showed expanded with its labels after the tap, and the page had switched by the next reading/,
      ),
    );
    expect(result.lines).toContain("Clicks landed: 20 of 20");
  });

  it("scrolls again when one call moves the list only a little, and judges the whole move", async () => {
    const phone = simulatedPhone({ callPx: 13 });
    const result = await runCheck(phone.deps);
    expect(result.lines).toContainEqual(
      expect.stringMatching(
        /^PASS scroll down: 2 calls of 25 wheel notches moved -13px, -13px; in all shared text moved -26px/,
      ),
    );
    expect(result.lines).toContainEqual(expect.stringMatching(/^PASS scroll up: 2 calls/));
    // A list that does not move fails after the last call.
    const stuck = simulatedPhone({ callPx: 0 });
    const failed = await runCheck(stuck.deps);
    expect(failed.lines).toContainEqual(
      expect.stringMatching(/^FAIL scroll down: 3 calls of 25 wheel notches moved 0px, 0px, 0px/),
    );
  });

  it("scrolls far enough when a wheel notch moves the list only a few pixels", async () => {
    const phone = simulatedPhone({ notchPx: 2.6 });
    const result = await runCheck(phone.deps);
    expect(result.lines).toContainEqual(
      expect.stringMatching(
        /^PASS scroll down: 1 call of 25 wheel notches moved -65px; in all shared text moved -65px/,
      ),
    );
    expect(result.lines).toContainEqual(expect.stringMatching(/^PASS scroll up/));
  });

  it("calls a run invalid when another app's window lies over the Mirroring window", async () => {
    const wispr = {
      app: "Wispr Flow",
      name: "Status",
      layer: 1000,
      x: 500,
      y: 180,
      width: 512,
      height: 614,
    };
    const phone = simulatedPhone({ overlays: [wispr] });
    const result = await runCheck(phone.deps);
    expect(result.lines.at(-1)).toMatch(
      /^Result: INVALID \(another app's window lies over the iPhone Mirroring window: Wispr Flow "Status" \(layer 1000, 512x614 at 500, 180\)\. Quit that app/,
    );
    // Nothing reached the phone: no tap, key, typing or scroll.
    expect(
      phone.state.calls.filter((tool) => /computer_(click|key|type|scroll|drag)/.test(tool)),
    ).toEqual([]);
    const clear = await runCheck(simulatedPhone().deps);
    expect(clear.lines).toContain("SETUP no other app's window over the iPhone Mirroring window");
  });
});
