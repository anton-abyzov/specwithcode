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

  it("scrolls far enough when a wheel notch moves the list only a few pixels", async () => {
    const phone = simulatedPhone({ notchPx: 2.6 });
    const result = await runCheck(phone.deps);
    expect(result.lines).toContainEqual(
      expect.stringMatching(/^PASS scroll down: 25 wheel notches: shared text moved -65px/),
    );
    expect(result.lines).toContainEqual(expect.stringMatching(/^PASS scroll up/));
  });
});
