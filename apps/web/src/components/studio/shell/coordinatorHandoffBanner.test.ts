// @effect-diagnostics-next-line nodeBuiltinImport:off -- a test that reads source files.
import * as NodeFS from "node:fs";
import * as NodeURL from "node:url";
import { expect, it } from "vite-plus/test";

// Read from disk: the unit project stubs CSS imports.
const shellCss = NodeFS.readFileSync(
  NodeURL.fileURLToPath(new URL("./shell.css", import.meta.url)),
  "utf8",
);

function rule(selector: string): string {
  const start = shellCss.indexOf(`${selector} {`);
  expect(start, `${selector} has a rule`).toBeGreaterThanOrEqual(0);
  return shellCss.slice(start, shellCss.indexOf("}", start));
}

it("keeps the Continued from another machine banner out from under the first message", () => {
  const banner = rule('.sws-coordinator > .contents > [data-slot="handoff-history"]');
  // The conversation below is flex: 1 with min-height: 0; the banner must not shrink into it.
  expect(banner).toMatch(/flex-shrink:\s*0;/);
  // Opened history scrolls inside the banner instead of pushing the conversation away.
  expect(banner).toMatch(/max-height:\s*40%;/);
  expect(banner).toMatch(/overflow-y:\s*auto;/);
  expect(banner).toMatch(/margin-bottom:\s*4px;/);
});
