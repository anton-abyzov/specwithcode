import { assert, describe, it } from "vite-plus/test";

import {
  decideModRequest,
  MAX_TREE_NODES,
  parseFrameMessage,
  parseModTree,
  ToastBudget,
  USER_ACTION_WINDOW_MS,
} from "./protocol";
import { buildModScript, buildModSrcdoc, escapeInlineScript, MOD_FRAME_POLICY } from "./sandbox";

describe("parseFrameMessage", () => {
  it("drops shapes the host does not know", () => {
    assert.isNull(parseFrameMessage(null));
    assert.isNull(parseFrameMessage("loaded"));
    assert.isNull(parseFrameMessage({ type: "settings.write", key: "x" }));
    assert.isNull(parseFrameMessage({ type: "command.register", name: "Bad Name" }));
    assert.isNull(parseFrameMessage({ type: "request", requestId: 1, method: "approvals.answer" }));
    assert.isNull(parseFrameMessage({ type: "request", requestId: 1, method: "threads.open" }));
  });

  it("bounds text a mod shows", () => {
    const toast = parseFrameMessage({ type: "ui.toast", text: `  ${"a".repeat(500)}  ` });
    assert.equal(toast?.type, "ui.toast");
    assert.equal(toast?.type === "ui.toast" ? toast.text.length : 0, 200);
    assert.deepEqual(parseFrameMessage({ type: "ui.status", text: "" }), {
      type: "ui.status",
      text: null,
    });
  });
});

describe("parseModTree", () => {
  it("keeps allowed elements and drops unknown props", () => {
    const tree = parseModTree({
      type: "Box",
      props: { direction: "row", gap: 99, style: "position:fixed", dangerouslySetInnerHTML: "x" },
      children: [
        { type: "Text", props: { tone: "danger", className: "x" }, children: ["<b>hi</b>"] },
        { type: "Button", props: { onPress: 3, href: "javascript:alert(1)" }, children: ["Go"] },
      ],
    });
    assert.deepEqual(tree, {
      type: "Box",
      direction: "row",
      gap: 6,
      children: [
        { type: "Text", tone: "danger", mono: false, children: ["<b>hi</b>"] },
        { type: "Button", variant: "outline", disabled: false, handler: 3, children: ["Go"] },
      ],
    });
  });

  it("rejects trees with unknown elements or too many nodes", () => {
    assert.isNull(parseModTree({ type: "iframe", props: { src: "https://example.com" } }));
    assert.isNull(
      parseModTree({
        type: "Box",
        children: Array.from({ length: MAX_TREE_NODES + 1 }, () => "x"),
      }),
    );
  });
});

describe("decideModRequest", () => {
  it("needs the declared permission", () => {
    const decision = decideModRequest({
      method: "threads.list",
      permissions: [],
      lastUserActionAt: null,
      now: 0,
    });
    assert.isFalse(decision.allowed);
  });

  it("reads SpecWeave progress only with specweave:read, which threads:read does not grant", () => {
    const request = { method: "specweave.list" as const, lastUserActionAt: null, now: 0 };
    assert.isFalse(decideModRequest({ ...request, permissions: ["threads:read"] }).allowed);
    assert.isTrue(decideModRequest({ ...request, permissions: ["specweave:read"] }).allowed);
    assert.deepEqual(
      parseFrameMessage({ type: "request", requestId: 3, method: "specweave.list" }),
      { type: "request", requestId: 3, method: "specweave.list", threadId: null },
    );
    assert.isNull(parseFrameMessage({ type: "request", requestId: 3, method: "specweave.write" }));
  });

  it("opens threads only right after the user used the mod", () => {
    const base = { method: "threads.open" as const, permissions: ["threads:open" as const] };
    assert.isFalse(decideModRequest({ ...base, lastUserActionAt: null, now: 10 }).allowed);
    assert.isTrue(decideModRequest({ ...base, lastUserActionAt: 0, now: 1_000 }).allowed);
    assert.isFalse(
      decideModRequest({ ...base, lastUserActionAt: 0, now: USER_ACTION_WINDOW_MS + 1 }).allowed,
    );
  });
});

describe("ToastBudget", () => {
  it("allows a few toasts per window", () => {
    const budget = new ToastBudget(2, 1_000);
    assert.isTrue(budget.take(0));
    assert.isTrue(budget.take(10));
    assert.isFalse(budget.take(20));
    assert.isTrue(budget.take(1_100));
  });
});

describe("buildModSrcdoc", () => {
  it("locks the frame down and keeps the mod inside its script", () => {
    const html = buildModSrcdoc(
      'export function register(on) { const s = "</script><img src=x>"; }',
    );
    assert.include(html, MOD_FRAME_POLICY);
    assert.include(MOD_FRAME_POLICY, "connect-src 'none'");
    assert.notInclude(html, "</script><img");
    assert.equal(escapeInlineScript("a</SCRIPT>b<!--c"), "a<\\/SCRIPT>b<\\!--c");
  });

  it("runs the mod in a worker, never in the frame that could navigate", () => {
    const html = buildModSrcdoc('export function register(on) { location.href = "x"; }');
    assert.include(MOD_FRAME_POLICY, "worker-src blob:");
    assert.include(html, "new Worker(");
    // The mod's code exists in the frame only as the worker's source string.
    assert.notMatch(html, /<script[^>]*>\s*export function register/u);
    assert.notInclude(html, 'location.href = "x"; }</script>');
  });
});

describe("buildModScript", () => {
  it("drops top-level exports and hands register to the runtime", () => {
    const script = buildModScript(
      [
        "export function register(on) {}",
        "export const helper = 1;",
        "  export async function later() {}",
        "export { helper };",
        'const text = "export const kept";',
      ].join("\n"),
    );
    assert.include(script, "\nfunction register(on) {}");
    assert.include(script, "\nconst helper = 1;");
    assert.include(script, "\n  async function later() {}");
    assert.notInclude(script, "export { helper }");
    assert.include(script, 'const text = "export const kept";');
    assert.include(script, '__studioModStart(typeof register === "function" ? register : null)');
  });
});
