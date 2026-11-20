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
function readStdin() {
  var data = $.NSFileHandle.fileHandleWithStandardInput.readDataToEndOfFile;
  if (!data || (typeof data.isNil === "function" && data.isNil())) return "";
  var str = $.NSString.alloc.initWithDataEncoding(data, $.NSUTF8StringEncoding);
  return str ? ObjC.unwrap(str) : "";
}
function frontApp() {
  var front = $.NSWorkspace.sharedWorkspace.frontmostApplication;
  return front.isNil() ? null : front;
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
function pointOwnerAt(px, py) {
  var raw = $.CGWindowListCopyWindowInfo(1 | 16, 0);
  if (!raw) return null;
  var list = ObjC.deepUnwrap(ObjC.castRefToObject(raw)) || [];
  var displays = screenAreas();
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
        return { owner: frontLocalizedName(), pid: frontPid() };
      }
      continue;
    }
    if (owner === "Dock" && layer !== 0 && isDockTransparentArea(x, y, width, height, px, py, displays)) {
      continue;
    }
    return { owner: owner, pid: pid };
  }
  return null;
}
function checkPointOwner(opts) {
  if (!opts.expectedPointOwner) return null;
  var hit = pointOwnerAt(Number(opts.expectedPointOwner.x), Number(opts.expectedPointOwner.y));
  if (!hit || !hit.owner) return "unknown";
  if (typeof opts.forbidPid === "number" && opts.forbidPid > 0 && hit.pid === opts.forbidPid) {
    return "forbidden-pid:" + opts.forbidPid;
  }
  if (hit.owner.toLowerCase() !== String(opts.expectedPointOwner.application || "").trim().toLowerCase()) {
    return hit.owner;
  }
  return null;
}
// Mouse button down event types and the up that releases each; the dragged events in between.
var MOUSE_UPS = { 1: 2, 3: 4, 25: 26 };
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
  if (opts.yieldForHumanInput) {
    var yieldWaited = 0;
    while (yieldWaited < 500) {
      if (humanInputIdle()) break;
      delay(0.05);
      yieldWaited += 50;
    }
  }
  if (steps.length > 0) {
    var initFgErr = checkForeground();
    if (initFgErr !== null) throw new Error(initFgErr);
    var badOwner = checkPointOwner(opts);
    if (badOwner !== null) {
      throw new Error("point-owner-changed: " + badOwner);
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
  function latchHumanMoved() {
    if (savedCursor === null || lastSyntheticCursor === null || humanMoved) return;
    var cur = currentCursor();
    if (
      cur !== null &&
      (Math.abs(cur.x - lastSyntheticCursor.x) > 2 ||
        Math.abs(cur.y - lastSyntheticCursor.y) > 2)
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
  function stop(reason) {
    latchHumanMoved();
    // Never leave a button or key down: release what this replay pressed, last first.
    // If human pointer movement was observed, release mouse buttons at the human's
    // current cursor position rather than warping back to the old synthetic point.
    var modifiers = 0;
    for (var m = 0; m < held.length; m++) {
      if (held[m].type === "key" && MODIFIER_FLAGS[held[m].id] !== undefined) modifiers |= MODIFIER_FLAGS[held[m].id];
    }
    for (var r = held.length - 1; r >= 0; r--) {
      var press = held[r];
      var release;
      if (press.type === "mouse") {
        var releasePoint = humanMoved ? (currentCursor() || { x: press.x, y: press.y }) : { x: press.x, y: press.y };
        release = $.CGEventCreateMouseEvent(null, MOUSE_UPS[press.event], releasePoint, press.button);
        if (press.clickState > 0) $.CGEventSetIntegerValueField(release, 1, press.clickState);
        $.CGEventSetFlags(release, press.flags || 0);
      } else {
        if (MODIFIER_FLAGS[press.id] !== undefined) modifiers &= ~MODIFIER_FLAGS[press.id];
        release = $.CGEventCreateKeyboardEvent(press.source === "hid" ? hid : null, press.id, false);
        $.CGEventSetFlags(release, modifiers);
      }
      $.CGEventPost(0, release);
    }
    maybeRestoreCursor();
    throw new Error((posted === 0 ? "not-frontmost: " : "left-front: ") + reason);
  }
  var pasteActive = typeof opts.pasteText === "string";
  var pasteboard = null;
  var savedPasteboardItems = [];
  var writtenChangeCount = null;
  var pasteCompleted = false;
  if (pasteActive) {
    pasteboard = $.NSPasteboard.generalPasteboard;
    var beforeSnapshotChangeCount = Number(pasteboard.changeCount);
    var existingItems = pasteboard.pasteboardItems;
    if (existingItems && !existingItems.isNil()) {
      var itemCount = Number(existingItems.count);
      for (var pi = 0; pi < itemCount; pi++) {
        var pbItem = existingItems.objectAtIndex(pi);
        var types = pbItem.types;
        var entries = [];
        if (types && !types.isNil()) {
          var typeCount = Number(types.count);
          for (var ti = 0; ti < typeCount; ti++) {
            var typeName = types.objectAtIndex(ti);
            var data = pbItem.dataForType(typeName);
            if (data && !data.isNil()) {
              entries.push({ type: typeName, data: $.NSData.dataWithData(data) });
            }
          }
        }
        if (entries.length > 0) savedPasteboardItems.push(entries);
      }
    }
    // Revalidate foreground app and clipboard generation after snapshotting so a focus
    // switch or concurrent human copy during dataForType aborts before touching the clipboard.
    var postSnapFgErr = checkForeground();
    if (postSnapFgErr !== null) {
      throw new Error(postSnapFgErr);
    }
    if (Number(pasteboard.changeCount) !== beforeSnapshotChangeCount) {
      throw new Error("clipboard-changed: snapshot");
    }
    pasteboard.clearContents;
    pasteboard.setStringForType($(opts.pasteText), $.NSPasteboardTypeString);
    writtenChangeCount = Number(pasteboard.changeCount);
  }
  try {
    for (var i = 0; i < steps.length; i++) {
      var step = steps[i];
      var event = null;
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
      if (opts.expectedPointOwner && (step.type === "mouse" || step.type === "scroll")) {
        var stepOwnerErr = checkPointOwner(opts);
        if (stepOwnerErr !== null) stop("point-owner-changed:" + stepOwnerErr);
      }
      if (step.type === "mouse") {
        latchHumanMoved();
        if (humanMoved) stop("human-moved");
        event = $.CGEventCreateMouseEvent(null, step.event, { x: step.x, y: step.y }, step.button);
        if (step.clickState > 0) $.CGEventSetIntegerValueField(event, 1, step.clickState);
      } else if (step.type === "key") {
        var keyFgErr = checkForeground();
        if (keyFgErr !== null) stop(keyFgErr);
        if (
          pasteActive &&
          pasteboard !== null &&
          writtenChangeCount !== null &&
          Number(pasteboard.changeCount) !== writtenChangeCount
        ) {
          stop("clipboard-changed");
        }
        if (step.source === "hid" && hid === null) hid = $.CGEventSourceCreate(1);
        event = $.CGEventCreateKeyboardEvent(step.source === "hid" ? hid : null, step.keyCode, step.down);
      } else if (step.type === "scroll") {
        latchHumanMoved();
        if (humanMoved) stop("human-moved");
        event = $.CGEventCreateScrollWheelEvent2(null, 1, 2, step.vertical, step.horizontal, 0);
        if (event !== null && typeof step.x === "number" && typeof step.y === "number") {
          $.CGEventSetLocation(event, { x: step.x, y: step.y });
        }
      }
      if (event === null) continue;
      if (step.flags !== undefined) $.CGEventSetFlags(event, step.flags);
      $.CGEventPost(0, event);
      if (step.type === "mouse") {
        lastSyntheticCursor = { x: Number(step.x), y: Number(step.y) };
        var at = heldIndex("mouse", step.button);
        if (MOUSE_UPS[step.event] !== undefined) {
          if (at < 0) held.push({ type: "mouse", id: step.button, event: step.event, button: step.button, x: step.x, y: step.y, clickState: step.clickState, flags: step.flags });
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
          if (step.down && k < 0) held.push({ type: "key", id: step.keyCode, source: step.source });
          else if (!step.down && k >= 0) held.splice(k, 1);
        }
        posted++;
      }
    }
    pasteCompleted = pasteActive;
  } finally {
    if (pasteActive && pasteboard !== null && writtenChangeCount !== null) {
      if (pasteCompleted) delay(0.3);
      if (Number(pasteboard.changeCount) === writtenChangeCount) {
        pasteboard.clearContents;
        if (savedPasteboardItems.length > 0) {
          var restored = $.NSMutableArray.array;
          for (var ri = 0; ri < savedPasteboardItems.length; ri++) {
            var newItem = $.NSPasteboardItem.alloc.init;
            var savedEntries = savedPasteboardItems[ri];
            for (var ei = 0; ei < savedEntries.length; ei++) {
              newItem.setDataForType(savedEntries[ei].data, savedEntries[ei].type);
            }
            restored.addObject(newItem);
          }
          pasteboard.writeObjects(restored);
        }
      }
    }
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
function topWindowIdAtPoint(pid, px, py) {
  if (typeof $.CGWindowListCopyWindowInfo !== "function") return undefined;
  var raw = $.CGWindowListCopyWindowInfo(1 | 16, 0);
  if (!raw) return null;
  var list = ObjC.deepUnwrap(ObjC.castRefToObject(raw)) || [];
  for (var w = 0; w < list.length; w++) {
    var item = list[w];
    var alpha = Number(item.kCGWindowAlpha);
    var layer = Number(item.kCGWindowLayer);
    var ownerPid = Number(item.kCGWindowOwnerPID);
    var b = item.kCGWindowBounds || {};
    var x = Number(b.X), y = Number(b.Y), width = Number(b.Width), height = Number(b.Height);
    if (ownerPid !== pid || layer !== 0 || !(alpha > 0)) continue;
    if (px >= x && px < x + width && py >= y && py < y + height) {
      return item.kCGWindowNumber === undefined ? null : Number(item.kCGWindowNumber);
    }
  }
  return null;
}
function verifyWindowAtPoint(req) {
  if (typeof req.windowId !== "number" || req.windowId <= 0) return null;
  var topId = topWindowIdAtPoint(req.pid, req.x, req.y);
  if (topId === undefined) return "ax-window-unverifiable";
  if (topId !== req.windowId) return "ax-window-occluded";
  return null;
}
function copyStringAttr(el, name) {
  var ref = Ref();
  var err = $.AXUIElementCopyAttributeValue(el, $(name), ref);
  if (err !== 0 || !ref[0]) return { ok: false, err: err, value: null };
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
function readFieldKey(el, role, windowId) {
  var id = copyStringAttr(el, "AXIdentifier");
  if (!id.ok || !id.value) return "";
  var winTitle = "";
  var winDoc = "";
  var winIdAttr = "";
  var winRef = Ref();
  if ($.AXUIElementCopyAttributeValue(el, $("AXWindow"), winRef) === 0 && winRef[0]) {
    var winTitleAttr = copyStringAttr(winRef[0], "AXTitle");
    if (winTitleAttr.ok && winTitleAttr.value) winTitle = winTitleAttr.value;
    var winDocAttr = copyStringAttr(winRef[0], "AXDocument");
    if (winDocAttr.ok && winDocAttr.value) winDoc = winDocAttr.value;
    var winIdentAttr = copyStringAttr(winRef[0], "AXIdentifier");
    if (winIdentAttr.ok && winIdentAttr.value) winIdAttr = winIdentAttr.value;
    $.CFRelease(winRef[0]);
  }
  var title = copyStringAttr(el, "AXTitle");
  var desc = copyStringAttr(el, "AXDescription");
  var subrole = copyStringAttr(el, "AXSubrole");
  var parts = ["id:" + id.value];
  if (typeof windowId === "number" && windowId > 0) parts.push("wid:" + windowId);
  if (winIdAttr) parts.push("winId:" + winIdAttr);
  if (winDoc) parts.push("winDoc:" + winDoc);
  if (winTitle) parts.push("win:" + winTitle);
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
    var fieldKey = readFieldKey(el, role, req.windowId);
    if (req.mode === "click") {
      if (EDITABLE_ROLES[role]) {
        if (!isAttrSettable(el, "AXValue")) {
          return JSON.stringify({ ok: false, reason: "value-not-settable", role: role, frontmostApplication: frontName() });
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
      if (!isAttrSettable(el, "AXValue")) {
        return JSON.stringify({ ok: false, reason: "value-not-settable", role: role, frontmostApplication: frontName() });
      }
      var valAttr = copyStringAttr(el, "AXValue");
      var current;
      if (valAttr.ok) {
        current = valAttr.value;
      } else if (valAttr.err === -25212) {
        var lenRef = Ref();
        var lenErr = $.AXUIElementCopyAttributeValue(el, $("AXNumberOfCharacters"), lenRef);
        if (lenErr !== 0 || !lenRef[0]) {
          return JSON.stringify({ ok: false, reason: "ax-value-unreadable", err: lenErr, role: role, frontmostApplication: frontName() });
        }
        var charCount = Number(ObjC.unwrap(ObjC.castRefToObject(lenRef[0])));
        $.CFRelease(lenRef[0]);
        if (isNaN(charCount) || charCount !== 0) {
          return JSON.stringify({ ok: false, reason: "ax-value-unreadable", role: role, frontmostApplication: frontName() });
        }
        current = "";
      } else {
        return JSON.stringify({ ok: false, reason: "ax-value-unreadable", err: valAttr.err, role: role, frontmostApplication: frontName() });
      }
      var setWinErr = verifyWindowAtPoint(req);
      if (setWinErr !== null) {
        return JSON.stringify({ ok: false, reason: setWinErr, role: role, frontmostApplication: frontName() });
      }
      var nextValue = current + text;
      var setErr = $.AXUIElementSetAttributeValue(el, $("AXValue"), $(nextValue));
      if (setErr === 0) {
        return JSON.stringify({ ok: true, kind: "typed", role: role, frontmostApplication: frontName() });
      }
      return JSON.stringify({ ok: false, reason: "ax-set-failed", err: setErr, role: role, frontmostApplication: frontName() });
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
      pid: w.kCGWindowOwnerPID === undefined ? undefined : Number(w.kCGWindowOwnerPID)
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
