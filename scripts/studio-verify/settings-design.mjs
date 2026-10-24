/** Run pageChecks through preview_evaluate in the app's headless Browser.
 * CLI verifies the saved, source-bound receipt; it never opens another browser.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
export const sourceFiles = [
  "apps/web/src/components/settings/settingsLayout.tsx",
  "apps/web/src/components/settings/SettingsGroup.tsx",
  "apps/web/src/components/settings/ProviderInstanceCard.tsx",
  "apps/web/src/components/settings/ProviderSettingsPanel.tsx",
  "apps/web/src/components/settings/providerDriverMeta.ts",
  "apps/web/tests/settings-design/main.tsx",
  "apps/web/tests/settings-design/mocks.tsx",
  "apps/web/tests/settings-design/fixture.css",
  "apps/web/tests/settings-design/vite.config.ts",
  "apps/web/tests/settings-design/index.html",
  "scripts/studio-verify/settings-design.mjs",
];
export function sourceDigest() {
  const hash = createHash("sha256");
  for (const file of sourceFiles) hash.update(file).update(readFileSync(file));
  return hash.digest("hex");
}
export async function pageChecks() {
  const checks = [];
  const check = (label, ok) => {
    checks.push({ label, pass: Boolean(ok) });
    if (!ok) throw new Error(label);
  };
  const settle = () =>
    new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  const select = (name) => document.querySelector(`button[aria-label="Select ${name}"]`).click();
  check("Headless Chrome", navigator.userAgent.includes("HeadlessChrome"));
  check("No horizontal overflow", document.documentElement.scrollWidth <= innerWidth);
  const labels = [...document.querySelectorAll('nav button[aria-label^="Select"]')].map((e) =>
    e.getAttribute("aria-label"),
  );
  check(
    "Copilot entries remain separate and adjacent",
    labels.indexOf("Select GitHub Copilot CLI") === labels.indexOf("Select GitHub Copilot") + 1,
  );
  check(
    "Provider names do not truncate",
    [...document.querySelectorAll('nav button[aria-label^="Select"]')].every((e) => {
      const label = e.getAttribute("aria-label").slice(7);
      const text = [...e.parentElement.querySelectorAll("span")].find(
        (node) => node.textContent === label,
      );
      return (
        text &&
        getComputedStyle(text).textOverflow !== "ellipsis" &&
        text.scrollWidth <= text.clientWidth &&
        text.scrollHeight <= text.clientHeight
      );
    }),
  );
  const longButton = document.querySelector(
    'button[aria-label="Select OpenCode research account with custom endpoint"]',
  );
  const name = [...longButton.parentElement.querySelectorAll("span")].find(
    (e) => e.textContent === "OpenCode research account with custom endpoint",
  );
  check(
    "Long provider name fits beside version",
    name && name.scrollWidth <= name.clientWidth && name.scrollHeight <= name.clientHeight,
  );
  check(
    "Cursor SDK guidance visible",
    document.body.innerText.includes("hosted inference") &&
      document.body.innerText.includes("may require a paid Cursor plan"),
  );
  check(
    "Cursor remains disabled",
    document.querySelector('[aria-label="Enable Cursor"]').getAttribute("aria-checked") === "false",
  );
  check(
    "All four reach labels",
    ["This device", "This machine: M4", "All connected machines", "This project"].every((s) =>
      document.body.innerText.includes(s),
    ),
  );
  select("Codex");
  await settle();
  let runtime = document.getElementById("provider-instance-codex-runtime");
  check("Runtime starts closed", runtime.open === false);
  check(
    "Environment starts closed",
    document.getElementById("provider-instance-codex-environment").open === false,
  );
  check(
    "Search finds nested runtime field",
    window.settingsDesignSearch("provider-instance-codex-binaryPath"),
  );
  check(
    "Search opens disclosure and focuses field",
    runtime.open && document.activeElement.id === "provider-instance-codex-binaryPath",
  );
  const input = document.activeElement;
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(
    input,
    "/fixture/codex",
  );
  input.dispatchEvent(new Event("input", { bubbles: true }));
  await settle();
  input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  input.blur();
  await settle();
  check(
    "Runtime edit commits",
    document.querySelector("output").textContent !== "Fixture writes: 0",
  );
  runtime.querySelector("summary").click();
  await settle();
  check("Runtime closes again", !runtime.open);
  runtime.querySelector("summary").click();
  await settle();
  check(
    "Runtime edit survives collapse",
    document.getElementById("provider-instance-codex-binaryPath").value === "/fixture/codex",
  );
  select("Cursor");
  await settle();
  select("Codex");
  await settle();
  check(
    "Runtime edit survives provider navigation",
    document.getElementById("provider-instance-codex-binaryPath").value === "/fixture/codex",
  );
  const env = document.getElementById("provider-instance-codex-environment");
  env.querySelector("summary").click();
  await settle();
  check("Environment disclosure opens", env.open);
  check(
    "Model preferences explicitly device-local",
    document.body.innerText.includes("This device: favorites, visibility and order"),
  );
  check("No overflow with disclosures open", document.documentElement.scrollWidth <= innerWidth);
  window.scrollTo(0, 0);
  return {
    theme: new URLSearchParams(location.search).get("theme"),
    width: innerWidth,
    checks,
    headless: true,
  };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const receipt = JSON.parse(
    readFileSync(process.argv[2] ?? ".artifacts/settings-design/browser-receipt.json", "utf8"),
  );
  if (receipt.sourceDigest !== sourceDigest())
    throw new Error("Browser receipt does not match current source");
  for (const theme of ["light", "dark"])
    for (const width of [1280, 390]) {
      const run = receipt.runs.find((r) => r.theme === theme && r.width === width);
      if (!run?.headless || run.checks.length < 19 || run.checks.some((c) => !c.pass))
        throw new Error(`Incomplete browser evidence: ${theme} ${width}`);
    }
  if (
    !receipt.readOnly?.runtimeOpen ||
    !receipt.readOnly?.environmentOpen ||
    !receipt.readOnly?.runtimeInert ||
    receipt.readOnly?.summaryInert ||
    receipt.readOnly?.writes !== "Fixture writes: 0"
  )
    throw new Error("Read-only disclosure evidence missing");
  console.log(
    `PASS: ${receipt.runs.length} headless scenarios, ${receipt.runs.reduce((n, r) => n + r.checks.length, 0)} checks; source ${receipt.sourceDigest}`,
  );
}
