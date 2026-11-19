// The live half of iphone-mirroring-check.mjs: the MCP client that speaks to
// this machine's SpecWithCode service as the thread, and the reads the check
// makes on the Mac itself (window bounds, text recognition, the app in front).
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { findIconColumn } from "./iphone-mirroring-icons.mjs";

const MIRRORING_BUNDLE_ID = "com.apple.ScreenContinuity";

const MCP_PROTOCOL_VERSION = "2025-06-18";

/** An MCP client that calls the service as the thread whose shell runs this script. */
export function mcpClient({ url, authorization, fetchImpl = fetch }) {
  let sessionId = null;
  let id = 0;
  const post = async (body) => {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization,
        "mcp-protocol-version": MCP_PROTOCOL_VERSION,
        ...(sessionId === null ? {} : { "mcp-session-id": sessionId }),
      },
      body: JSON.stringify(body),
    });
    sessionId = response.headers.get("mcp-session-id") ?? sessionId;
    const text = await response.text();
    if (body.id === undefined) return undefined;
    if (!response.ok) throw new Error(`MCP ${body.method} answered HTTP ${response.status}`);
    const type = response.headers.get("content-type") ?? "";
    const payload = type.includes("text/event-stream")
      ? text
          .split("\n")
          .filter((row) => row.startsWith("data:"))
          .map((row) => row.slice(5).trim())
          .filter((row) => row.startsWith("{"))
          .map((row) => JSON.parse(row))
          .find((message) => message.id === body.id)
      : JSON.parse(text);
    if (payload?.error) throw new Error(payload.error.message ?? `MCP ${body.method} failed`);
    return payload?.result;
  };
  return {
    async initialize() {
      const result = await post({
        jsonrpc: "2.0",
        id: ++id,
        method: "initialize",
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "iphone-mirroring-check", version: "1" },
        },
      });
      await post({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
      return result?.serverInfo;
    },
    async call(name, args) {
      const result = await post({
        jsonrpc: "2.0",
        id: ++id,
        method: "tools/call",
        params: { name, arguments: args },
      });
      const content = result?.content ?? [];
      const text = content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      if (result?.isError) throw new Error(text || `${name} failed`);
      let data = result?.structuredContent;
      if (data === undefined) {
        try {
          data = JSON.parse(text);
        } catch {
          data = {};
        }
      }
      const image = content.find((part) => part.type === "image")?.data;
      return { data, image };
    },
  };
}

export const run = (file, args, input, timeout = 20_000) =>
  NodeChildProcess.execFileSync(file, args, { encoding: "utf8", timeout, input }).trim();
/** Text recognition's first call after a restart took 66 s on an M4; later ones take under a second. */
const OCR_FIRST_TIMEOUT_MS = 180_000;
const OCR_TIMEOUT_MS = 60_000;

const WINDOW_SCRIPT = `
ObjC.import("CoreGraphics");
ObjC.import("AppKit");
function run(argv) {
  var apps = $.NSRunningApplication.runningApplicationsWithBundleIdentifier(argv[0]);
  var pids = {};
  for (var a = 0; a < apps.count; a++) pids[String(apps.objectAtIndex(a).processIdentifier)] = true;
  var list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0))) || [];
  var screens = [];
  for (var s = 0; s < $.NSScreen.screens.count; s++) {
    var size = $.NSScreen.screens.objectAtIndex(s).frame.size;
    screens.push({ width: Number(size.width), height: Number(size.height) });
  }
  var found = null;
  var before = [];
  for (var i = 0; i < list.length && found === null; i++) {
    var w = list[i];
    var b = w.kCGWindowBounds || {};
    if (pids[String(w.kCGWindowOwnerPID)] === true && Number(w.kCGWindowLayer) === 0 && Number(b.Width) > 100) {
      found = { x: Number(b.X), y: Number(b.Y), width: Number(b.Width), height: Number(b.Height) };
    } else {
      before.push(w);
    }
  }
  // Windows in front of the Mirroring window that overlap it and would take a
  // click there, skipped as the app's own click target does: Window Server
  // windows other than the menu bar, and the see-through Dock window that
  // spans a whole display.
  var overlays = [];
  for (var j = 0; found !== null && j < before.length; j++) {
    var o = before[j];
    var ob = o.kCGWindowBounds || {};
    var owner = String(o.kCGWindowOwnerName || "");
    var layer = Number(o.kCGWindowLayer);
    if (!(Number(o.kCGWindowAlpha) > 0) || pids[String(o.kCGWindowOwnerPID)] === true) continue;
    if (owner === "Window Server" && layer !== 24 && layer !== 25) continue;
    var wide = false;
    for (var k = 0; k < screens.length; k++) {
      if (Number(ob.Width) === screens[k].width && Number(ob.Height) === screens[k].height) wide = true;
    }
    if (owner === "Dock" && layer !== 0 && wide) continue;
    var x = Number(ob.X), y = Number(ob.Y), width = Number(ob.Width), height = Number(ob.Height);
    if (x >= found.x + found.width || x + width <= found.x || y >= found.y + found.height || y + height <= found.y) continue;
    overlays.push({ app: owner, name: String(o.kCGWindowName || ""), layer: layer, x: x, y: y, width: width, height: height });
  }
  var main = $.NSScreen.screens.objectAtIndex(0).frame.size;
  return JSON.stringify({ window: found, overlays: overlays, main: { width: Number(main.width), height: Number(main.height) } });
}`;

const OCR_SCRIPT = `
ObjC.import("Foundation");
ObjC.import("Vision");
function run(argv) {
  var handler = $.VNImageRequestHandler.alloc.initWithURLOptions($.NSURL.fileURLWithPath(argv[0]), $({}));
  var request = $.VNRecognizeTextRequest.alloc.init;
  request.recognitionLevel = 0;
  request.usesLanguageCorrection = false;
  request.recognitionLanguages = $(["en-US"]);
  if (!handler.performRequestsError($([request]), $())) return JSON.stringify({ lines: [] });
  var results = request.results;
  var lines = [];
  for (var i = 0; i < results.count; i++) {
    var top = results.objectAtIndex(i).topCandidates(1);
    if (top.count === 0) continue;
    var box = results.objectAtIndex(i).boundingBox;
    lines.push({ text: top.objectAtIndex(0).string.js, x: Number(box.origin.x), y: Number(box.origin.y), width: Number(box.size.width), height: Number(box.size.height) });
  }
  return JSON.stringify({ lines: lines });
}`;

const FRONTMOST_SCRIPT = `
ObjC.import("AppKit");
function run() {
  var front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  return front.isNil() ? "" : front.localizedName.js;
}`;
const DESKTOP_APPS_SCRIPT = `
ObjC.import("AppKit");
function run() {
  var apps = $.NSWorkspace.sharedWorkspace.runningApplications;
  var found = [];
  for (var i = 0; i < apps.count; i++) {
    var app = apps.objectAtIndex(i);
    var id = app.bundleIdentifier;
    var name = app.localizedName;
    var ours = (id && !id.isNil() && id.js === "com.specweave.studio") || (name && !name.isNil() && name.js === "SpecWithCode");
    if (!ours || app.bundleURL.isNil()) continue;
    var bundle = $.NSBundle.bundleWithURL(app.bundleURL);
    var version = bundle.isNil() ? null : bundle.objectForInfoDictionaryKey("CFBundleShortVersionString");
    found.push({ path: app.bundleURL.path.js, version: version && !version.isNil() ? version.js : "unknown" });
  }
  return JSON.stringify(found);
}`;

/** Converts a window in display points to screenshot pixels, and says whether it is on the main display. */
export function windowInScreenshot(found, main, size) {
  if (found === null || found === undefined) return undefined;
  const scale = size.width / main.width;
  const onMainDisplay =
    found.x >= 0 &&
    found.y >= 0 &&
    found.x + found.width <= main.width &&
    found.y + found.height <= main.height;
  return {
    onMainDisplay,
    window: {
      x: Math.round(found.x * scale),
      y: Math.round(found.y * scale),
      width: Math.round(found.width * scale),
      height: Math.round(found.height * scale),
    },
  };
}

/** Maps Vision's bottom-left, normalized boxes inside a region to screenshot pixels. */
export function regionToScreenshot(lines, region) {
  return lines.map((line) => ({
    text: line.text,
    x: Math.round(region.x + line.x * region.width),
    y: Math.round(region.y + (1 - line.y - line.height) * region.height),
    width: Math.round(line.width * region.width),
    height: Math.round(line.height * region.height),
  }));
}

export async function liveDeps({ client, scratch, saveScreenshots, outDir }) {
  const { default: sharp } = await import("sharp");
  let shots = 0;
  return {
    call: (tool, args) => client.call(tool, args),
    window: async (size) => {
      const answer = JSON.parse(
        run("/usr/bin/osascript", ["-l", "JavaScript", "-e", WINDOW_SCRIPT, MIRRORING_BUNDLE_ID]),
      );
      const found = windowInScreenshot(answer.window, answer.main, size);
      return found === undefined ? undefined : { ...found, overlays: answer.overlays ?? [] };
    },
    ocr: async (image, region) => {
      const source = Buffer.from(image, "base64");
      const meta = await sharp(source).metadata();
      const left = Math.max(0, region.x);
      const top = Math.max(0, region.y);
      const clipped = {
        x: left,
        y: top,
        width: Math.min(region.width, meta.width - left),
        height: Math.min(region.height, meta.height - top),
      };
      if (clipped.width <= 0 || clipped.height <= 0) return [];
      const file = NodePath.join(scratch, `window-${++shots}.png`);
      await sharp(source)
        .extract({ left: clipped.x, top: clipped.y, width: clipped.width, height: clipped.height })
        .resize({ width: clipped.width * 2 })
        .png()
        .toFile(file);
      if (saveScreenshots)
        NodeFS.copyFileSync(file, NodePath.join(outDir, NodePath.basename(file)));
      const answer = JSON.parse(
        run(
          "/usr/bin/osascript",
          ["-l", "JavaScript", "-e", OCR_SCRIPT, file],
          undefined,
          OCR_TIMEOUT_MS,
        ),
      );
      return regionToScreenshot(answer.lines, clipped);
    },
    // Clock's tab icons: a column of four round icons at the lower right of the window.
    icons: async (image, region) => {
      const source = Buffer.from(image, "base64");
      const meta = await sharp(source).metadata();
      const left = Math.max(0, region.x);
      const top = Math.max(0, region.y);
      const width = Math.min(region.width, meta.width - left);
      const height = Math.min(region.height, meta.height - top);
      if (width <= 0 || height <= 0) return { column: undefined, marks: [] };
      const { data, info } = await sharp(source)
        .extract({ left, top, width, height })
        .removeAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      const marks = [];
      const column = findIconColumn({ data, ...info }, 4, marks);
      const place = (point) => ({ x: left + point.x, y: top + point.y });
      return { column: column?.map(place), marks: marks.map(place) };
    },
    warmUp: async () => {
      const file = NodePath.join(scratch, "warm-up.png");
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="120"><rect width="100%" height="100%" fill="white"/><text x="20" y="80" font-size="56" font-family="Helvetica">Warm up 4207</text></svg>`;
      await sharp(Buffer.from(svg)).png().toFile(file);
      const started = Date.now();
      run(
        "/usr/bin/osascript",
        ["-l", "JavaScript", "-e", OCR_SCRIPT, file],
        undefined,
        OCR_FIRST_TIMEOUT_MS,
      );
      return Date.now() - started;
    },
    loadavg: () => NodeOS.loadavg()[0],
    desktopApps: async () =>
      JSON.parse(run("/usr/bin/osascript", ["-l", "JavaScript", "-e", DESKTOP_APPS_SCRIPT])),
    // The app in front, read on the Mac: no tool call, nothing changes.
    frontmost: async () =>
      run("/usr/bin/osascript", ["-l", "JavaScript", "-e", FRONTMOST_SCRIPT]) || undefined,
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
