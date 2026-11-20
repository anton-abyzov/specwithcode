/**
 * JXA (JavaScript for Automation) scripts used by the macOS computer-use driver.
 * Split from `computerUseSteps.ts` to keep every file well under the 1,500-line limit.
 */

/**
 * Replays steps with Quartz events through JavaScript for Automation, then
 * reports the frontmost application. Runs as a child of the desktop app, so
 * macOS checks the app's Accessibility permission.
 *
 * Accepts either stdin JSON `{ steps, options }` (preferred so cleartext never
 * appears in process argv) or legacy `argv[0]` / `argv[1]` JSON arguments.
 */
export const JXA_INPUT_SCRIPT = `
ObjC.import("Foundation");
ObjC.import("CoreGraphics");
ObjC.import("AppKit");
try {
  ObjC.bindFunction("CGEventKeyboardSetUnicodeString", ["void", ["void *", "unsigned long", "void *"]]);
} catch (e) {}
function readStdin() {
  var data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  if (!data || (typeof data.isNil === "function" && data.isNil())) return "";
  var str = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
  return str ? ObjC.unwrap(str) : "";
}
var lastFrontPid = -1;
function frontApp() {
  var front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  if (front.isNil()) {
    lastFrontPid = -1;
    return null;
  }
  var pid = Number(front.processIdentifier);
  lastFrontPid = pid > 0 ? pid : -1;
  return front;
}
function frontBundleId() {
  var front = frontApp();
  if (front === null) return null;
  var id = front.bundleIdentifier;
  return id && typeof id.isNil === "function" && !id.isNil() ? id.js : null;
}
function frontLocalizedName() {
  var front = frontApp();
  return front === null ? null : front.localizedName.js;
}
function frontPid() {
  var front = frontApp();
  return front === null ? -1 : Number(front.processIdentifier);
}
// Mouse move, drags, button downs, scroll wheel, and key down.
var HUMAN_INPUT_EVENTS = [5, 6, 7, 27, 1, 3, 25, 22, 10];
function humanInputIdle() {
  for (var e = 0; e < HUMAN_INPUT_EVENTS.length; e++) {
    if ($.CGEventSourceSecondsSinceLastEventType(1, HUMAN_INPUT_EVENTS[e]) < 0.15) return false;
  }
  return true;
}
function currentCursor() {
  var probe = $.CGEventCreate(null);
  if (!probe) return null;
  var loc = $.CGEventGetLocation(probe);
  return { x: Number(loc.x), y: Number(loc.y) };
}
function screenAreas() {
  var screens = $.NSScreen.screens;
  if (!screens || screens.isNil()) return [];
  var count = Number(screens.count);
  var primaryHeight = count > 0 ? Number(screens.objectAtIndex(0).frame.size.height) : 0;
  var areas = [];
  for (var s = 0; s < count; s++) {
    var scr = screens.objectAtIndex(s);
    var f = scr.frame;
    var v = scr.visibleFrame;
    areas.push({
      frame: {
        x: Number(f.origin.x),
        y: primaryHeight - Number(f.origin.y) - Number(f.size.height),
        width: Number(f.size.width),
        height: Number(f.size.height),
      },
      visible: {
        x: Number(v.origin.x),
        y: primaryHeight - Number(v.origin.y) - Number(v.size.height),
        width: Number(v.size.width),
        height: Number(v.size.height),
      },
    });
  }
  return areas;
}
function isDockTransparentArea(x, y, width, height, px, py, displays) {
  for (var d = 0; d < displays.length; d++) {
    var disp = displays[d];
    if (
      Math.abs(x - disp.frame.x) <= 2 &&
      Math.abs(y - disp.frame.y) <= 2 &&
      Math.abs(width - disp.frame.width) <= 2 &&
      Math.abs(height - disp.frame.height) <= 2
    ) {
      var inVisible =
        px >= disp.visible.x &&
        px < disp.visible.x + disp.visible.width &&
        py >= disp.visible.y &&
        py < disp.visible.y + disp.visible.height;
      return inVisible || py < disp.visible.y;
    }
  }
  return false;
}
function snapshotWindows() {
  if (typeof $.CGWindowListCopyWindowInfo !== "function") return null;
  var raw = $.CGWindowListCopyWindowInfo(1 | 16, 0);
  if (!raw) return null;
  return {
    list: ObjC.deepUnwrap(ObjC.castRefToObject(raw)) || [],
    displays: screenAreas(),
  };
}
function pointOwnerFromSnapshot(snap, px, py) {
  if (!snap) return null;
  var list = snap.list;
  var displays = snap.displays;
  for (var w = 0; w < list.length; w++) {
    var item = list[w];
    var alpha = Number(item.kCGWindowAlpha);
    var b = item.kCGWindowBounds || {};
    var x = Number(b.X), y = Number(b.Y), width = Number(b.Width), height = Number(b.Height);
    if (!(alpha > 0) || !(px >= x && px < x + width && py >= y && py < y + height)) continue;
    var owner = typeof item.kCGWindowOwnerName === "string" ? item.kCGWindowOwnerName.trim() : "";
    var layer = Number(item.kCGWindowLayer);
    var pid = Number(item.kCGWindowOwnerPID);
    if (owner === "Window Server") {
      if (layer === 24 || layer === 25) {
        return { owner: frontLocalizedName(), pid: frontPid(), windowId: null };
      }
      continue;
    }
    if (owner === "Dock" && layer !== 0 && isDockTransparentArea(x, y, width, height, px, py, displays)) {
      continue;
    }
    var windowId = item.kCGWindowNumber === undefined ? null : Number(item.kCGWindowNumber);
    return { owner: owner, pid: pid, windowId: windowId, bounds: { x: x, y: y, width: width, height: height } };
  }
  return null;
}
function pointOwnerAt(px, py) {
  return pointOwnerFromSnapshot(snapshotWindows(), px, py);
}
function verifyExpectedOwner(expected, forbidPid, ignoreBounds, snap) {
  if (!expected) return { err: null, hit: null };
  var hit =
    snap !== undefined
      ? pointOwnerFromSnapshot(snap, Number(expected.x), Number(expected.y))
      : pointOwnerAt(Number(expected.x), Number(expected.y));
  if (!hit || !hit.owner) return { err: "unknown", hit: null };
  if (typeof forbidPid === "number" && forbidPid > 0 && hit.pid === forbidPid) {
    return { err: "forbidden-pid:" + forbidPid, hit: null };
  }
  if (hit.owner.toLowerCase() !== String(expected.application || "").trim().toLowerCase()) {
    return { err: hit.owner, hit: null };
  }
  if (typeof expected.windowId === "number" && expected.windowId > 0) {
    if (hit.windowId !== expected.windowId) {
      return { err: "window-changed:" + (hit.windowId === null ? "unknown" : hit.windowId), hit: null };
    }
  }
  if (expected.bounds && !ignoreBounds) {
    var eb = expected.bounds;
    var hb = hit.bounds;
    if (
      !hb ||
      Math.abs(hb.x - Number(eb.x)) > 1 ||
      Math.abs(hb.y - Number(eb.y)) > 1 ||
      Math.abs(hb.width - Number(eb.width)) > 1 ||
      Math.abs(hb.height - Number(eb.height)) > 1
    ) {
      return { err: "window-moved", hit: null };
    }
  }
  return { err: null, hit: hit };
}
function checkPointOwner(opts, snap) {
  return verifyExpectedOwner(opts.expectedPointOwner, opts.forbidPid, false, snap).err;
}
function checkDropOwner(opts, ignoreBounds, snap) {
  return verifyExpectedOwner(opts.expectedDropOwner, opts.forbidPid, Boolean(ignoreBounds), snap).err;
}
function matchesAllowedEndpoint(hit, expected) {
  if (!expected) return false;
  if (hit.owner.toLowerCase() !== String(expected.application || "").trim().toLowerCase()) {
    return false;
  }
  if (typeof expected.windowId === "number" && expected.windowId > 0) {
    if (hit.windowId !== expected.windowId) return false;
  }
  return true;
}
function checkDragSegmentOwner(x, y, opts, snap) {
  if (!opts.expectedPointOwner && !opts.expectedDropOwner) return null;
  var hit =
    snap !== undefined
      ? pointOwnerFromSnapshot(snap, Number(x), Number(y))
      : pointOwnerAt(Number(x), Number(y));
  if (!hit || !hit.owner) return "unknown";
  if (typeof opts.forbidPid === "number" && opts.forbidPid > 0 && hit.pid === opts.forbidPid) {
    return "forbidden-pid:" + opts.forbidPid;
  }
  if (
    matchesAllowedEndpoint(hit, opts.expectedPointOwner) ||
    matchesAllowedEndpoint(hit, opts.expectedDropOwner)
  ) {
    return null;
  }
  return hit.owner;
}
// Mouse button down event types and the up that releases each; the dragged events in between.
var MOUSE_UPS = { 1: 2, 3: 4, 25: 26 };
var MOUSE_UP_EVENTS = { 2: true, 4: true, 26: true };
var MOUSE_DRAGGED = { 6: true, 7: true, 27: true };
var MODIFIER_FLAGS = { 55: 0x100000, 56: 0x20000, 58: 0x80000, 59: 0x40000, 63: 0x800000 };
function run(argv) {
  var steps;
  var opts;
  if (argv && argv.length > 0 && argv[0]) {
    steps = JSON.parse(argv[0]);
    opts = argv.length > 1 && argv[1] ? JSON.parse(argv[1]) : {};
  } else {
    var rawIn = readStdin();
    var payload = rawIn ? JSON.parse(rawIn) : {};
    steps = Array.isArray(payload.steps) ? payload.steps : [];
    opts = payload.options || {};
  }
  function checkForeground() {
    if (typeof opts.forbidPid === "number" && opts.forbidPid > 0 && frontPid() === opts.forbidPid) {
      return "forbidden-frontmost-pid: " + opts.forbidPid;
    }
    if (typeof opts.expectedFrontmost === "string" && opts.expectedFrontmost.trim() !== "") {
      var actualFront = frontLocalizedName();
      if (!actualFront || actualFront.trim().toLowerCase() !== opts.expectedFrontmost.trim().toLowerCase()) {
        return "not-frontmost-app: " + (actualFront || "unknown");
      }
    }
    return null;
  }
  var unicodeActive = typeof opts.unicodeText === "string" && opts.unicodeText.length > 0;
  if (opts.yieldForHumanInput) {
    var yieldWaited = 0;
    while (yieldWaited < 500) {
      if (humanInputIdle()) break;
      delay(0.05);
      yieldWaited += 50;
    }
  }
  if (steps.length > 0 || unicodeActive) {
    var initFgErr = checkForeground();
    if (initFgErr !== null) throw new Error(initFgErr);
    var badOwner = checkPointOwner(opts);
    if (badOwner !== null) {
      throw new Error("point-owner-changed: " + badOwner);
    }
    var badDrop = checkDropOwner(opts);
    if (badDrop !== null) {
      throw new Error("drop-owner-changed: " + badDrop);
    }
  }
  var savedCursor = opts.restoreCursor ? currentCursor() : null;
  var lastSyntheticCursor = null;
  var humanMoved = false;
  var hid = null;
  // Once an awaitFront step passes, every later event first checks that its app is still in front.
  var guarded = null;
  // Events that reach an app (pointer moves do not), and the presses not yet released, in order.
  var posted = 0;
  var held = [];
  var unicodeDispatched = false;
  function latchHumanMoved() {
    if (savedCursor === null || humanMoved) return;
    var expected = lastSyntheticCursor !== null ? lastSyntheticCursor : savedCursor;
    var cur = currentCursor();
    if (
      cur !== null &&
      (Math.abs(cur.x - expected.x) > 2 ||
        Math.abs(cur.y - expected.y) > 2)
    ) {
      humanMoved = true;
    }
  }
  function maybeRestoreCursor() {
    if (savedCursor === null || humanMoved) return;
    latchHumanMoved();
    if (!humanMoved) {
      var restore = $.CGEventCreateMouseEvent(null, 5, savedCursor, 0);
      $.CGEventPost(0, restore);
    }
  }
  function heldIndex(type, id) {
    for (var h = 0; h < held.length; h++) if (held[h].type === type && held[h].id === id) return h;
    return -1;
  }
  function stop(reason, cancelDrag) {
    latchHumanMoved();
    // Never leave a button or key down: release what this replay pressed, last first.
    // When cancelling a drag because the drop target changed, never send global Escape
    // or a global mouse-up over a newly focused or unverified window: target only the
    // verified drag-source PID (or the still-verified drag origin).
    var modifiers = 0;
    for (var m = 0; m < held.length; m++) {
      if (held[m].type === "key" && MODIFIER_FLAGS[held[m].id] !== undefined) modifiers |= MODIFIER_FLAGS[held[m].id];
    }
    for (var r = held.length - 1; r >= 0; r--) {
      var press = held[r];
      var release;
      if (press.type === "mouse") {
        var validStartPid =
          typeof press.startPid === "number" &&
          press.startPid > 0 &&
          !(typeof opts.forbidPid === "number" && opts.forbidPid > 0 && press.startPid === opts.forbidPid)
            ? press.startPid
            : null;
        function isOriginStillSafe() {
          latchHumanMoved();
          if (humanMoved) return false;
          if (!opts.expectedPointOwner) return !cancelDrag;
          var check = verifyExpectedOwner(opts.expectedPointOwner, opts.forbidPid);
          if (check.err !== null || !check.hit) return false;
          if (validStartPid !== null && check.hit.pid !== validStartPid) return false;
          if (typeof press.startWindowId === "number" && press.startWindowId > 0 && check.hit.windowId !== press.startWindowId) {
            return false;
          }
          return true;
        }
        if (cancelDrag) {
          if (
            validStartPid !== null &&
            frontPid() === validStartPid &&
            typeof $.CGEventPostToPid === "function"
          ) {
            var escDown = $.CGEventCreateKeyboardEvent(null, 53, true);
            var escUp = $.CGEventCreateKeyboardEvent(null, 53, false);
            if (escDown !== null) { $.CGEventSetFlags(escDown, 0); $.CGEventPostToPid(validStartPid, escDown); }
            if (escUp !== null) { $.CGEventSetFlags(escUp, 0); $.CGEventPostToPid(validStartPid, escUp); }
          }
        }
        var releasePoint =
          cancelDrag && typeof press.startX === "number" && typeof press.startY === "number"
            ? { x: press.startX, y: press.startY }
            : humanMoved && !cancelDrag
              ? currentCursor() || { x: press.x, y: press.y }
              : { x: press.x, y: press.y };
        if (
          cancelDrag &&
          typeof press.startX === "number" &&
          typeof press.startY === "number" &&
          isOriginStillSafe()
        ) {
          var dragBack = $.CGEventCreateMouseEvent(null, 6, releasePoint, press.button);
          if (dragBack !== null) {
            $.CGEventPost(0, dragBack);
            lastSyntheticCursor = { x: releasePoint.x, y: releasePoint.y };
          }
        }
        release = $.CGEventCreateMouseEvent(null, MOUSE_UPS[press.event], releasePoint, press.button);
        if (press.clickState > 0) $.CGEventSetIntegerValueField(release, 1, press.clickState);
        $.CGEventSetFlags(release, press.flags || 0);
        if (isOriginStillSafe() || (!cancelDrag && !opts.expectedPointOwner)) {
          $.CGEventPost(0, release);
          lastSyntheticCursor = { x: releasePoint.x, y: releasePoint.y };
        } else if (
          validStartPid !== null &&
          typeof $.CGEventPostToPid === "function"
        ) {
          $.CGEventPostToPid(validStartPid, release);
        }
      } else {
        if (MODIFIER_FLAGS[press.id] !== undefined) modifiers &= ~MODIFIER_FLAGS[press.id];
        release = $.CGEventCreateKeyboardEvent(press.source === "hid" ? hid : null, press.id, false);
        $.CGEventSetFlags(release, modifiers);
        var keyPid =
          typeof press.targetPid === "number" && press.targetPid > 0
            ? press.targetPid
            : typeof press.recipientPid === "number" && press.recipientPid > 0
              ? press.recipientPid
              : null;
        var currentFrontPid = frontPid();
        if (
          typeof press.targetPid === "number" &&
          press.targetPid > 0 &&
          typeof $.CGEventPostToPid === "function"
        ) {
          $.CGEventPostToPid(press.targetPid, release);
        } else if (keyPid !== null && currentFrontPid !== keyPid) {
          if (
            typeof $.CGEventPostToPid === "function" &&
            !(typeof opts.forbidPid === "number" && opts.forbidPid > 0 && keyPid === opts.forbidPid)
          ) {
            $.CGEventPostToPid(keyPid, release);
          }
        } else if (
          !(typeof opts.forbidPid === "number" && opts.forbidPid > 0 && currentFrontPid === opts.forbidPid)
        ) {
          $.CGEventPost(0, release);
        }
      }
    }
    maybeRestoreCursor();
    if (unicodeActive && unicodeDispatched) {
      throw new Error("type-uncertain: " + reason);
    }
    throw new Error((posted === 0 ? "not-frontmost: " : "left-front: ") + reason);
  }
  function verifiedFrontPid() {
    var fa = frontApp();
    var faPid = fa === null ? -1 : Number(fa.processIdentifier);
    if (typeof opts.forbidPid === "number" && opts.forbidPid > 0 && faPid === opts.forbidPid) {
      stop("forbidden-frontmost-pid: " + opts.forbidPid);
    }
    if (typeof opts.expectedFrontmost === "string" && opts.expectedFrontmost.trim() !== "") {
      var faName = fa === null ? null : fa.localizedName.js;
      if (!faName || faName.trim().toLowerCase() !== opts.expectedFrontmost.trim().toLowerCase()) {
        stop("not-frontmost-app: " + (faName || "unknown"));
      }
    }
    return faPid;
  }
  function postUnicodeText(text) {
    if (
      typeof $.CGEventPostToPid !== "function" ||
      typeof $.CGEventKeyboardSetUnicodeString !== "function"
    ) {
      stop("unicode-dispatch-unavailable");
    }
    for (var scan = 0; scan < text.length; scan++) {
      var code = text.charCodeAt(scan);
      if (code < 32 && code !== 9 && code !== 10 && code !== 13) {
        stop("type-unsupported-control-chars");
      }
    }
    var idx = 0;
    while (idx < text.length) {
      var end = idx;
      while (end < text.length && end - idx < 16) {
        var c = text.charCodeAt(end);
        if (c >= 0xd800 && c <= 0xdbff) {
          if (end - idx >= 15) break;
          end += 2;
        } else {
          end += 1;
        }
      }
      if (end === idx) end = idx + 1;
      var chunk = text.slice(idx, end);
      var chunkPid = verifiedFrontPid();
      if (chunkPid <= 0) stop("pid-dispatch-unavailable");
      var ns = $(chunk);
      var data = ns.dataUsingEncoding($.NSUTF16LittleEndianStringEncoding);
      var len = Number(ns.length);
      var uDown = $.CGEventCreateKeyboardEvent(null, 0, true);
      var uUp = $.CGEventCreateKeyboardEvent(null, 0, false);
      if (uDown !== null) {
        $.CGEventSetFlags(uDown, 0);
        $.CGEventKeyboardSetUnicodeString(uDown, len, data.bytes);
        $.CGEventPostToPid(chunkPid, uDown);
        unicodeDispatched = true;
        posted++;
      }
      if (uUp !== null) {
        $.CGEventSetFlags(uUp, 0);
        $.CGEventKeyboardSetUnicodeString(uUp, len, data.bytes);
        $.CGEventPostToPid(chunkPid, uUp);
        posted++;
      }
      idx = end;
    }
  }
  for (var i = 0; i < steps.length; i++) {
    var step = steps[i];
    var event = null;
    var keyTargetPid = null;
    var verifiedKeyRecipientPid = null;
    var verifiedMouseHit = null;
    if (step.type === "sleep") { delay(step.ms / 1000); continue; }
    if (step.type === "awaitFront") {
      var waited = 0;
      while (frontBundleId() !== step.bundleId) {
        if (waited >= step.ms) stop(step.bundleId);
        delay(0.05);
        waited += 50;
      }
      guarded = step.bundleId;
      continue;
    }
    if (guarded !== null && frontBundleId() !== guarded) stop(guarded);
    var isDragSegment = step.type === "mouse" && Boolean(MOUSE_DRAGGED[step.event]);
    var isMouseDown = step.type === "mouse" && MOUSE_UPS[step.event] !== undefined;
    var isMouseUp = step.type === "mouse" && Boolean(MOUSE_UP_EVENTS[step.event]);
    var isInFlightDragUp = isMouseUp && Boolean(opts.expectedDropOwner);
    if (isDragSegment) {
      var segSnap = snapshotWindows();
      var segErr = checkDragSegmentOwner(step.x, step.y, opts, segSnap);
      if (segErr !== null) stop("drag-path-owner-changed:" + segErr, true);
      if (opts.expectedDropOwner) {
        var midDropErr = checkDropOwner(opts, true, segSnap);
        if (midDropErr !== null) stop("drop-owner-changed:" + midDropErr, true);
      }
    } else if (isInFlightDragUp) {
      var upDropErr = checkDropOwner(opts, true);
      if (upDropErr !== null) stop("drop-owner-changed:" + upDropErr, true);
    } else if (step.type === "mouse" || step.type === "scroll") {
      var stepSnap =
        opts.expectedPointOwner || opts.expectedDropOwner
          ? snapshotWindows()
          : undefined;
      if (opts.expectedPointOwner) {
        var stepOwnerCheck = verifyExpectedOwner(opts.expectedPointOwner, opts.forbidPid, false, stepSnap);
        if (stepOwnerCheck.err !== null) stop("point-owner-changed:" + stepOwnerCheck.err, Boolean(opts.expectedDropOwner));
        verifiedMouseHit = stepOwnerCheck.hit;
      }
      if (opts.expectedDropOwner && isMouseDown) {
        var preDropErr = checkDropOwner(opts, false, stepSnap);
        if (preDropErr !== null) stop("drop-owner-changed:" + preDropErr, true);
      }
      if (isMouseDown && (opts.expectedPointOwner || opts.expectedDropOwner)) {
        for (var d = i + 1; d < steps.length; d++) {
          var ds = steps[d];
          if (ds.type === "mouse" && MOUSE_DRAGGED[ds.event]) {
            var preSegErr = checkDragSegmentOwner(ds.x, ds.y, opts, stepSnap);
            if (preSegErr !== null) stop("drag-path-owner-changed:" + preSegErr, true);
          }
        }
      }
    }
    if (step.type === "mouse") {
      latchHumanMoved();
      if (humanMoved) stop("human-moved", Boolean(opts.expectedDropOwner));
      if (MOUSE_UPS[step.event] !== undefined && verifiedMouseHit === null && !opts.expectedPointOwner) {
        var preDownHit = pointOwnerAt(Number(step.x), Number(step.y));
        if (
          preDownHit &&
          !(typeof opts.forbidPid === "number" && opts.forbidPid > 0 && preDownHit.pid === opts.forbidPid)
        ) {
          verifiedMouseHit = preDownHit;
        }
      }
      event = $.CGEventCreateMouseEvent(null, step.event, { x: step.x, y: step.y }, step.button);
      if (step.clickState > 0) $.CGEventSetIntegerValueField(event, 1, step.clickState);
    } else if (step.type === "key") {
      if (step.source === "hid" && hid === null) hid = $.CGEventSourceCreate(1);
      event = $.CGEventCreateKeyboardEvent(step.source === "hid" ? hid : null, step.keyCode, step.down);
      if (event !== null && step.flags !== undefined) $.CGEventSetFlags(event, step.flags);
      if (
        (typeof opts.expectedFrontmost === "string" && opts.expectedFrontmost.trim() !== "") ||
        (typeof opts.forbidPid === "number" && opts.forbidPid > 0)
      ) {
        verifiedKeyRecipientPid = verifiedFrontPid();
      } else if (guarded !== null) {
        if (lastFrontPid > 0) verifiedKeyRecipientPid = lastFrontPid;
      } else {
        var fp = frontPid();
        if (fp > 0) verifiedKeyRecipientPid = fp;
      }
    } else if (step.type === "scroll") {
      latchHumanMoved();
      if (humanMoved) stop("human-moved");
      event = $.CGEventCreateScrollWheelEvent2(null, 1, 2, step.vertical, step.horizontal, 0);
      if (event !== null && typeof step.x === "number" && typeof step.y === "number") {
        $.CGEventSetLocation(event, { x: step.x, y: step.y });
      }
    }
    if (event === null) continue;
    if (step.type !== "key" && step.flags !== undefined) $.CGEventSetFlags(event, step.flags);
    if (keyTargetPid !== null) {
      $.CGEventPostToPid(keyTargetPid, event);
    } else {
      $.CGEventPost(0, event);
    }
    if (step.type === "mouse") {
      lastSyntheticCursor = { x: Number(step.x), y: Number(step.y) };
      var at = heldIndex("mouse", step.button);
      if (MOUSE_UPS[step.event] !== undefined) {
        if (at < 0) {
          var startPid = verifiedMouseHit && typeof verifiedMouseHit.pid === "number" && verifiedMouseHit.pid > 0 ? verifiedMouseHit.pid : null;
          var startWindowId = verifiedMouseHit && typeof verifiedMouseHit.windowId === "number" && verifiedMouseHit.windowId > 0 ? verifiedMouseHit.windowId : null;
          held.push({ type: "mouse", id: step.button, event: step.event, button: step.button, x: step.x, y: step.y, startX: step.x, startY: step.y, startPid: startPid, startWindowId: startWindowId, clickState: step.clickState, flags: step.flags });
        }
      } else if (MOUSE_DRAGGED[step.event] && at >= 0) {
        held[at].x = step.x;
        held[at].y = step.y;
      } else if (step.event !== 5 && at >= 0) {
        held.splice(at, 1);
      }
      if (step.event !== 5) posted++;
    } else {
      if (step.type === "key") {
        var k = heldIndex("key", step.keyCode);
        if (step.down && k < 0) held.push({ type: "key", id: step.keyCode, source: step.source, targetPid: keyTargetPid, recipientPid: verifiedKeyRecipientPid });
        else if (!step.down && k >= 0) held.splice(k, 1);
      }
      posted++;
    }
  }
  if (unicodeActive) {
    postUnicodeText(opts.unicodeText);
  }
  maybeRestoreCursor();
  var front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  return JSON.stringify({ frontmostApplication: front.isNil() ? null : front.localizedName.js });
}
`;

/**
 * Performs a background Accessibility click (`AXPress` or editable field probe)
 * or text entry (`AXValue`) on an approved app PID at global display
 * coordinates, without moving the physical cursor, stealing foreground focus,
 * or touching the clipboard. Uses public ApplicationServices AXUIElement C
 * APIs and verifies window stacking identity via CoreGraphics `kCGWindowNumber`.
 *
 * Accepts either stdin JSON (preferred so cleartext never appears in process
 * argv) or legacy `argv[0]` JSON.
 */
export const JXA_AX_ACTION_SCRIPT = `
ObjC.import("Foundation");
ObjC.import("CoreGraphics");
ObjC.import("ApplicationServices");
ObjC.import("AppKit");
ObjC.bindFunction("AXUIElementCreateApplication", ["void *", ["int"]]);
ObjC.bindFunction("AXUIElementCopyElementAtPosition", ["int", ["void *", "float", "float", "void **"]]);
ObjC.bindFunction("AXUIElementPerformAction", ["int", ["void *", "id"]]);
ObjC.bindFunction("AXUIElementSetAttributeValue", ["int", ["void *", "id", "id"]]);
ObjC.bindFunction("AXUIElementCopyAttributeValue", ["int", ["void *", "id", "void **"]]);
ObjC.bindFunction("AXUIElementIsAttributeSettable", ["int", ["void *", "id", "bool *"]]);
ObjC.bindFunction("AXUIElementCopyActionNames", ["int", ["void *", "void **"]]);
ObjC.bindFunction("AXValueGetValue", ["bool", ["void *", "int", "void *"]]);
ObjC.bindFunction("CFRelease", ["void", ["void *"]]);
var EDITABLE_ROLES = {
  AXTextField: true,
  AXTextArea: true,
  AXSearchField: true,
  AXComboBox: true
};
function readStdin() {
  var data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  if (!data || (typeof data.isNil === "function" && data.isNil())) return "";
  var str = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
  return str ? ObjC.unwrap(str) : "";
}
function frontName() {
  var front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  return front.isNil() ? null : front.localizedName.js;
}
function frontPid() {
  var front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  if (!front || (typeof front.isNil === "function" && front.isNil())) return -1;
  return Number(front.processIdentifier);
}
function verifyWindowAtPoint(req) {
  if (typeof req.windowId !== "number" || req.windowId <= 0) return null;
  if (typeof $.CGWindowListCopyWindowInfo !== "function") return "ax-window-unverifiable";
  var raw = $.CGWindowListCopyWindowInfo(1 | 16, 0);
  if (!raw) return "ax-window-occluded";
  var list = ObjC.deepUnwrap(ObjC.castRefToObject(raw)) || [];
  var topId = null;
  var expected = req.expectedWindowBounds;
  var matchingSiblings = 0;
  for (var w = 0; w < list.length; w++) {
    var item = list[w];
    var alpha = Number(item.kCGWindowAlpha);
    var layer = Number(item.kCGWindowLayer);
    var ownerPid = Number(item.kCGWindowOwnerPID);
    var b = item.kCGWindowBounds || {};
    var x = Number(b.X), y = Number(b.Y), width = Number(b.Width), height = Number(b.Height);
    if (ownerPid !== req.pid || !(alpha > 0)) continue;
    if (!(req.x >= x && req.x < x + width && req.y >= y && req.y < y + height)) continue;
    var wid = item.kCGWindowNumber === undefined ? null : Number(item.kCGWindowNumber);
    if (layer === 0 && topId === null) topId = wid;
    if (
      expected &&
      typeof expected === "object" &&
      wid !== req.windowId &&
      Math.abs(x - Number(expected.x)) <= 2 &&
      Math.abs(y - Number(expected.y)) <= 2 &&
      Math.abs(width - Number(expected.width)) <= 2 &&
      Math.abs(height - Number(expected.height)) <= 2
    ) {
      matchingSiblings++;
    }
  }
  if (topId !== req.windowId) return "ax-window-occluded";
  if (matchingSiblings > 0) return "ax-window-ambiguous";
  return null;
}
function copyStringAttr(el, name) {
  var ref = Ref();
  var err = $.AXUIElementCopyAttributeValue(el, $(name), ref);
  if (err !== 0 || ref[0] === null || ref[0] === undefined) return { ok: false, err: err, value: null };
  var unwrapped = ObjC.unwrap(ObjC.castRefToObject(ref[0]));
  $.CFRelease(ref[0]);
  if (typeof unwrapped !== "string") return { ok: false, err: 0, value: null };
  return { ok: true, err: 0, value: unwrapped };
}
function isAttrSettable(el, name) {
  var settableRef = Ref();
  var err = $.AXUIElementIsAttributeSettable(el, $(name), settableRef);
  return err === 0 && Boolean(settableRef[0]);
}
var B64_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function decodeTwoFloat64LE(b64) {
  var bytes = new Uint8Array(16);
  var out = 0;
  var buf = 0;
  var bits = 0;
  for (var i = 0; i < b64.length && out < 16; i++) {
    var c = b64.charAt(i);
    if (c === "=") break;
    var v = B64_CHARS.indexOf(c);
    if (v < 0) continue;
    buf = (buf << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes[out++] = (buf >> bits) & 0xff;
    }
  }
  if (out < 16) return null;
  var view = new DataView(bytes.buffer);
  return [view.getFloat64(0, true), view.getFloat64(8, true)];
}
function readAxPair(axWin, attrName, valueType) {
  var valRef = Ref();
  if ($.AXUIElementCopyAttributeValue(axWin, $(attrName), valRef) !== 0 || !valRef[0]) return null;
  var buf = $.NSMutableData.dataWithLength(16);
  var ok = $.AXValueGetValue(valRef[0], valueType, buf.mutableBytes);
  if (!ok) return null;
  return decodeTwoFloat64LE(buf.base64EncodedStringWithOptions(0).js);
}
function readElementWindowInfo(el, role) {
  var axWin = null;
  if (role === "AXWindow") {
    axWin = el;
  } else {
    var winRef = Ref();
    if ($.AXUIElementCopyAttributeValue(el, $("AXWindow"), winRef) === 0 && winRef[0]) {
      axWin = winRef[0];
    }
  }
  if (!axWin) return { bounds: null, title: "", doc: "", winIdAttr: "" };
  var pos = readAxPair(axWin, "AXPosition", 1);
  var size = readAxPair(axWin, "AXSize", 2);
  var bounds = pos && size ? { x: pos[0], y: pos[1], width: size[0], height: size[1] } : null;
  var titleAttr = copyStringAttr(axWin, "AXTitle");
  var docAttr = copyStringAttr(axWin, "AXDocument");
  var idAttr = copyStringAttr(axWin, "AXIdentifier");
  return {
    bounds: bounds,
    title: titleAttr.ok && titleAttr.value ? titleAttr.value : "",
    doc: docAttr.ok && docAttr.value ? docAttr.value : "",
    winIdAttr: idAttr.ok && idAttr.value ? idAttr.value : ""
  };
}
function verifyElementWindow(winInfo, req) {
  var expected = req.expectedWindowBounds;
  if (!expected || typeof expected !== "object") return null;
  if (!winInfo.bounds) return "ax-window-unverifiable";
  if (
    Math.abs(winInfo.bounds.x - Number(expected.x)) > 2 ||
    Math.abs(winInfo.bounds.y - Number(expected.y)) > 2 ||
    Math.abs(winInfo.bounds.width - Number(expected.width)) > 2 ||
    Math.abs(winInfo.bounds.height - Number(expected.height)) > 2
  ) {
    return "ax-window-mismatch";
  }
  if (
    typeof req.expectedWindowTitle === "string" &&
    req.expectedWindowTitle.trim() !== "" &&
    winInfo.title.trim() !== req.expectedWindowTitle.trim()
  ) {
    return "ax-window-mismatch";
  }
  return null;
}
function readFieldKey(el, role, windowId, winInfo) {
  var id = copyStringAttr(el, "AXIdentifier");
  if (!id.ok || !id.value) return "";
  var title = copyStringAttr(el, "AXTitle");
  var desc = copyStringAttr(el, "AXDescription");
  var subrole = copyStringAttr(el, "AXSubrole");
  var parts = ["id:" + id.value];
  if (typeof windowId === "number" && windowId > 0) parts.push("wid:" + windowId);
  if (winInfo.winIdAttr) parts.push("winId:" + winInfo.winIdAttr);
  if (winInfo.doc) parts.push("winDoc:" + winInfo.doc);
  if (winInfo.title) parts.push("win:" + winInfo.title);
  if (title.ok && title.value) parts.push("title:" + title.value);
  if (desc.ok && desc.value) parts.push("desc:" + desc.value);
  if (subrole.ok && subrole.value) parts.push("sub:" + subrole.value);
  return "r:" + role + "|" + parts.join("|");
}
function run(argv) {
  var rawReq = argv && argv.length > 0 && argv[0] ? argv[0] : readStdin();
  var req = rawReq ? JSON.parse(rawReq) : null;
  if (!req || typeof req.pid !== "number" || req.pid <= 0) {
    return JSON.stringify({ ok: false, reason: "invalid-pid", frontmostApplication: frontName() });
  }
  var preWinErr = verifyWindowAtPoint(req);
  if (preWinErr !== null) {
    return JSON.stringify({ ok: false, reason: preWinErr, frontmostApplication: frontName() });
  }
  var appEl = $.AXUIElementCreateApplication(req.pid);
  if (!appEl) {
    return JSON.stringify({ ok: false, reason: "app-element-null", frontmostApplication: frontName() });
  }
  var elRef = Ref();
  var hitErr = $.AXUIElementCopyElementAtPosition(appEl, req.x, req.y, elRef);
  $.CFRelease(appEl);
  if (hitErr !== 0 || !elRef[0]) {
    return JSON.stringify({ ok: false, reason: "hit-failed", err: hitErr, frontmostApplication: frontName() });
  }
  var el = elRef[0];
  try {
    var roleAttr = copyStringAttr(el, "AXRole");
    var role = roleAttr.ok ? roleAttr.value : "";
    var winInfo = readElementWindowInfo(el, role);
    var elWinErr = verifyElementWindow(winInfo, req);
    if (elWinErr !== null) {
      return JSON.stringify({ ok: false, reason: elWinErr, role: role, frontmostApplication: frontName() });
    }
    var fieldKey = readFieldKey(el, role, req.windowId, winInfo);
    if (req.mode === "click") {
      if (EDITABLE_ROLES[role]) {
        if (!isAttrSettable(el, "AXSelectedText")) {
          return JSON.stringify({ ok: false, reason: "ax-insertion-unsupported", role: role, frontmostApplication: frontName() });
        }
        if (!fieldKey) {
          return JSON.stringify({ ok: false, reason: "ax-field-unidentifiable", role: role, frontmostApplication: frontName() });
        }
        var postHitWinErr = verifyWindowAtPoint(req);
        if (postHitWinErr !== null) {
          return JSON.stringify({ ok: false, reason: postHitWinErr, role: role, frontmostApplication: frontName() });
        }
        return JSON.stringify({ ok: true, kind: "editable", role: role, fieldKey: fieldKey, frontmostApplication: frontName() });
      }
      var actionsRef = Ref();
      var actions = [];
      if ($.AXUIElementCopyActionNames(el, actionsRef) === 0 && actionsRef[0]) {
        actions = ObjC.deepUnwrap(ObjC.castRefToObject(actionsRef[0])) || [];
        $.CFRelease(actionsRef[0]);
      }
      if (actions.indexOf("AXPress") >= 0) {
        var pressWinErr = verifyWindowAtPoint(req);
        if (pressWinErr !== null) {
          return JSON.stringify({ ok: false, reason: pressWinErr, role: role, frontmostApplication: frontName() });
        }
        var pressErr = $.AXUIElementPerformAction(el, $("AXPress"));
        if (pressErr === 0) {
          return JSON.stringify({ ok: true, kind: "pressed", role: role, frontmostApplication: frontName() });
        }
        return JSON.stringify({ ok: false, reason: "ax-press-failed", err: pressErr, role: role, frontmostApplication: frontName() });
      }
      return JSON.stringify({ ok: false, reason: "unsupported-ax", role: role, frontmostApplication: frontName() });
    }
    if (req.mode === "type") {
      if (!EDITABLE_ROLES[role]) {
        return JSON.stringify({ ok: false, reason: "not-editable", role: role, frontmostApplication: frontName() });
      }
      if (!req.expectedRole || req.expectedRole !== role) {
        return JSON.stringify({ ok: false, reason: "stale-field-role", role: role, frontmostApplication: frontName() });
      }
      if (!req.expectedFieldKey || !fieldKey || req.expectedFieldKey !== fieldKey) {
        return JSON.stringify({ ok: false, reason: "stale-field-key", role: role, frontmostApplication: frontName() });
      }
      var text = String(req.text || "");
      if (text.length === 0) {
        var emptyWinErr = verifyWindowAtPoint(req);
        if (emptyWinErr !== null) {
          return JSON.stringify({ ok: false, reason: emptyWinErr, role: role, frontmostApplication: frontName() });
        }
        return JSON.stringify({ ok: true, kind: "typed", role: role, frontmostApplication: frontName() });
      }
      if (!isAttrSettable(el, "AXSelectedText")) {
        return JSON.stringify({ ok: false, reason: "ax-insertion-unsupported", role: role, frontmostApplication: frontName() });
      }
      var selWinErr = verifyWindowAtPoint(req);
      if (selWinErr !== null) {
        return JSON.stringify({ ok: false, reason: selWinErr, role: role, frontmostApplication: frontName() });
      }
      var activeFrontPid = frontPid();
      if (!(activeFrontPid > 0 && activeFrontPid !== req.pid)) {
        return JSON.stringify({ ok: false, reason: "ax-target-frontmost", role: role, frontmostApplication: frontName() });
      }
      var currentSel = copyStringAttr(el, "AXSelectedText");
      if (currentSel.ok) {
        if (currentSel.value.length > 0) {
          return JSON.stringify({ ok: false, reason: "ax-selection-nonempty", role: role, frontmostApplication: frontName() });
        }
      } else if (currentSel.err !== -25212) {
        return JSON.stringify({ ok: false, reason: "ax-selection-unreadable", err: currentSel.err, role: role, frontmostApplication: frontName() });
      }
      var selErr = $.AXUIElementSetAttributeValue(el, $("AXSelectedText"), $(text));
      if (selErr === 0) {
        return JSON.stringify({ ok: true, kind: "typed", role: role, frontmostApplication: frontName() });
      }
      if (selErr === -25204) {
        return JSON.stringify({ ok: false, reason: "ax-set-uncertain", err: selErr, role: role, frontmostApplication: frontName() });
      }
      return JSON.stringify({ ok: false, reason: "ax-set-failed", err: selErr, role: role, frontmostApplication: frontName() });
    }
    return JSON.stringify({ ok: false, reason: "unknown-mode", frontmostApplication: frontName() });
  } finally {
    $.CFRelease(el);
  }
}
`;

/**
 * Lists on-screen windows front to back (CGWindowListCopyWindowInfo with
 * on-screen-only and no desktop elements) and the displays, in the global
 * display points a click is posted at, with the frontmost app. Owner names
 * need no Screen Recording permission.
 */
export const JXA_WINDOWS_SCRIPT = `
ObjC.import("CoreGraphics");
ObjC.import("AppKit");
function area(rect, primaryHeight) {
  return {
    x: Number(rect.origin.x),
    y: primaryHeight - Number(rect.origin.y) - Number(rect.size.height),
    width: Number(rect.size.width),
    height: Number(rect.size.height)
  };
}
function run() {
  var list = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo(1 | 16, 0))) || [];
  var windows = [];
  for (var i = 0; i < list.length; i++) {
    var w = list[i];
    var b = w.kCGWindowBounds || {};
    windows.push({
      owner: w.kCGWindowOwnerName || null,
      layer: Number(w.kCGWindowLayer),
      alpha: w.kCGWindowAlpha === undefined ? 1 : Number(w.kCGWindowAlpha),
      x: Number(b.X), y: Number(b.Y), width: Number(b.Width), height: Number(b.Height),
      windowId: w.kCGWindowNumber === undefined ? undefined : Number(w.kCGWindowNumber),
      pid: w.kCGWindowOwnerPID === undefined ? undefined : Number(w.kCGWindowOwnerPID),
      title: typeof w.kCGWindowName === "string" && w.kCGWindowName.trim() !== "" ? w.kCGWindowName.trim() : undefined
    });
  }
  var screens = [];
  var all = $.NSScreen.screens;
  if (all.count > 0) {
    var primaryHeight = Number(all.objectAtIndex(0).frame.size.height);
    for (var j = 0; j < all.count; j++) {
      var screen = all.objectAtIndex(j);
      screens.push({ frame: area(screen.frame, primaryHeight), visible: area(screen.visibleFrame, primaryHeight) });
    }
  }
  var front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  return JSON.stringify({
    frontmost: front.isNil() ? null : front.localizedName.js,
    windows: windows,
    screens: screens
  });
}
`;

/**
 * The localizedName of a running app, matched by bundle id (argv[0]) or
 * bundle path (argv[1]); an empty string when it is not running.
 */
export const JXA_RUNNING_APP_NAME_SCRIPT = `
ObjC.import("AppKit");
function run(argv) {
  var bundleId = argv[0] || "";
  var bundlePath = argv[1] || "";
  var apps = $.NSWorkspace.sharedWorkspace.runningApplications;
  for (var i = 0; i < apps.count; i++) {
    var app = apps.objectAtIndex(i);
    var id = app.bundleIdentifier;
    var url = app.bundleURL;
    var byId = bundleId !== "" && !id.isNil() && id.js === bundleId;
    var byPath = bundlePath !== "" && !url.isNil() && url.path.js === bundlePath;
    if (byId || byPath) return app.localizedName.isNil() ? "" : app.localizedName.js;
  }
  return "";
}
`;
