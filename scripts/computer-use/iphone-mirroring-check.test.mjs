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
        /^PASS key repeat: .*one backspace removed 0, backspace repeat 3 removed 2, 2 more, so every press arrived; inline suggestion before each: yes, yes/,
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
          ? /^FAIL key repeat: .*one backspace removed 0, backspace repeat 3 removed 1/
          : /^FAIL key repeat: .*one backspace removed 1, backspace repeat 3 removed 2/,
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
      /^FAIL key repeat: .*one backspace removed 0, backspace repeat 3 removed 2; inline suggestion before each: no, no/,
    );
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

  it("reopens iPhone Mirroring once when the gate says the app in front changed", async () => {
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
    expect(result.lines.some((entry) => entry.startsWith("NOTE computer_type refused"))).toBe(true);
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
    // A stray key after the text is not taken for the cursor.
    expect(startsWithTyped("hbdtl", "hbdt")).toBe(false);
  });

  it("types samples that text recognition reads in one way only", () => {
    for (const sample of TYPE_SAMPLES) {
      const letters = sample.includes("@") ? "" : sample.replace(/[^A-Za-z]/g, "");
      expect(letters).not.toMatch(/[cosvwxzqCOSVWXZ]/);
      expect(sample).not.toMatch(/[!il1|]/);
    }
    expect(TYPE_SAMPLES.some((sample) => /(.)\1/.test(sample))).toBe(true);
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
