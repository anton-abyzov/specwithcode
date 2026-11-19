// Opening apps through Spotlight and reading typed text past the text cursor.

import { describe, expect, it } from "vite-plus/test";

import { runCheck, simulatedPhone, stillHome } from "./iphone-mirroring-check.mjs";

describe("opening apps and reading typed text", () => {
  it("reads a typed sample again after the cursor blinks, and passes it only when read as typed", async () => {
    const phone = simulatedPhone({ cursorBends: ["hbbt"] });
    const result = await runCheck(phone.deps);
    expect(result.lines).toContain(
      'PASS type "hbbt": shown on the phone on reading 2 of 3, the cursor\'s blink apart; frontmost iPhone Mirroring',
    );
    expect(result.lines.at(-1)).toMatch(/^Result: PASS/);
    // A wrong key reads wrong every time.
    const wrong = simulatedPhone();
    const call = wrong.deps.call;
    wrong.deps.call = (tool, args) =>
      call(tool, tool === "computer_type" && args.text === "hbbt" ? { text: "hbba" } : args);
    const failed = await runCheck(wrong.deps);
    expect(failed.lines).toContainEqual(
      expect.stringMatching(/^FAIL type "hbbt": not shown as typed in 3 readings/),
    );
  });

  it("opens Spotlight again to open Clock when the phone shows only its home screen", async () => {
    // cmd+3 number 8 opens Spotlight for Clock (1 is the path probe, 2-6 the samples, 7 the repeat).
    const phone = simulatedPhone({ spotlightMisses: (n) => n === 8 });
    const result = await runCheck(phone.deps);
    expect(result.lines).toContainEqual(
      expect.stringMatching(
        /^NOTE .* opening Clock: after typing "Clock" the phone showed only its home screen, no search field \(try 1 of 3\)/,
      ),
    );
    expect(result.lines.at(-1)).toMatch(/^Result: PASS/);
  });

  it("calls tabs unsure, never failed, when Clock never opens", async () => {
    const phone = simulatedPhone({ spotlightMisses: (n) => n >= 8 && n <= 10 });
    const result = await runCheck(phone.deps);
    expect(result.lines).toContainEqual(
      expect.stringMatching(
        /^UNSURE tabs: Clock could not be opened, so no tab was tried: no usable Spotlight search for "Clock" showed on 3 tries; last try: after typing "Clock" the phone showed only its home screen/,
      ),
    );
    expect(result.lines.some((entry) => entry.startsWith("FAIL "))).toBe(false);
    expect(result.lines.at(-1)).toMatch(/^Result: INVALID \(could not judge tabs/);
    // Return and the tap open nothing: Clock did not open either.
    const dead = simulatedPhone({ deadReturn: true });
    const call = dead.deps.call;
    dead.deps.call = (tool, args) =>
      tool === "computer_click" && dead.state.app === "spotlight"
        ? call("computer_screenshot", {})
        : call(tool, args);
    const stuck = await runCheck(dead.deps);
    expect(stuck.lines).toContainEqual(
      expect.stringMatching(
        /^UNSURE tabs: Clock did not open, so no tab was tried: after Return and a tap on its result Spotlight still showed "Clock"/,
      ),
    );
    expect(stuck.lines.some((entry) => entry.startsWith("FAIL "))).toBe(false);
  });

  it("calls scroll unsure, never failed, when Settings never opens", async () => {
    // With no misses, cmd+3 number 9 opens Spotlight for Settings.
    const phone = simulatedPhone({ spotlightMisses: (n) => n >= 9 });
    const result = await runCheck(phone.deps);
    expect(result.lines).toContainEqual(
      expect.stringMatching(/^UNSURE scroll: Settings could not be opened, so no scroll was tried/),
    );
    expect(result.lines.some((entry) => entry.startsWith("FAIL "))).toBe(false);
    expect(result.lines.at(-1)).toMatch(
      /^Result: INVALID \(could not judge scroll; 20 clicks landed\)/,
    );
  });

  it("reads again after the blink before going home, when Spotlight shows over the home screen", async () => {
    // Text in the margins in every reading makes the Spotlight reading look like the home screen.
    const behind = ["Mail", "Notes", "Music", "Photos"];
    const phone = simulatedPhone({ cursorBends: ["hbbt"], behind });
    const result = await runCheck(phone.deps);
    expect(result.lines).toContain(
      'PASS type "hbbt": shown on the phone on reading 2 of 3, the cursor\'s blink apart; frontmost iPhone Mirroring',
    );
    expect(result.lines.at(-1)).toMatch(/^Result: PASS/);
    // A wrong key goes home to be told from the home screen, and the failure shows what the field read.
    const wrong = simulatedPhone({ behind });
    const call = wrong.deps.call;
    let homed = 0;
    let typed = false;
    wrong.deps.call = (tool, args) => {
      if (tool === "computer_type") typed = args.text === "hbbt";
      if (typed && tool === "computer_key" && args.keys === "cmd+1" && wrong.state.query === "hbba")
        homed++;
      return call(tool, tool === "computer_type" && args.text === "hbbt" ? { text: "hbba" } : args);
    };
    const failed = await runCheck(wrong.deps);
    expect(homed).toBeGreaterThan(0);
    expect(failed.lines).toContainEqual(
      expect.stringMatching(
        /^FAIL type "hbbt": not shown as typed in 3 readings.*last read "hbba"@/,
      ),
    );
  });

  it("calls scroll unsure when Settings did not open and the home screen reads with noise", async () => {
    const phone = simulatedPhone();
    const call = phone.deps.call;
    let lost = false;
    phone.deps.call = (tool, args) => {
      if (tool === "computer_key" && args.keys === "return" && phone.state.query === "Settings") {
        lost = true;
        phone.state.app = "home";
        return call("computer_screenshot", {});
      }
      return call(tool, args);
    };
    const ocr = phone.deps.ocr;
    phone.deps.ocr = async (...args) => {
      const read = await ocr(...args);
      return lost && phone.state.app === "home"
        ? [...read, { text: "Pncios", x: 700, y: 400, width: 60, height: 20 }]
        : read;
    };
    const result = await runCheck(phone.deps);
    expect(result.lines).toContainEqual(
      expect.stringMatching(
        /^UNSURE scroll: Settings did not open, so no scroll was tried: after Return the phone showed only its home screen/,
      ),
    );
    expect(result.lines.some((entry) => entry.startsWith("FAIL "))).toBe(false);
  });

  it("tells the home screen from an opened app with text of other windows in the margins", () => {
    const line = (text, y) => ({ text, x: 620, y, width: 100, height: 20 });
    const margins = ["CALENDAR", "Thu. Nov 19", "Ov", "lo"].map((text, index) =>
      line(text, 110 + index * 30),
    );
    const icons = [
      "Weather",
      "Flood Watch",
      "Messages",
      "Photos",
      "Camera",
      "Settings",
      "Finance",
      "EasyChamp",
      "Maps",
      "Gmail",
      "YouTube",
      "Telegram",
    ];
    const home = [...margins, ...icons.map((text, index) => line(text, 300 + index * 30))];
    // The same screen read again with two labels misread.
    const noisy = home.map((entry) =>
      entry.text === "Photos"
        ? { ...entry, text: "Phatos" }
        : entry.text === "Maps"
          ? { ...entry, text: "In 8f" }
          : entry,
    );
    expect(stillHome(noisy, home)).toBe(true);
    const settings = [
      ...margins,
      ...[
        "Settings",
        "General",
        "Accessibility",
        "Camera",
        "Control Center",
        "Display & Brightness",
        "Search",
        "Siri",
        "Wallpaper",
      ].map((text, index) => line(text, 200 + index * 50)),
    ];
    expect(stillHome(settings, home)).toBe(false);
  });

  it("never presses Return after its own home key closed the search", async () => {
    const behind = ["Mail", "Notes", "Music", "Photos"];
    const phone = simulatedPhone({ behind });
    const ocr = phone.deps.ocr;
    // Both "Clock" lines misread while Spotlight holds the query: no field is read.
    phone.deps.ocr = async (...args) => {
      const read = await ocr(...args);
      return phone.state.app === "spotlight" && phone.state.query === "Clock"
        ? read.map((entry) => (entry.text === "Clock" ? { ...entry, text: "Clack" } : entry))
        : read;
    };
    const call = phone.deps.call;
    let homeReturns = 0;
    phone.deps.call = (tool, args) => {
      if (tool === "computer_key" && args.keys === "return" && phone.state.app === "home")
        homeReturns++;
      return call(tool, args);
    };
    const result = await runCheck(phone.deps);
    expect(homeReturns).toBe(0);
    expect(result.lines).toContainEqual(
      expect.stringMatching(
        /^UNSURE tabs: Clock could not be opened, so no tab was tried: .*which closed the search \(try 3 of 3\)/,
      ),
    );
    expect(result.lines.some((entry) => entry.startsWith("FAIL "))).toBe(false);
  });

  it("scrolls an opened Settings list even when margin text outnumbers the home icons", async () => {
    const behind = Array.from(
      { length: 26 },
      (_, index) => `Margin ${String.fromCharCode(65 + index)}x`,
    );
    const phone = simulatedPhone({ iconTabs: true, behind });
    const ocr = phone.deps.ocr;
    phone.deps.ocr = async (...args) =>
      (await ocr(...args)).map((entry) =>
        entry.text.startsWith("Margin ")
          ? { ...entry, y: 110 + behind.indexOf(entry.text) * 14, height: 12 }
          : entry,
      );
    const result = await runCheck(phone.deps);
    expect(result.lines).toContainEqual(expect.stringMatching(/^PASS scroll down/));
    expect(result.lines.at(-1)).toMatch(/^Result: PASS/);
  });

  it("calls scroll unsure when Return left a plain Settings field showing", async () => {
    const phone = simulatedPhone();
    const call = phone.deps.call;
    phone.deps.call = (tool, args) =>
      tool === "computer_key" && args.keys === "return" && phone.state.query === "Settings"
        ? call("computer_screenshot", {})
        : call(tool, args);
    const ocr = phone.deps.ocr;
    // The Settings result's caption is not read: only the plain field shows.
    phone.deps.ocr = async (...args) =>
      (await ocr(...args)).filter(
        (entry) =>
          !(phone.state.app === "spotlight" && entry.text === "Settings" && entry.y === 260),
      );
    const result = await runCheck(phone.deps);
    expect(result.lines).toContainEqual(
      expect.stringMatching(
        /^UNSURE scroll: Settings did not open, so no scroll was tried: after Return the screen read as it did in Spotlight before Return/,
      ),
    );
    expect(result.lines.some((entry) => entry.startsWith("FAIL "))).toBe(false);
  });
});
