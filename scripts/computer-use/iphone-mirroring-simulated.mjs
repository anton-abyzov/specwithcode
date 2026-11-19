// A simulated phone for --dry-run and the tests of iphone-mirroring-check.mjs.

import { MIRRORING_APP, PATH_REFUSAL } from "./iphone-mirroring-check.mjs";

/**
 * A phone behind a Mirroring window that answers the tools the way the real one
 * should. suggestion: Spotlight shows an inline suggestion after new text, which
 * the next key call's first press removes. dropRepeat: a key repeat of N reaches
 * the phone as N - 1 presses. keepsQuery: Spotlight reopens with its last text.
 * tabsOnTop: Clock shows its tabs in a row at the top, under the status bar.
 * spotlightMisses: called with the number of each cmd+3; true leaves the phone
 * on the home screen. deadReturn: Return in Spotlight opens nothing; the app's
 * result under the field still opens it when tapped.
 */
export function simulatedPhone({
  missClick,
  pages: pageOverride,
  deadClicks = false,
  load = 3,
  mirroringPath = true,
  suggestion = false,
  dropRepeat = false,
  keepsQuery = false,
  tabsOnTop = false,
  spotlightMisses,
  deadReturn = false,
  // Called with the number of each input call: "refuse" puts SpecWithCode in
  // front first (the product refuses, nothing sent); "partway" sends it, then
  // reports that iPhone Mirroring left the front.
  stealFront,
} = {}) {
  const window = { x: 600, y: 100, width: 360, height: 760 };
  const display = { width: 1512, height: 982 };
  const tabY = tabsOnTop ? 140 : 820;
  const tabs = {
    "World Clock": { x: 640, y: tabY, width: 90, height: 20 },
    Alarms: { x: 740, y: tabY, width: 60, height: 20 },
    Stopwatch: { x: 840, y: tabY, width: 80, height: 20 },
    Timers: { x: 900, y: tabY, width: 50, height: 20 },
  };
  const pages = pageOverride ?? {
    "World Clock": ["World Clock", "Edit", "Cupertino", "Today, +0HRS", "10:42"],
    Stopwatch: ["00:00,00", "Lap", "Start"],
  };
  const rows = [
    "General",
    "Accessibility",
    "Action Button",
    "Camera",
    "Control Center",
    "Display & Brightness",
    "Home Screen & App Library",
    "Search",
    "Siri",
    "StandBy",
    "Wallpaper",
    "Notifications",
    "Sounds & Haptics",
    "Focus",
    "Screen Time",
  ];
  const state = {
    front: "SpecWithCode",
    app: "home",
    query: "",
    // An inline suggestion shows after the text in the search field.
    inline: false,
    tab: "Stopwatch",
    scroll: 0,
    clicks: 0,
    calls: [],
  };
  const line = (text, x, y, width = 120, height = 20) => ({ text, x, y, width, height });

  const ocr = () => {
    if (state.app === "home") return [line("Clock", 640, 300), line("Settings", 760, 300)];
    if (state.app === "spotlight") {
      if (state.query === "") return [line("Search", 640, 160)];
      const field = line(`${state.query}${state.inline ? "- Ask Siri" : ""}`, 640, 160);
      // An app's name shows its result under the field.
      return APPS.includes(state.query) ? [field, line(state.query, 640, 260)] : [field];
    }
    if (state.app === "Clock") {
      const top = tabsOnTop ? 200 : 150;
      return [
        ...pages[state.tab].map((text, index) => line(text, 620, top + index * 60)),
        ...Object.entries(tabs).map(([text, box]) =>
          line(text, box.x, box.y, box.width, box.height),
        ),
      ];
    }
    if (state.app === "Settings") {
      return rows
        .map((text, index) => line(text, 620, 200 + index * 50 - state.scroll))
        .filter((entry) => entry.y > window.y && entry.y < window.y + window.height - 20);
    }
    return [];
  };

  const APPS = ["Clock", "Settings"];
  let inputs = 0;
  let spotlights = 0;
  const call = async (tool, args) => {
    state.calls.push(tool);
    if (
      tool !== "computer_open" &&
      tool.startsWith("computer_") &&
      tool !== "computer_screenshot"
    ) {
      const steal = stealFront?.(++inputs);
      if (steal === "refuse") state.front = "SpecWithCode";
      if (state.front !== MIRRORING_APP) {
        throw new Error(
          "Agents cannot click or type in SpecWithCode itself, so they cannot answer their own access requests.",
        );
      }
      if (steal === "partway") {
        await act(tool, args);
        state.front = "SpecWithCode";
        throw new Error(
          "iPhone Mirroring stopped being the app in front partway through, so the rest was not sent.",
        );
      }
    }
    return act(tool, args);
  };
  const act = async (tool, args) => {
    const done = (data = {}) => ({ data: { display, frontmostApplication: state.front, ...data } });
    switch (tool) {
      case "request_access":
        return { data: { status: "allowed", allowed: [MIRRORING_APP] } };
      case "computer_open":
        state.front = MIRRORING_APP;
        return done();
      case "computer_screenshot":
        return { ...done(), image: "simulated" };
      case "computer_key": {
        if (args.keys === "cmd+1") state.app = "home";
        else if (args.keys === "cmd+3") {
          if (spotlightMisses?.(++spotlights)) return done();
          state.app = "spotlight";
          if (!keepsQuery) state.query = "";
          state.inline = false;
        } else if (args.keys === "backspace") {
          let presses = args.repeat ?? 1;
          if (dropRepeat && presses > 1) presses--;
          if (state.inline && presses > 0) {
            state.inline = false;
            presses--;
          }
          if (presses > 0)
            state.query = state.query.slice(0, Math.max(0, state.query.length - presses));
        } else if (args.keys === "return" && state.app === "spotlight" && !deadReturn) {
          state.app = state.query;
          state.scroll = 0;
        }
        return done();
      }
      case "computer_type":
        // The iPhone Mirroring path refuses what a US keyboard cannot type; an older app pastes it.
        if (mirroringPath && /[^\x20-\x7e\n\t]/.test(args.text)) {
          throw new Error(
            `iPhone Mirroring ${PATH_REFUSAL} to the phone, so "${args.text}" cannot be typed there and nothing was typed.`,
          );
        }
        if (state.app === "spotlight") {
          state.query += args.text;
          state.inline = suggestion;
        }
        return done();
      case "computer_click": {
        if (state.app === "spotlight") {
          // A tap on the app's result opens it.
          if (APPS.includes(state.query) && args.y >= 260 && args.y < 280) {
            state.app = state.query;
            state.scroll = 0;
          }
          state.taps = (state.taps ?? 0) + 1;
          return done();
        }
        state.clicks++;
        // The first click is the uncounted setup tap.
        const counted = state.clicks - 1;
        const hit = Object.entries(tabs).find(
          ([, box]) =>
            args.x >= box.x &&
            args.x < box.x + box.width &&
            args.y >= box.y &&
            args.y < box.y + box.height,
        );
        if (state.app === "Clock" && hit !== undefined && counted !== missClick && !deadClicks) {
          state.tab = hit[0];
        }
        return done();
      }
      case "computer_scroll":
        if (state.app === "Settings") {
          state.scroll = Math.max(
            0,
            state.scroll + (args.direction === "down" ? 1 : -1) * args.amount * 20,
          );
        }
        return done();
      case "computer_drag":
        return done();
      default:
        throw new Error(`the simulated phone has no ${tool}`);
    }
  };

  return {
    state,
    deps: {
      call,
      window: async () => ({ window, onMainDisplay: true }),
      ocr: async () => ocr(),
      frontmost: async () => state.front,
      loadavg: () => load,
      desktopApps: async () => [{ version: "simulated", path: "simulated" }],
      sleep: async () => {},
    },
  };
}
