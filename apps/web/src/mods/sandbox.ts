/**
 * Builds the document a mod runs in.
 *
 * The frame is `sandbox="allow-scripts"` without `allow-same-origin`, so it
 * has an opaque origin: no access to the workbench DOM, cookies, storage or
 * session. Its policy forbids every network fetch, frame, form and image.
 *
 * The mod's own code never runs in the frame. The frame only holds a small
 * bridge that starts the mod in a dedicated worker and relays messages. A
 * frame can navigate itself (`location.href = ...`, a link click, a meta
 * refresh), and no content policy directive stops that, so code running in
 * the frame could carry data out in a URL. A worker has no document and
 * cannot navigate anything. It inherits the frame's policy, so its fetches
 * are blocked too, and network constructors are removed before the mod
 * runs as a second line behind the policy. The only way out is
 * `postMessage` to the host, which checks each message (see protocol.ts).
 */

export const MOD_FRAME_SANDBOX = "allow-scripts";

export const MOD_FRAME_POLICY =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'none'; img-src 'none'; " +
  "connect-src 'none'; frame-src 'none'; worker-src blob:; form-action 'none'; base-uri 'none'";

/**
 * Runs in the worker before the mod. Gives it `register(on)` hooks shaped
 * like Claude Code mods (`on(event, matcher?, ($, e, next) => ...)`), a
 * global `h` for UI trees, and `$` with the host calls a mod may make.
 */
const RUNTIME = String.raw`(() => {
  "use strict";
  const send = (message) => self.postMessage(message);
  // Remove each network and storage entry point from the worker scope and
  // every prototype that carries it, so the mod cannot reach the original.
  for (const key of [
    "fetch", "XMLHttpRequest", "WebSocket", "EventSource", "WebTransport",
    "Worker", "SharedWorker", "BroadcastChannel", "importScripts", "indexedDB",
    "caches", "cookieStore",
  ]) {
    // Only where the key is defined: freezing it on Object.prototype would break
    // every plain object that later gets a property of the same name.
    for (let target = self; target; target = Object.getPrototypeOf(target)) {
      if (target !== self && !Object.prototype.hasOwnProperty.call(target, key)) continue;
      try { Object.defineProperty(target, key, { value: undefined, configurable: false, writable: false }); } catch {}
    }
  }

  const hooks = [];
  const handlers = new Map();
  const openPanes = new Set();
  const pending = new Map();
  let nextRequest = 1;
  let info = null;
  let registerFn;

  const report = (error) => send({ type: "error", message: String((error && error.message) || error) });
  self.addEventListener("error", (event) => { event.preventDefault(); report(event.error || event.message); });
  self.addEventListener("unhandledrejection", (event) => { event.preventDefault(); report(event.reason); });

  globalThis.h = (type, props, ...children) => ({
    type, props: props || {},
    children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false && c !== true),
  });

  const matches = (matcher, e) =>
    !matcher || Object.keys(matcher).every((key) => e && e[key] === matcher[key]);

  const dispatch = (event, e) => {
    const chain = hooks.filter((entry) => entry.event === event && matches(entry.matcher, e));
    const run = (index, current) =>
      index >= chain.length
        ? Promise.resolve(undefined)
        : Promise.resolve().then(() =>
            chain[index].hook($, current, (next) => run(index + 1, next === undefined ? current : next)),
          );
    return run(0, Object.freeze({ ...e }));
  };

  const request = (method, threadId) =>
    new Promise((resolve, reject) => {
      const requestId = nextRequest++;
      pending.set(requestId, { resolve, reject });
      send({ type: "request", requestId, method, threadId: threadId ?? null });
    });

  // Functions in props (onPress) stay here; the host gets a number to press.
  const serialize = (paneHandlers, node) => {
    if (node === null || node === undefined || typeof node !== "object") return node;
    const props = {};
    for (const [key, value] of Object.entries(node.props || {})) {
      if (typeof value === "function") {
        const id = paneHandlers.size + 1;
        paneHandlers.set(id, value);
        props[key] = id;
      } else props[key] = value;
    }
    return { type: node.type, props, children: (node.children || []).map((c) => serialize(paneHandlers, c)) };
  };

  const draw = async (id) => {
    if (!openPanes.has(id)) return;
    const tree = await dispatch("ui.render", { component: "Pane", requestId: id });
    if (!openPanes.has(id)) return;
    const paneHandlers = new Map();
    const serialized = tree === undefined || tree === null ? null : serialize(paneHandlers, tree);
    handlers.set(id, paneHandlers);
    send({ type: "ui.tree", id, tree: serialized });
  };

  const $ = Object.freeze({
    mod: () => info,
    command: Object.freeze({
      register: ({ name, description }) => send({ type: "command.register", name, description }),
    }),
    ui: Object.freeze({
      toast: (text) => send({ type: "ui.toast", text }),
      status: (text) => send({ type: "ui.status", text: text ?? null }),
      open: ({ id, title }) => { openPanes.add(id); send({ type: "ui.open", id, title }); return draw(id); },
      close: (id) => { openPanes.delete(id); handlers.delete(id); send({ type: "ui.close", id }); },
      redraw: (id) => (id === undefined ? Promise.all([...openPanes].map(draw)) : draw(id)),
    }),
    threads: Object.freeze({
      list: () => request("threads.list"),
      open: (threadId) => request("threads.open", threadId),
    }),
    specweave: Object.freeze({
      list: () => request("specweave.list"),
    }),
  });

  const boot = async () => {
    if (!info || registerFn === undefined) return;
    if (typeof registerFn !== "function") return report("The mod does not export register(on).");
    try {
      await registerFn((event, matcher, hook) =>
        hook === undefined
          ? hooks.push({ event, matcher: undefined, hook: matcher })
          : hooks.push({ event, matcher, hook }),
      );
      await dispatch("app.start", { surface: info.surface, permissions: info.permissions });
      send({ type: "started" });
    } catch (error) { report(error); }
  };

  // Only the bridge in the frame can post to this worker.
  self.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.type === "init" && info === null) {
      info = Object.freeze({ name: message.name, surface: message.surface, permissions: message.permissions });
      void boot();
    } else if (message.type === "event") {
      // Open panes redraw after every event, so a pane follows what it reads.
      dispatch(message.event, message.e).then(() => $.ui.redraw(), report);
    } else if (message.type === "press") {
      const handler = handlers.get(message.id) && handlers.get(message.id).get(message.handler);
      if (handler) Promise.resolve().then(() => handler()).then(() => draw(message.id), report);
    } else if (message.type === "pane.closed") {
      openPanes.delete(message.id);
      handlers.delete(message.id);
    } else if (message.type === "response") {
      const entry = pending.get(message.requestId);
      if (!entry) return;
      pending.delete(message.requestId);
      message.ok ? entry.resolve(message.value) : entry.reject(new Error(message.error));
    }
  });

  globalThis.__studioModStart = (register) => { registerFn = register; void boot(); };
  send({ type: "loaded" });
})();`;

/**
 * Runs in the frame. Starts the mod's script in a dedicated worker and relays
 * messages between it and the host. No mod code runs here.
 */
const BRIDGE = String.raw`(() => {
  "use strict";
  const host = window.parent;
  const fail = (message) => host.postMessage({ type: "error", message: String(message) }, "*");
  let worker;
  try {
    const url = URL.createObjectURL(new Blob([MOD_SCRIPT], { type: "text/javascript" }));
    worker = new Worker(url, { name: "studio-mod" });
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  } catch (error) {
    fail("Studio could not start the mod: " + ((error && error.message) || error));
    return;
  }
  worker.addEventListener("message", (event) => host.postMessage(event.data, "*"));
  worker.addEventListener("messageerror", () => fail("The mod sent a message Studio cannot read."));
  worker.addEventListener("error", (event) => { event.preventDefault(); fail(event.message || "The mod failed to load."); });
  window.addEventListener("message", (event) => {
    if (event.source !== host) return;
    worker.postMessage(event.data);
  });
})();`;

/** Keeps the mod's source from ending its own script element. */
export function escapeInlineScript(source: string): string {
  return source.replace(/<\/(script)/giu, "<\\/$1").replace(/<!--/gu, "<\\!--");
}

/**
 * A browser loads a module worker only from its own origin, and the frame's
 * origin is opaque, so the mod runs as a classic worker script. Its
 * top-level `export` keywords are dropped (a mod has no imports) and its code
 * runs in strict mode inside its own function, after the runtime. Its
 * `register` binding, from `export function register` or
 * `export const register`, is then handed to the runtime.
 */
export function buildModScript(source: string): string {
  const body = source
    .replace(
      /^([ \t]*)export[ \t]+(?=(?:async[ \t]+)?function\b|const\b|let\b|var\b|class\b)/gmu,
      "$1",
    )
    .replace(/^[ \t]*export[ \t]*\{[^}]*\}[ \t]*;?[ \t]*$/gmu, "");
  return [
    RUNTIME,
    '(function () {\n"use strict";',
    body,
    ';globalThis.__studioModStart(typeof register === "function" ? register : null);',
    "})();",
    "",
  ].join("\n");
}

/** A JavaScript string literal that is also safe inside an inline script element. */
function scriptStringLiteral(value: string): string {
  return JSON.stringify(value)
    .replace(/</gu, "\\u003c")
    .replace(/\u2028/gu, "\\u2028")
    .replace(/\u2029/gu, "\\u2029");
}

export function buildModSrcdoc(source: string): string {
  return [
    '<!doctype html><html><head><meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${MOD_FRAME_POLICY}">`,
    `</head><body><script>const MOD_SCRIPT = ${scriptStringLiteral(buildModScript(source))};\n${escapeInlineScript(BRIDGE)}</script>`,
    "</body></html>",
  ].join("");
}
