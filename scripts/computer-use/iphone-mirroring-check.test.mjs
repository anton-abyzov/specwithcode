import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  anchorIn,
  CLICK_TARGET,
  jaccard,
  locateTabs,
  main,
  mcpClient,
  pageSignature,
  parseArgs,
  regionToScreenshot,
  runCheck,
  scrolled,
  newTexts,
  showsNoSpotlight,
  showsSuggestion,
  simulatedPhone,
  startsWithTyped,
  tabAnchors,
  TYPE_SAMPLES,
  typedTail,
  windowInScreenshot,
} from "./iphone-mirroring-check.mjs";

const window = { x: 600, y: 100, width: 360, height: 760 };
const line = (text, x, y, width = 100, height = 20) => ({ text, x, y, width, height });
const outDirs = [];
const tempOut = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "mirroring-check-test-"));
  outDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of outDirs.splice(0)) NodeFS.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("dry run", () => {
  it("passes every step on a phone that does what it is told", async () => {
    const phone = simulatedPhone();
    const result = await runCheck(phone.deps);
    expect(result.pass).toBe(true);
    expect(result.landed).toBe(CLICK_TARGET);
    expect(result.lines).toContain("Clicks landed: 20 of 20");
    expect(result.lines.filter((entry) => entry.startsWith("PASS click "))).toHaveLength(20);
    for (const sample of TYPE_SAMPLES) {
      expect(result.lines.some((entry) => entry.startsWith(`PASS type "${sample}"`))).toBe(true);
    }
    expect(result.lines.some((entry) => entry.startsWith("PASS scroll down"))).toBe(true);
    expect(result.lines.some((entry) => entry.startsWith("PASS scroll up"))).toBe(true);
    // The product's tools only, access asked first.
    expect(phone.state.calls[0]).toBe("request_access");
    expect(
      phone.state.calls.every((tool) => tool === "request_access" || tool.startsWith("computer_")),
    ).toBe(true);
  });

  it("passes when Spotlight's inline suggestion takes the first press of each key call", async () => {
    for (const phone of [
      simulatedPhone({ suggestion: true }),
      simulatedPhone({ suggestion: true, keepsQuery: true }),
    ]) {
      const result = await runCheck(phone.deps);
      expect(result.lines.find((entry) => entry.includes("key repeat"))).toMatch(
        /^PASS key repeat: .*one backspace removed 0 \(suggestion before yes, after no\): not judged; backspace repeat 3 removed 3 \(suggestion before no\): arrived; every press of the repeat arrived/,
      );
      expect(result.pass).toBe(true);
    }
  });

  it("fails the key repeat check when a repeat loses a press, and still counts the taps", async () => {
    for (const suggestion of [false, true]) {
      const result = await runCheck(simulatedPhone({ dropRepeat: true, suggestion }).deps);
      expect(result.pass).toBe(false);
      expect(result.lines.find((entry) => entry.includes("key repeat"))).toMatch(
        suggestion
          ? /^FAIL key repeat: .*one backspace removed 0 \(suggestion before yes, after no\): not judged; backspace repeat 3 removed 2 \(suggestion before no\): lost/
          : /^FAIL key repeat: .*one backspace removed 1 .*: arrived; backspace repeat 3 removed 2 .*: lost/,
      );
      // Every step starts from an emptied field, so a lost press spoils nothing after it.
      for (const sample of TYPE_SAMPLES) {
        expect(result.lines.some((entry) => entry.startsWith(`PASS type "${sample}"`))).toBe(true);
      }
      expect(result.lines).toContain("Clicks landed: all 20, but another check failed");
      expect(result.lines.at(-1)).toMatch(/first failure: key repeat/);
    }
  });

  it("fails the key repeat check when every key call loses a press and no suggestion shows", async () => {
    // One press short on the single backspace and on the repeat: the difference alone would pass.
    const phone = simulatedPhone({ dropRepeat: true });
    const call = phone.deps.call;
    let typedRepeat = false;
    let swallowed = false;
    const deps = {
      ...phone.deps,
      call: async (tool, args) => {
        if (tool === "computer_type" && args.text === "QHBR4207") typedRepeat = true;
        // The first single backspace after the repeat sample never reaches the phone.
        if (
          typedRepeat &&
          !swallowed &&
          tool === "computer_key" &&
          args.keys === "backspace" &&
          args.repeat === undefined
        ) {
          swallowed = true;
          return call("computer_screenshot", {});
        }
        return call(tool, args);
      },
    };
    const result = await runCheck(deps);
    expect(result.lines.find((entry) => entry.includes("key repeat"))).toMatch(
      /^FAIL key repeat: .*one backspace removed 0 \(suggestion before no, after no\): lost; backspace repeat 3 removed 2 \(suggestion before no\): lost/,
    );
  });

  /**
   * A simulated phone whose Spotlight field always reads with "- Ask Siri" after
   * it (a suggestion that takes no press), and whose key calls can be lost.
   */
  const stubbornSuggestion = ({ dropRepeat = false, loseSingle = false, loseRepeat = false }) => {
    const phone = simulatedPhone({ dropRepeat });
    let measuring = false;
    return {
      ...phone.deps,
      ocr: async (...args) =>
        (await phone.deps.ocr(...args)).map((entry) =>
          phone.state.app === "spotlight" && phone.state.query !== ""
            ? { ...entry, text: `${entry.text}- Ask Siri` }
            : entry,
        ),
      call: async (tool, args) => {
        if (tool === "computer_type") measuring = args.text === "QHBR4207";
        const lost =
          measuring &&
          tool === "computer_key" &&
          args.keys === "backspace" &&
          (args.repeat === undefined ? loseSingle : loseRepeat);
        return phone.deps.call(lost ? "computer_screenshot" : tool, lost ? {} : args);
      },
    };
  };

  it("never passes a repeat that removed one fewer while a suggestion showed", async () => {
    const result = await runCheck(stubbornSuggestion({ dropRepeat: true }));
    expect(result.lines.find((entry) => entry.includes("key repeat"))).toMatch(
      /^UNSURE key repeat: .*one backspace removed 1 .*: arrived; backspace repeat 3 removed 2 \(suggestion before yes\): unsure/,
    );
    expect(result.invalid).toBe(true);
  });

  it("fails a repeat that removed nothing, whatever the single press showed", async () => {
    for (const loseSingle of [false, true]) {
      const result = await runCheck(stubbornSuggestion({ loseSingle, loseRepeat: true }));
      expect(result.lines.find((entry) => entry.includes("key repeat"))).toMatch(
        /^FAIL key repeat: .*backspace repeat 3 removed 0 .*: lost/,
      );
      expect(result.invalid).toBe(false);
      expect(result.lines.at(-1)).toMatch(/^Result: FAIL .*first failure: key repeat/);
    }
  });

  it("judges the repeat on its own readings, whatever came before it", async () => {
    // An unknown annotation in the first reading, then a repeat that removed nothing.
    const phone = simulatedPhone({ suggestion: true });
    let measuring = false;
    let firstRead = true;
    const unknownFirst = {
      ...phone.deps,
      ocr: async (...args) => {
        const read = await phone.deps.ocr(...args);
        if (!measuring || !firstRead || phone.state.app !== "spotlight") return read;
        firstRead = false;
        return read.map((entry) => ({
          ...entry,
          text: entry.text.replace("- Ask Siri", "- new suggestion"),
        }));
      },
      call: async (tool, args) => {
        if (tool === "computer_type") measuring = args.text === "QHBR4207";
        const lost = measuring && tool === "computer_key" && args.repeat === 3;
        return phone.deps.call(lost ? "computer_screenshot" : tool, lost ? {} : args);
      },
    };
    const first = await runCheck(unknownFirst);
    expect(first.lines.find((entry) => entry.includes("key repeat"))).toMatch(
      /^FAIL key repeat: .*backspace repeat 3 removed 0 .*: lost/,
    );
    // A digit that showed up with no key pressed, then a repeat that removed nothing.
    const other = simulatedPhone();
    let typedNow = false;
    const strayDigit = {
      ...other.deps,
      call: async (tool, args) => {
        if (tool === "computer_type") typedNow = args.text === "QHBR4207";
        if (
          typedNow &&
          tool === "computer_key" &&
          args.repeat === undefined &&
          args.keys === "backspace"
        ) {
          const result = await other.deps.call(tool, args);
          other.state.query += "5";
          return result;
        }
        const lost = typedNow && tool === "computer_key" && args.repeat === 3;
        return other.deps.call(lost ? "computer_screenshot" : tool, lost ? {} : args);
      },
    };
    const second = await runCheck(strayDigit);
    expect(second.lines.find((entry) => entry.includes("key repeat"))).toMatch(
      /^FAIL key repeat: .*backspace repeat 3 removed 0 \(suggestion before no\): lost/,
    );
  });

  it("fails a repeat that removed nothing with fewer digits left than presses", async () => {
    const phone = simulatedPhone();
    let measuring = false;
    const deps = {
      ...phone.deps,
      call: async (tool, args) => {
        if (tool === "computer_type") {
          measuring = args.text === "QHBR4207";
          if (measuring) return phone.deps.call(tool, { text: "QHBR420" });
        }
        const lost = measuring && tool === "computer_key" && args.repeat === 3;
        return lost ? phone.deps.call("computer_screenshot", {}) : phone.deps.call(tool, args);
      },
    };
    const result = await runCheck(deps);
    const line = result.lines.find((entry) => entry.includes("key repeat"));
    expect(line).toMatch(/^FAIL key repeat: /);
    expect(line).toContain('"QHBR420" -> "QHBR42" -> "QHBR42" -> "QHBR42"');
    expect(line).toContain("backspace repeat 3 removed 0 (suggestion before no): lost");
  });

  it("says why the single press is not judged when its readings could not be counted", async () => {
    const phone = simulatedPhone();
    let measuring = false;
    let first = true;
    const deps = {
      ...phone.deps,
      ocr: async (...args) => {
        if (measuring && first) {
          first = false;
          return [];
        }
        return phone.deps.ocr(...args);
      },
      call: async (tool, args) => {
        if (tool === "computer_type") measuring = args.text === "QHBR4207";
        return phone.deps.call(tool, args);
      },
    };
    const result = await runCheck(deps);
    expect(result.lines.find((entry) => entry.includes("key repeat"))).toMatch(
      /^PASS key repeat: .*\(the single press is not judged: its readings could not be counted\)$/,
    );
  });

  it("never passes a lost press as a suggestion that stayed on screen", async () => {
    // The suggestion shows throughout and takes nothing; the single press and one repeat press are lost.
    const phone = simulatedPhone({ dropRepeat: true });
    const ocr = phone.deps.ocr;
    let swallowed = false;
    let repeatTyped = false;
    const deps = {
      ...phone.deps,
      ocr: async (...args) =>
        (await ocr(...args)).map((entry) =>
          phone.state.app === "spotlight" && phone.state.query !== ""
            ? { ...entry, text: `${entry.text}- Ask Siri` }
            : entry,
        ),
      call: async (tool, args) => {
        if (tool === "computer_type" && args.text === "QHBR4207") repeatTyped = true;
        if (
          repeatTyped &&
          !swallowed &&
          tool === "computer_key" &&
          args.keys === "backspace" &&
          args.repeat === undefined
        ) {
          swallowed = true;
          return phone.deps.call("computer_screenshot", {});
        }
        return phone.deps.call(tool, args);
      },
    };
    const result = await runCheck(deps);
    expect(result.pass).toBe(false);
    expect(result.lines.find((entry) => entry.includes("key repeat"))).toMatch(
      /^UNSURE key repeat: .*one backspace removed 0 \(suggestion before yes, after yes\): not judged; backspace repeat 3 removed 2 \(suggestion before yes\): unsure/,
    );
    expect(result.invalid).toBe(true);
    expect(result.lines.some((entry) => entry.startsWith("Clicks landed"))).toBe(false);
  });

  it("calls a typed sample unsure, never passed, when unknown text follows it", async () => {
    for (const shown of ["hbdt- incorrect", "hbdt "]) {
      const phone = simulatedPhone();
      const deps = {
        ...phone.deps,
        call: (tool, args) =>
          phone.deps.call(
            tool,
            tool === "computer_type" && args.text === "hbdt" ? { text: shown } : args,
          ),
      };
      const result = await runCheck(deps);
      expect(result.lines.find((entry) => entry.includes('type "hbdt"'))).toMatch(
        /^UNSURE type "hbdt"/,
      );
      expect(result.pass).toBe(false);
      expect(result.invalid).toBe(true);
    }
  });

  it("taps tabs shown in a row on top", async () => {
    const result = await runCheck(simulatedPhone({ tabsOnTop: true }).deps);
    expect(result.lines.find((entry) => entry.startsWith("PASS tabs"))).toMatch(
      /in a row at y 150/,
    );
    expect(result.pass).toBe(true);
  });

  it("starts text recognition before the timed steps, and is invalid when it cannot", async () => {
    const phone = simulatedPhone();
    const warmed = await runCheck({ ...phone.deps, warmUp: async () => 66_400 });
    expect(warmed.lines).toContain("SETUP text recognition ready in 66.4 s");
    expect(warmed.pass).toBe(true);
    const cold = await runCheck({
      ...simulatedPhone().deps,
      warmUp: async () => {
        throw new Error("spawnSync /usr/bin/osascript ETIMEDOUT");
      },
    });
    expect(cold.invalid).toBe(true);
    expect(cold.lines.at(-1)).toMatch(/text recognition did not start: .*ETIMEDOUT/);
  });

  it("says 20 of 20 only on the total line", async () => {
    const result = await runCheck(simulatedPhone().deps);
    expect(result.lines.filter((entry) => entry.includes("20 of 20"))).toEqual([
      "Clicks landed: 20 of 20",
    ]);
  });

  it("fails and counts the miss when one tap does not land", async () => {
    const result = await runCheck(simulatedPhone({ missClick: 7 }).deps);
    expect(result.pass).toBe(false);
    expect(result.lines).toContain("Clicks landed: 19 of 20");
    expect(result.lines.find((entry) => entry.startsWith("FAIL click 7/20"))).toBeDefined();
    expect(result.lines.at(-1)).toMatch(/^Result: FAIL .*first failure: click 7\/20/);
  });

  it("counts no click when taps change nothing", async () => {
    const result = await runCheck(simulatedPhone({ deadClicks: true }).deps);
    expect(result.pass).toBe(false);
    expect(result.lines).toContain("Clicks landed: 0 of 20");
  });

  it("refuses alternating pages that are not the named tabs' pages", async () => {
    // Taps that land on two other tabs (Alarms, Timers) still alternate between two stable pages.
    const phone = simulatedPhone({
      pages: {
        "World Clock": ["Alarms", "Edit", "7:00"],
        Stopwatch: ["Timers", "Cancel", "Start"],
      },
    });
    const result = await runCheck(phone.deps);
    expect(result.pass).toBe(false);
    expect(
      result.lines.some((entry) =>
        entry.startsWith('FAIL tabs: the page after tapping "World Clock"'),
      ),
    ).toBe(true);
    expect(result.lines).toContain("Clicks landed: 0 of 20");
  });

  it("refuses the Timers page in the Stopwatch slot", async () => {
    // A horizontal offset lands Stopwatch taps on Timers, which also shows Start.
    const phone = simulatedPhone({
      pages: {
        "World Clock": ["World Clock", "Edit", "Cupertino", "Today, +0HRS"],
        Stopwatch: ["Timers", "When Timer Ends", "Cancel", "Start"],
      },
    });
    const result = await runCheck(phone.deps);
    expect(result.pass).toBe(false);
    expect(result.lines.some((entry) => entry.startsWith("FAIL click 1/20"))).toBe(true);
    // Every Stopwatch tap fails; only the World Clock taps count.
    expect(result.lines).toContain("Clicks landed: 10 of 20");
  });

  it("fails a tap whose page shows the other tab's words", async () => {
    const phone = simulatedPhone({
      pages: { "World Clock": ["World Clock", "Edit"], Stopwatch: ["Lap", "World Clock"] },
    });
    const result = await runCheck(phone.deps);
    expect(result.lines.find((entry) => entry.startsWith("FAIL click 1/20"))).toContain(
      'but shows "world clock" from World Clock',
    );
  });

  const invalidResult = (result) => {
    expect(result.pass).toBe(false);
    expect(result.invalid).toBe(true);
    expect(result.lines.at(-1)).toMatch(/^Result: INVALID \(/);
    expect(result.lines.some((entry) => entry.startsWith("Clicks landed"))).toBe(false);
    expect(result.lines.some((entry) => entry.startsWith("Result: FAIL"))).toBe(false);
  };

  it("is invalid, posting nothing, when access is denied", async () => {
    const phone = simulatedPhone();
    const call = phone.deps.call;
    phone.deps.call = (tool, args) =>
      tool === "request_access"
        ? Promise.resolve({ data: { status: "denied" } })
        : call(tool, args);
    const result = await runCheck(phone.deps);
    invalidResult(result);
    expect(phone.state.calls).toEqual([]);
  });

  it("is invalid when the window shows a connection prompt instead of the phone", async () => {
    const phone = simulatedPhone();
    phone.deps.ocr = async () => [line("Lock your iPhone to connect", 620, 400)];
    const result = await runCheck(phone.deps);
    invalidResult(result);
    expect(result.lines.at(-1)).toContain(
      'not connected and showing the phone: it shows "Lock your iPhone',
    );
    expect(phone.state.calls.includes("computer_type")).toBe(false);
  });

  it("is invalid when the window is not on the main display", async () => {
    const phone = simulatedPhone();
    phone.deps.window = async () => ({ window, onMainDisplay: false });
    const result = await runCheck(phone.deps);
    invalidResult(result);
    expect(result.lines.at(-1)).toContain("main display");
  });

  it("first shows the installed app has the iPhone Mirroring path", async () => {
    const result = await runCheck(simulatedPhone().deps);
    const firstCheck = result.lines.find((entry) => /^(PASS|FAIL) /.test(entry));
    expect(firstCheck).toMatch(
      /^PASS mirroring path: computer_type refused "é" before pressing any key/,
    );
    expect(result.lines[0]).toBe("Load (1 min) at start: 3");
    expect(result.lines).toContain("Desktop app: SpecWithCode simulated (simulated)");
    expect(result.lines).toContain("Load (1 min) at end: 3");
  });

  it("is invalid on an installed app without the path, saying where the stray key went", async () => {
    const phone = simulatedPhone({ mirroringPath: false });
    const result = await runCheck(phone.deps);
    invalidResult(result);
    expect(result.lines.at(-1)).toContain("has no iPhone Mirroring path");
    expect(result.lines.at(-1)).toContain("Spotlight search field, where a stray key is harmless");
    // The probe went only into Spotlight, then was cleared, and no tap followed.
    expect(phone.state.query).toBe("");
    expect(phone.state.calls.includes("computer_click")).toBe(false);
  });

  it("is invalid when no desktop app runs", async () => {
    const phone = simulatedPhone();
    phone.deps.desktopApps = async () => [];
    const result = await runCheck(phone.deps);
    invalidResult(result);
    expect(phone.state.calls).toEqual([]);
  });

  it("calls a failed run invalid when it started above load 48, without a click total", async () => {
    // 20 taps land but a scroll fails, at a high load: no "20 of 20" may appear.
    const phone = simulatedPhone({ load: 120 });
    const call = phone.deps.call;
    phone.deps.call = (tool, args) =>
      tool === "computer_scroll" ? Promise.resolve({ data: {} }) : call(tool, args);
    const result = await runCheck(phone.deps);
    invalidResult(result);
    expect(result.lines.at(-1)).toContain("started at a 1-minute load of 120, above 48");
    expect(result.lines.some((entry) => entry.includes("20 of 20"))).toBe(false);
  });

  it("never writes 20 of 20 in a failed log, even when every tap landed", async () => {
    const phone = simulatedPhone();
    const call = phone.deps.call;
    phone.deps.call = (tool, args) =>
      tool === "computer_scroll" ? Promise.resolve({ data: {} }) : call(tool, args);
    const result = await runCheck(phone.deps);
    expect(result.lines.at(-1)).toMatch(/^Result: FAIL/);
    expect(result.lines).toContain("Clicks landed: all 20, but another check failed");
    expect(result.lines.some((entry) => entry.includes("20 of 20"))).toBe(false);
  });

  it("still fails a run that started at load 48 or less", async () => {
    const result = await runCheck(simulatedPhone({ load: 48, missClick: 2 }).deps);
    expect(result.invalid).toBe(false);
    expect(result.lines).toContain("Clicks landed: 19 of 20");
    expect(result.lines.at(-1)).toMatch(/^Result: FAIL/);
  });

  it("counts a passing run at any load", async () => {
    const result = await runCheck(simulatedPhone({ load: 300 }).deps);
    expect(result.pass).toBe(true);
    expect(result.lines).toContain("Clicks landed: 20 of 20");
    expect(result.lines.at(-1)).toMatch(/^Result: PASS/);
  });

  it("repeats a step when the gate says the app in front changed", async () => {
    const phone = simulatedPhone();
    const call = phone.deps.call;
    let refused = false;
    phone.deps.call = (tool, args) => {
      if (tool === "computer_type" && !refused) {
        refused = true;
        return Promise.reject(new Error("The app in front changed while the user was answering"));
      }
      return call(tool, args);
    };
    const result = await runCheck(phone.deps);
    expect(result.pass).toBe(true);
    expect(
      result.lines.some((entry) =>
        /^NOTE \S+ paused the path probe: computer_type was refused/.test(entry),
      ),
    ).toBe(true);
  });

  it("pauses and repeats a step when a click puts SpecWithCode in front", async () => {
    const phone = simulatedPhone({
      stealFront: (n) => (n === 1 || n === 9 ? "refuse" : undefined),
    });
    const result = await runCheck(phone.deps);
    expect(result.lines.at(-1)).toMatch(/^Result: PASS/);
    expect(result.lines.filter((entry) => / paused /.test(entry))).toHaveLength(2);
  });

  it("repeats a typing step when another app covers the screenshot", async () => {
    const phone = simulatedPhone();
    const call = phone.deps.call;
    let typed = false;
    let covered = 0;
    phone.deps.call = async (tool, args) => {
      if (tool === "computer_type") typed = args.text === "hbbd";
      if (tool === "computer_screenshot" && typed && covered === 0) {
        covered++;
        phone.state.front = "Google Chrome";
      }
      return call(tool, args);
    };
    const result = await runCheck(phone.deps);
    expect(covered).toBe(1);
    expect(
      result.lines.some((entry) =>
        /^NOTE \S+ paused type "hbbd": Google Chrome was in front in the screenshot/.test(entry),
      ),
    ).toBe(true);
    expect(
      result.lines.find((entry) => entry.includes('type "hbbd"') && !entry.startsWith("NOTE")),
    ).toMatch(/^PASS/);
    expect(result.lines.at(-1)).toMatch(/^Result: PASS/);
  });

  it("repeats the key repeat measurement after iPhone Mirroring left the front partway", async () => {
    const phone = simulatedPhone();
    const call = phone.deps.call;
    let repeats = 0;
    phone.deps.call = async (tool, args) => {
      if (tool === "computer_key" && args.repeat === 3 && ++repeats === 1) {
        await call(tool, args);
        phone.state.front = "SpecWithCode";
        throw new Error("iPhone Mirroring stopped being the app in front partway through.");
      }
      return call(tool, args);
    };
    const result = await runCheck(phone.deps);
    expect(repeats).toBe(2);
    expect(result.lines.find((entry) => entry.startsWith("PASS key repeat"))).toBeDefined();
    expect(result.lines.at(-1)).toMatch(/^Result: PASS/);
  });

  it("ends INVALID, never FAIL, when another app takes the front at every try", async () => {
    const phone = simulatedPhone({ stealFront: (n) => (n >= 8 ? "refuse" : undefined) });
    const result = await runCheck(phone.deps);
    expect(result.invalid).toBe(true);
    expect(result.lines.at(-1)).toMatch(
      /^Result: INVALID \(another app took the front: .* 3 times in a row during type "\S+"; keep the Mac's trackpad and keyboard untouched/,
    );
    expect(result.lines.some((entry) => entry.startsWith("FAIL "))).toBe(false);
    expect(result.lines.some((entry) => entry.startsWith("Clicks landed"))).toBe(false);
  });

  it("ends INVALID when another app keeps the front through the pause", async () => {
    const phone = simulatedPhone();
    const call = phone.deps.call;
    let probed = false;
    phone.deps.call = async (tool, args) => {
      if (tool === "computer_type" && args.text === "é") probed = true;
      return call(tool, args);
    };
    phone.deps.frontmost = async () => (probed ? "Google Chrome" : phone.state.front);
    const result = await runCheck(phone.deps);
    expect(result.invalid).toBe(true);
    expect(result.lines.at(-1)).toMatch(
      /another app took the front: Google Chrome kept the front for 60 s during type "hbdt"/,
    );
    expect(result.lines.some((entry) => entry.startsWith("FAIL "))).toBe(false);
  });

  it("never counts a repeated click on the page the interrupted tap already opened", async () => {
    // Click 1 lands on Stopwatch, Chrome covers its screenshot, and the repeated
    // tap on Stopwatch is lost: the click must not pass on the first tap's page.
    for (const how of ["screenshot", "partway"]) {
      const phone = simulatedPhone();
      const call = phone.deps.call;
      let clicks = 0;
      let covered = false;
      let dropped = false;
      phone.deps.call = async (tool, args) => {
        if (tool === "computer_click") clicks++;
        if (tool === "computer_click" && covered && !dropped && args.x === 880) {
          dropped = true;
          return call("computer_screenshot", {});
        }
        if (tool === "computer_click" && clicks === 2 && how === "partway") {
          await call(tool, args);
          covered = true;
          phone.state.front = "Google Chrome";
          throw new Error("iPhone Mirroring stopped being the app in front partway through.");
        }
        if (tool === "computer_screenshot" && clicks === 2 && !covered) {
          covered = true;
          phone.state.front = "Google Chrome";
        }
        return call(tool, args);
      };
      const result = await runCheck(phone.deps);
      expect(dropped).toBe(true);
      expect(result.lines.find((entry) => entry.startsWith("FAIL click 1/20"))).toBeDefined();
      expect(result.lines.some((entry) => entry.startsWith("PASS click 1/20"))).toBe(false);
    }
  });

  it("ends INVALID when another app keeps the front at the last home key", async () => {
    const phone = simulatedPhone();
    let passed = 0;
    phone.deps.onLine = (line) => {
      if (line.startsWith("PASS ")) passed++;
    };
    const read = phone.deps.frontmost;
    phone.deps.frontmost = async () => (passed >= 30 ? "Google Chrome" : read());
    const result = await runCheck(phone.deps);
    expect(passed).toBe(30);
    expect(result.invalid).toBe(true);
    expect(result.lines.some((entry) => entry.startsWith("Clicks landed"))).toBe(false);
    expect(result.lines.at(-1)).toMatch(
      /Google Chrome kept the front for 60 s during the home key/,
    );
  });

  it("ends INVALID when the first reading after Mirroring came back fails", async () => {
    // Chrome takes the front before a counted click, or before the last home key;
    // Mirroring comes back, then the screenshot that starts the repeat fails.
    for (const where of ["click", "home key"]) {
      const phone = simulatedPhone();
      const call = phone.deps.call;
      let passed = 0;
      let clicks = 0;
      let stolen = false;
      let failNext = false;
      phone.deps.onLine = (line) => {
        if (line.startsWith("PASS ")) passed++;
      };
      phone.deps.call = async (tool, args) => {
        if (tool === "computer_click") clicks++;
        if (tool === "computer_open" && stolen) failNext = true;
        if (tool === "computer_screenshot" && failNext) {
          failNext = false;
          throw new Error("the screenshot failed");
        }
        return call(tool, args);
      };
      const read = phone.deps.frontmost;
      phone.deps.frontmost = async () => {
        const due = where === "click" ? clicks === 3 : passed >= 30;
        if (due && !stolen) {
          stolen = true;
          phone.state.front = "Google Chrome";
        }
        return read();
      };
      const result = await runCheck(phone.deps);
      expect(stolen).toBe(true);
      expect(result.invalid).toBe(true);
      expect(result.lines.some((entry) => entry.startsWith("FAIL "))).toBe(false);
      expect(result.lines.some((entry) => entry.startsWith("Clicks landed"))).toBe(false);
      expect(result.lines.at(-1)).toMatch(
        /another app took the front: the first reading after iPhone Mirroring came back during .* failed \(the screenshot failed\)/,
      );
    }
  });

  it("writes a repeated step's earlier results as not counted", async () => {
    // Scroll down is scored, then Chrome takes the front before scrolling up.
    const phone = simulatedPhone();
    const call = phone.deps.call;
    let scrolls = 0;
    phone.deps.call = async (tool, args) => {
      if (tool === "computer_scroll" && ++scrolls === 2) phone.state.front = "Google Chrome";
      return call(tool, args);
    };
    const result = await runCheck(phone.deps);
    expect(result.lines.filter((entry) => entry.startsWith("PASS scroll down"))).toHaveLength(1);
    expect(
      result.lines.some((entry) =>
        entry.startsWith("NOTE not counted, the step was repeated: PASS scroll down"),
      ),
    ).toBe(true);
    expect(result.lines.at(-1)).toMatch(/^Result: PASS \(30\/30 checks\)/);
  });

  it("ends INVALID when bringing iPhone Mirroring back fails", async () => {
    const phone = simulatedPhone({ stealFront: (n) => (n === 8 ? "refuse" : undefined) });
    const call = phone.deps.call;
    let opens = 0;
    phone.deps.call = async (tool, args) => {
      if (tool === "computer_open" && ++opens > 1) throw new Error("the call timed out");
      return call(tool, args);
    };
    const result = await runCheck(phone.deps);
    expect(result.invalid).toBe(true);
    expect(result.lines.at(-1)).toMatch(
      /another app took the front: bringing iPhone Mirroring back during type "\S+" failed \(the call timed out\)/,
    );
    expect(result.lines.some((entry) => entry.startsWith("FAIL "))).toBe(false);
  });

  it("opens Spotlight again when the phone shows only its home screen after typing", async () => {
    // cmd+3 number 5 opens Spotlight for "x@y#h" (1 is the path probe).
    const phone = simulatedPhone({ spotlightMisses: (n) => n === 5 });
    const result = await runCheck(phone.deps);
    expect(result.lines.at(-1)).toMatch(/^Result: PASS/);
    const note = result.lines.find((entry) => /^NOTE .* type "x@y#h": after typing/.test(entry));
    expect(note).toMatch(/only its home screen, no search field \(try 1 of 3\)/);
    expect(note).toMatch(/after cmd\+3, it showed nothing beyond the home screen/);
    expect(result.lines).toContain(
      'PASS type "x@y#h": shown on the phone; frontmost iPhone Mirroring',
    );
  });

  it("fails a field with a wrong first key, and a later try never hides it", async () => {
    const phone = simulatedPhone();
    const call = phone.deps.call;
    let wrong = 0;
    phone.deps.call = (tool, args) => {
      if (tool === "computer_type" && args.text === "hbdt" && wrong++ === 0) {
        return call(tool, { text: "gbdt" });
      }
      return call(tool, args);
    };
    const result = await runCheck(phone.deps);
    expect(result.lines).toContainEqual(
      expect.stringMatching(/^FAIL type "hbdt": not shown as typed/),
    );
    expect(result.lines.some((entry) => /no search field/.test(entry))).toBe(false);
    expect(wrong).toBe(1);
  });

  it("repeats on the home screen even when it shows a label the first reading missed", async () => {
    const phone = simulatedPhone({ spotlightMisses: (n) => n === 5 });
    const ocr = phone.deps.ocr;
    let typed = false;
    const call = phone.deps.call;
    phone.deps.call = (tool, args) => {
      if (tool === "computer_type") typed = args.text === "x@y#h";
      return call(tool, args);
    };
    phone.deps.ocr = async (...args) => {
      const read = await ocr(...args);
      return typed && phone.state.app === "home"
        ? [...read, { text: "Flood Watch", x: 640, y: 380, width: 120, height: 20 }]
        : read;
    };
    const result = await runCheck(phone.deps);
    expect(result.lines).toContainEqual(
      expect.stringMatching(/^NOTE .* type "x@y#h": after typing .*\(try 1 of 3\)/),
    );
    expect(result.lines.at(-1)).toMatch(/^Result: PASS/);
  });

  it("calls typing unsure, never failed, when Spotlight never shows on any try", async () => {
    const phone = simulatedPhone({ spotlightMisses: (n) => n >= 5 && n <= 7 });
    const result = await runCheck(phone.deps);
    expect(result.lines).toContainEqual(
      expect.stringMatching(
        /^UNSURE type "x@y#h": the phone showed no Spotlight after typing on 3 tries/,
      ),
    );
    expect(result.lines.some((entry) => entry.startsWith("FAIL "))).toBe(false);
    expect(result.lines.at(-1)).toMatch(/^Result: INVALID \(could not judge type "x@y#h"/);
  });

  it("opens Spotlight again for the key repeat measurement", async () => {
    const phone = simulatedPhone({ spotlightMisses: (n) => n === 7 });
    const result = await runCheck(phone.deps);
    expect(result.lines.at(-1)).toMatch(/^Result: PASS/);
    expect(result.lines).toContainEqual(
      expect.stringMatching(/^NOTE .* key repeat: after typing "QHBR4207"/),
    );
  });

  it("still fails text a shown search field reads wrong", async () => {
    const phone = simulatedPhone();
    const call = phone.deps.call;
    phone.deps.call = (tool, args) =>
      call(tool, tool === "computer_type" && args.text === "x@y#h" ? { text: "x@y" } : args);
    const result = await runCheck(phone.deps);
    expect(result.lines).toContainEqual(
      expect.stringMatching(/^FAIL type "x@y#h": not shown as typed/),
    );
    expect(result.lines.some((entry) => /no search field/.test(entry))).toBe(false);
  });

  it("taps the app's result when Return leaves Spotlight up, outside the counted clicks", async () => {
    const phone = simulatedPhone({ deadReturn: true, suggestion: true });
    const result = await runCheck(phone.deps);
    expect(result.lines.at(-1)).toMatch(/^Result: PASS/);
    expect(result.lines).toContain("Clicks landed: 20 of 20");
    expect(result.lines).toContainEqual(
      expect.stringMatching(
        /^NOTE .* Return did not open Clock while "Clock- Ask Siri" showed; tapped the "Clock" result at \(\d+, 270\): Spotlight closed \(not one of the 20 counted clicks\)/,
      ),
    );
    // The scroll step opens Settings the same way.
    expect(result.lines).toContainEqual(
      expect.stringMatching(/^NOTE .* tapped the "Settings" result .*: Spotlight closed/),
    );
    expect(phone.state.taps).toBe(2);
  });

  it("never taps another source's result when the app's own caption was missed", async () => {
    const phone = simulatedPhone({ deadReturn: true, suggestion: true });
    const ocr = phone.deps.ocr;
    phone.deps.ocr = async (...args) => {
      const read = await ocr(...args);
      if (phone.state.app !== "spotlight" || phone.state.query !== "Clock") return read;
      // window-11.png without the app's caption: a "Google" heading over Google's "Clock".
      const [field] = read;
      const at = (text, y) => ({ text, x: 640, y, width: 120, height: 20 });
      return [field, at("Set Timer", 260), at("Google", 300), at("Clock", 340)];
    };
    const result = await runCheck(phone.deps);
    expect(result.lines).toContainEqual(
      expect.stringMatching(
        /^NOTE .* Return did not open Clock .*the first "Clock" under the field is not in the first row of results/,
      ),
    );
    expect(phone.state.taps ?? 0).toBe(0);
  });

  it("waits for Spotlight's suggestion before pressing Return", async () => {
    const phone = simulatedPhone({ suggestion: true });
    const order = [];
    const call = phone.deps.call;
    phone.deps.call = (tool, args) => {
      if (tool === "computer_type" && args.text === "Clock") order.length = 0;
      if (tool === "computer_screenshot" || (tool === "computer_key" && args.keys === "return"))
        order.push(tool === "computer_key" ? "return" : "look");
      return call(tool, args);
    };
    const result = await runCheck(phone.deps);
    expect(result.lines.at(-1)).toMatch(/^Result: PASS/);
    expect(order.slice(0, 2)).toEqual(["look", "return"]);
    expect(phone.state.taps).toBeUndefined();
  });

  it("writes dry-run.log and never check.log", async () => {
    const out = tempOut();
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await main(["--dry-run", "--out", out])).toBe(0);
    expect(NodeFS.existsSync(NodePath.join(out, "check.log"))).toBe(false);
    const log = NodeFS.readFileSync(NodePath.join(out, "dry-run.log"), "utf8");
    expect(log).toContain("Mode: dry run, simulated phone");
    expect(log).toContain("Clicks landed: 20 of 20");
    expect(await main(["--dry-run", "--out", out, "--miss", "3"])).toBe(1);
    expect(NodeFS.readFileSync(NodePath.join(out, "dry-run.log"), "utf8")).toContain(
      "Clicks landed: 19 of 20",
    );
  });
});

describe("options", () => {
  it("needs --out for a live run and keeps --miss to dry runs", () => {
    expect(() => parseArgs([])).toThrow(/--out/);
    expect(() => parseArgs(["--out", "x"])).toThrow(/--ios <version> is required/);
    expect(() => parseArgs(["--out", "x", "--ios", "26.1", "--miss", "2"])).toThrow(/dry-run/);
    expect(() => parseArgs(["--dry-run", "--tabs", "One"])).toThrow(/two tab names/);
    expect(() => parseArgs(["--bogus"])).toThrow(/unknown option/);
    expect(() => parseArgs(["--dry-run", "--anchors", "one"])).toThrow(/two word lists/);
    expect(parseArgs(["--dry-run", "--anchors", "World Clock; lap,Start"]).anchors).toEqual([
      ["world clock"],
      ["lap", "start"],
    ]);
    expect(parseArgs(["--out", "x", "--ios", "26.1"])).toMatchObject({ out: "x", ios: "26.1" });
    expect(() => parseArgs(["--out", "x", "--ios", " "])).toThrow(/needs the iOS version/);
  });

  it("refuses a live run outside a thread's shell", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const code = await main(["--out", tempOut(), "--ios", "26.1"], {});
    expect(code).toBe(2);
  });
});

describe("judging the screen", () => {
  it("finds anchor words as whole words only", () => {
    expect(anchorIn(["lap", "start"], ["lap"])).toBe("lap");
    expect(anchorIn(["laptop stand"], ["lap"])).toBeUndefined();
    expect(anchorIn(["world clock"], ["world clock"])).toBe("world clock");
    expect(tabAnchors({ tabs: ["Alarms", "Stopwatch"] })).toEqual({
      Alarms: ["alarms"],
      Stopwatch: ["lap", "reset"],
    });
  });

  it("finds the two tabs where they line up as a tab bar, not a page title", () => {
    const bottom = [
      line("World Clock", 620, 150),
      line("World Clock", 640, 820),
      line("Stopwatch", 840, 820),
      line("Alarms", 740, 820),
    ];
    const found = locateTabs(bottom, ["World Clock", "Stopwatch"]);
    expect(found.tabs["World Clock"]).toEqual(bottom[1]);
    expect(found.bar).toMatchObject({ axis: "row", at: 830 });
    // A wider layout: the tabs in a row on top, the page title below them.
    const top = [
      line("World Clock", 640, 140),
      line("Stopwatch", 840, 140),
      line("World Clock", 620, 200),
    ];
    expect(locateTabs(top, ["World Clock", "Stopwatch"]).tabs["World Clock"]).toEqual(top[0]);
    // A sidebar: one above the other, left-aligned.
    const side = [
      line("World Clock", 610, 300),
      line("Stopwatch", 610, 380),
      line("Lap", 800, 300),
    ];
    const column = locateTabs(side, ["World Clock", "Stopwatch"]);
    expect(column.bar.axis).toBe("column");
    expect(pageSignature(side, window, column.bar)).toEqual(["lap"]);
    // A title alone, with the other tab nowhere in line with it.
    expect(
      locateTabs(
        [line("World Clock", 620, 150), line("Stopwatch", 900, 820)],
        ["World Clock", "Stopwatch"],
      ),
    ).toBeUndefined();
    expect(locateTabs(bottom, ["World Clock", "Timers"])).toBeUndefined();
  });

  it("needs a third Clock tab in the bar, so a title and one tab never pass for a bar", () => {
    const clock = ["World Clock", "Alarms", "Stopwatch", "Timers"];
    const pair = ["World Clock", "Stopwatch"];
    // The bottom Stopwatch label missed once; the Stopwatch page title is left-aligned above.
    const missed = [
      line("Stopwatch", 620, 150, 80),
      line("World Clock", 640, 820, 90),
      line("Alarms", 740, 820, 60),
      line("Timers", 900, 820, 50),
    ];
    expect(locateTabs(missed, pair, clock)).toBeUndefined();
    // A sidebar with a World Clock title in line with the Stopwatch label.
    const side = [
      line("World Clock", 610, 300),
      line("Alarms", 610, 340),
      line("Stopwatch", 610, 380),
      line("Timers", 610, 420),
      line("World Clock", 800, 380),
    ];
    const found = locateTabs(side, pair, clock);
    expect(found.bar.axis).toBe("column");
    expect(found.tabs["World Clock"]).toEqual(side[0]);
    // A World Clock title above a sidebar, in line with it: the tab is the one among the others,
    // and the title stays page text.
    const titled = [line("World Clock", 610, 150), ...side.slice(0, 4)];
    const sidebar = locateTabs(titled, pair, clock);
    expect(sidebar.tabs["World Clock"]).toEqual(titled[1]);
    expect(pageSignature(titled, window, sidebar.bar)).toEqual(["world clock"]);
    // The World Clock tab missed once: the title far above the others is not taken for it.
    expect(locateTabs([titled[0], ...titled.slice(2)], pair, clock)).toBeUndefined();
    // The full bottom bar.
    const bottom = [...missed.slice(1), line("Stopwatch", 840, 820, 80)];
    expect(locateTabs(bottom, pair, clock).bar).toMatchObject({ axis: "row", at: 830 });
  });

  it("reads Clock once more when the first reading misses a tab label", async () => {
    const phone = simulatedPhone();
    let clockReads = 0;
    const deps = {
      ...phone.deps,
      ocr: async (...args) => {
        const read = await phone.deps.ocr(...args);
        if (phone.state.app !== "Clock" || clockReads++ > 0) return read;
        // The first Clock reading misses the Stopwatch tab and shows a Stopwatch title.
        return [
          ...read.filter((entry) => entry.text !== "Stopwatch"),
          line("Stopwatch", 620, 150, 80),
        ];
      },
    };
    const result = await runCheck(deps);
    expect(result.lines.find((entry) => entry.startsWith("PASS tabs"))).toMatch(/in a row/);
    expect(result.pass).toBe(true);
  });

  it("leaves a tab bar on top out of every page's words", () => {
    const lines = [
      line("World Clock", 640, 140),
      line("Stopwatch", 840, 140),
      line("Lap", 620, 400),
    ];
    const { bar } = locateTabs(lines, ["World Clock", "Stopwatch"]);
    expect(pageSignature(lines, window, bar)).toEqual(["lap"]);
    expect(anchorIn(pageSignature(lines, window, bar), ["world clock"])).toBeUndefined();
  });

  it("reads typed text only at the start of the field, tolerating what no key types", () => {
    expect(startsWithTyped("hbdt- Ask Siri", "hbdt")).toBe(true);
    expect(startsWithTyped("hbdt|", "hbdt")).toBe(true);
    expect(startsWithTyped("hbdt", "hbdt")).toBe(true);
    // Leftovers before the text, or more typed text after it, do not count.
    expect(startsWithTyped("zQ4207- Ask Siri", "4207")).toBe(false);
    expect(startsWithTyped("42075", "4207")).toBe(false);
    // Case only where the shapes are the same; accents and Cyrillic lookalikes are reading noise.
    expect(startsWithTyped("X@y#Z", "x@y#z")).toBe(true);
    expect(startsWithTyped("x@Y#z", "x@y#z")).toBe(false);
    expect(startsWithTyped("QНBR", "QHBR")).toBe(true);
    expect(startsWithTyped("hbdť", "hbdt")).toBe(true);
    // A neighbouring key never passes: q read as "ą" stays an a.
    expect(startsWithTyped("ząxv", "zqxv")).toBe(false);
    expect(startsWithTyped("x@y3z", "x@y#z")).toBe(false);
    expect(typedTail("QHBR4207- Ask Siri", "QHBR", true)).toBe(4);
    expect(typedTail("QHBR42", "QHBR", true)).toBe(2);
    expect(typedTail("zQHBR42", "QHBR", true)).toBeUndefined();
    expect(showsSuggestion("QHBR4207- Ask Siri", "QHBR")).toBe(true);
    expect(showsSuggestion("QHBR4207", "QHBR")).toBe(false);
    expect(showsSuggestion("QHBR4207|", "QHBR")).toBe(false);
    // A stray key after the text is not taken for the cursor or a suggestion.
    expect(startsWithTyped("hbdtl", "hbdt")).toBe(false);
    expect(startsWithTyped("hbdt.", "hbdt")).toBe(false);
    expect(startsWithTyped("hbdt/a", "hbdt")).toBe(false);
    expect(startsWithTyped("hbdt-incorrect", "hbdt")).toBe(false);
    expect(startsWithTyped("hbdt- wrong", "hbdt")).toBe(false);
    expect(startsWithTyped("hb dt", "hbdt")).toBe(false);
    expect(startsWithTyped("hbdt - Ask Siri", "hbdt")).toBe(true);
    // Spaces typed around the text, or a suffix that is not a known suggestion, never pass.
    expect(startsWithTyped("hbdt ", "hbdt")).toBe(false);
    expect(startsWithTyped(" hbdt", "hbdt")).toBe(false);
    expect(startsWithTyped("hbdt- incorrect", "hbdt")).toBe(false);
    expect(startsWithTyped("hbdt- Incorrect", "hbdt")).toBe(false);
    // The other suggestions Spotlight showed in live runs.
    expect(startsWithTyped("hbdt - HDToday", "hbdt")).toBe(true);
    expect(startsWithTyped("4207 - Open", "4207")).toBe(true);
    expect(startsWithTyped("hbdt - Search Web", "hbdt")).toBe(false);
    expect(startsWithTyped("hbdt - A", "hbdt")).toBe(false);
  });

  it("types samples that text recognition reads in one way only", () => {
    for (const sample of TYPE_SAMPLES) {
      const letters = sample.includes("@") ? "" : sample.replace(/[^A-Za-z]/g, "");
      expect(letters).not.toMatch(/[cosvwxzqCOSVWXZ]/);
      expect(sample).not.toMatch(/[!il1|]/);
      // Letters and digits text recognition swaps (z/2, s/5, o/0) never share a sample.
      expect(sample).not.toMatch(/[zZsSoO]/);
      if (/[A-Za-z]/.test(sample)) expect(sample).not.toMatch(/[250]/);
    }
    expect(TYPE_SAMPLES.some((sample) => /(.)\1/.test(sample))).toBe(true);
  });

  it("tells the home screen from Spotlight over it, never a field with the wrong text", () => {
    const at = (text, y = 500) => ({ text, x: 1200, y, width: 80, height: 14 });
    const home = [
      at("Sunny Isles B...", 313),
      at("77°", 332),
      at("11:26", 330),
      at("Messages"),
      at("Settings"),
      at("o"),
    ];
    // The run of November 19 at 11:26 AM: the same home screen a few seconds later.
    const later = [home[0], home[1], at("11:27", 330), at("Messages"), at("Settings"), at("o")];
    expect(showsNoSpotlight(later, home)).toBe(true);
    // New text keeps it from the home screen unless going home again still shows it.
    const missed = [...later, at("Flood Watch", 384)];
    expect(showsNoSpotlight(missed, home)).toBe(false);
    expect(showsNoSpotlight(missed, home, missed)).toBe(true);
    // A field with any wrong text is gone after going home: it is judged.
    for (const field of ["gbdt", "420", "x@", "4", "9207", "Clock - Open"]) {
      expect(showsNoSpotlight([...later, at(field, 307)], home, later)).toBe(false);
    }
    expect(newTexts([at("x@y", 307), at("Messages"), at("11:40")], home)).toEqual(["x@y"]);
    // Another screen, or nothing to compare, is never called the home screen.
    expect(showsNoSpotlight([at("Search")], home)).toBe(false);
    expect(showsNoSpotlight([], home)).toBe(false);
    expect(showsNoSpotlight(home, [])).toBe(false);
  });

  it("tells pages apart by their words, leaving clock readings out", () => {
    const page = pageSignature(
      [
        line("World Clock", 620, 150),
        line("10:42", 620, 200),
        line("Edit", 620, 120),
        line("Alarms", 700, 820),
      ],
      window,
    );
    expect(page).toEqual(["world clock", "edit"]);
    expect(jaccard(["a", "b"], ["a", "b"])).toBe(1);
    expect(jaccard(["a", "b"], ["c"])).toBe(0);
    expect(jaccard([], [])).toBe(1);
  });

  it("counts a scroll by how far shared text moved", () => {
    const before = ["General", "Camera", "Siri", "Search"].map((text, index) =>
      line(text, 620, 300 + index * 50),
    );
    const after = before.map((entry) => ({ ...entry, y: entry.y - 80 }));
    expect(scrolled(before, after, window, "down", 20)).toMatchObject({
      ok: true,
      median: -80,
      common: 4,
    });
    expect(scrolled(before, after, window, "up", 20).ok).toBe(false);
    expect(scrolled(before, before, window, "down", 20).ok).toBe(false);
  });

  it("maps the window into screenshot pixels and spots one off the main display", () => {
    const main = { width: 3024, height: 1964 };
    const size = { width: 1512, height: 982 };
    expect(windowInScreenshot({ x: 1200, y: 200, width: 720, height: 1520 }, main, size)).toEqual({
      onMainDisplay: true,
      window: { x: 600, y: 100, width: 360, height: 760 },
    });
    expect(
      windowInScreenshot({ x: 3100, y: 0, width: 720, height: 1520 }, main, size)?.onMainDisplay,
    ).toBe(false);
    expect(windowInScreenshot(null, main, size)).toBeUndefined();
  });

  it("turns text boxes from the bottom-left of a region into screenshot pixels", () => {
    const region = { x: 600, y: 100, width: 400, height: 800 };
    expect(
      regionToScreenshot([{ text: "Lap", x: 0.25, y: 0.5, width: 0.1, height: 0.05 }], region),
    ).toEqual([{ text: "Lap", x: 700, y: 460, width: 40, height: 40 }]);
  });
});

describe("mcpClient", () => {
  it("calls tools with the thread's authorization and reads text, structured data and images", async () => {
    const seen = [];
    const fetchImpl = async (url, init) => {
      const body = JSON.parse(init.body);
      seen.push({
        url,
        method: body.method,
        authorization: init.headers.authorization,
        session: init.headers["mcp-session-id"],
      });
      const headers = new Headers({ "content-type": "application/json", "mcp-session-id": "s1" });
      const result =
        body.method === "initialize"
          ? { serverInfo: { name: "x", version: "1.2.3" } }
          : body.params?.name === "computer_screenshot"
            ? {
                content: [
                  { type: "text", text: '{"display":{"width":10,"height":5}}' },
                  { type: "image", data: "aW1n", mimeType: "image/jpeg" },
                ],
              }
            : { isError: true, content: [{ type: "text", text: "Computer use is turned off" }] };
      return new Response(
        body.id === undefined ? "" : JSON.stringify({ jsonrpc: "2.0", id: body.id, result }),
        {
          status: body.id === undefined ? 202 : 200,
          headers,
        },
      );
    };
    const client = mcpClient({
      url: "http://127.0.0.1:1/mcp",
      authorization: "Bearer t",
      fetchImpl,
    });
    expect(await client.initialize()).toEqual({ name: "x", version: "1.2.3" });
    expect(await client.call("computer_screenshot", {})).toEqual({
      data: { display: { width: 10, height: 5 } },
      image: "aW1n",
    });
    await expect(client.call("computer_click", { x: 1, y: 1 })).rejects.toThrow(/turned off/);
    expect(seen.every((entry) => entry.authorization === "Bearer t")).toBe(true);
    expect(seen.slice(1).every((entry) => entry.session === "s1")).toBe(true);
  });
});
