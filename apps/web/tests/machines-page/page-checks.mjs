// Checks of `?view=page`: Settings > Machines in each setup state, under each system's
// conventions, light and dark, at desktop width and 390 px. Returns what failed.
import * as NodePath from "node:path";

const STATES = ["sign-in", "sign-in-browser", "turn-on", "add-phone", "done", "no-connect"];
const SYSTEMS = ["macos", "windows", "linux"];
const VIEWS = [
  { name: "desktop", width: 1100, height: 900 },
  { name: "phone", width: 390, height: 780 },
];
// The one button the state needs, by its name; null where the window offers none.
const PRIMARY = {
  "sign-in": "Sign in",
  "sign-in-browser": null,
  "turn-on": "Turn on",
  "add-phone": null,
  done: null,
  "no-connect": null,
};
const PAIR_ROW = "Cannot use Connect? Pair over your own network.";
const PAIR_BUTTON = "Pair with a private QR code";

/** What the page shows, read in the browser. */
function readPage() {
  const probe = document.createElement("div");
  probe.style.background = "var(--primary)";
  document.body.append(probe);
  const primary = getComputedStyle(probe).backgroundColor;
  probe.remove();
  const shown = (node) => node.getClientRects().length > 0;
  const top = (selector) => document.querySelector(selector)?.getBoundingClientRect().top ?? null;
  const heading = (text) =>
    [...document.querySelectorAll("h2, h3, summary")]
      .find((node) => shown(node) && node.textContent.trim().startsWith(text))
      ?.getBoundingClientRect().top ?? null;
  return {
    overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    primary: [...document.querySelectorAll("button, a")]
      .filter((node) => shown(node) && getComputedStyle(node).backgroundColor === primary)
      .map((node) => node.textContent.trim()),
    // Text cut off by its box, apart from names that are meant to shorten with an ellipsis.
    clipped: [...document.querySelectorAll("button, h2, h3, summary, p, label, span")]
      .filter(
        (node) =>
          shown(node) &&
          node.children.length === 0 &&
          // Words for screen readers only are a 1 px box by design.
          node.clientWidth > 1 &&
          node.scrollWidth > node.clientWidth + 1 &&
          getComputedStyle(node).overflowX !== "visible" &&
          getComputedStyle(node).textOverflow !== "ellipsis",
      )
      .map((node) => node.textContent.trim().slice(0, 60)),
    nextSteps: [...document.querySelectorAll("*")].filter(
      (node) => node.children.length === 0 && node.textContent.trim() === "Next step",
    ).length,
    order: [
      top("[data-machine-summary]"),
      top("[data-machine-here-details]"),
      // A build without SpecWithCode Connect has no card: pairing stands in its place.
      top("[data-phone-card]") ?? heading("Phone"),
      heading("Other machines"),
      heading("Let another of your machines run work here"),
      heading("Who can run work here"),
      heading("Advanced:"),
    ],
    phoneCard: document.querySelector("[data-phone-card]")?.getAttribute("data-phone-card") ?? null,
    phoneSteps: document.querySelectorAll("[data-phone-step]").length,
    pairRowInCard: document.querySelector("[data-phone-card] [data-pair-phone-row]") !== null,
    text: document.querySelector("main").innerText,
  };
}

/** Whether the focused control shows where focus is. */
function focusShown() {
  const node = document.activeElement;
  if (!node || node === document.body) return null;
  const style = getComputedStyle(node);
  const ring =
    (style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0) ||
    style.boxShadow !== "none";
  return {
    name: (node.textContent || node.getAttribute("aria-label") || node.tagName).trim().slice(0, 40),
    ring,
  };
}

export async function checkMachinesPage({ browser, url, out }) {
  const failures = [];
  const fail = (where, message) => failures.push(`page ${where}: ${message}`);
  for (const state of STATES)
    for (const system of SYSTEMS)
      for (const theme of ["light", "dark"])
        for (const view of VIEWS) {
          const where = `${state} ${system} ${theme} ${view.name}`;
          const page = await browser.newPage({ viewport: view });
          const errors = [];
          page.on("pageerror", (error) => errors.push(String(error)));
          await page.goto(`${url}?view=page&state=${state}&platform=${system}&theme=${theme}`, {
            timeout: 240_000,
          });
          await page.locator("[data-machine-summary]").waitFor({ timeout: 60_000 });
          const seen = await page.evaluate(readPage);
          if (errors.length > 0) fail(where, `page errors: ${errors.join("; ")}`);
          if (seen.overflow > 0) fail(where, `overflows sideways by ${seen.overflow}px`);
          if (seen.clipped.length > 0) fail(where, `clipped text: ${seen.clipped.join(" | ")}`);
          const wanted = PRIMARY[state] ? [PRIMARY[state]] : [];
          if (seen.primary.join("|") !== wanted.join("|"))
            fail(
              where,
              `primary buttons are [${seen.primary.join(", ")}], want [${wanted.join(", ")}]`,
            );
          const pending = ["sign-in", "sign-in-browser", "turn-on", "add-phone"].includes(state);
          if (seen.nextSteps !== (pending ? 1 : 0))
            fail(where, `${seen.nextSteps} "Next step" labels`);
          const order = seen.order.filter((value) => value !== null);
          if (order.length < 7 || order.some((v, i) => i > 0 && v < order[i - 1]))
            fail(where, `order reads ${seen.order.join(", ")}`);
          const has = (line) => seen.text.includes(line);
          if (state === "no-connect") {
            if (seen.phoneCard !== null)
              fail(where, "shows the phone card without SpecWithCode Connect");
          } else {
            if (seen.phoneCard === null) fail(where, "no phone card");
            if (!seen.pairRowInCard) fail(where, "the pairing row is missing from the card");
            // A window that may make a pairing code names the row; one that may not says why.
            if (state !== "sign-in-browser" && !has(PAIR_ROW))
              fail(where, "the pairing row lost its words");
            // The store code and the store names show while a phone is still to add.
            if (state === "add-phone" && (!has("App Store") || !has("Google Play")))
              fail(where, "the stores are not named");
          }
          if (state === "sign-in-browser" && !has("Open SpecWithCode on MacBook Air to do this."))
            fail(where, "does not say where to sign in");
          if (state === "add-phone" && (!has("Waiting for your phone…") || !has("Not now")))
            fail(where, "no waiting line or Not now");
          // Done is a plain list: no checklist, no done line, the facts only once, in the summary.
          if (state === "done") {
            if (!has("iPhone 16")) fail(where, "no phone row");
            if (has("You are set")) fail(where, "still draws a done line");
            if (seen.phoneSteps > 0) fail(where, `${seen.phoneSteps} finished phone steps drawn`);
            if (has("is on SpecWithCode Connect")) fail(where, "repeats the Connect fact");
          }
          if (state !== "no-connect" && !has("Add a device or machine"))
            fail(where, "no way to add a device from the summary");
          if (/\b(environment|relay)\b/i.test(seen.text))
            fail(where, `says "${seen.text.match(/\b(environment|relay)\b/i)[0]}"`);
          // Every control reached by Tab shows its focus.
          for (let step = 0; step < 14; step += 1) {
            await page.keyboard.press("Tab");
            const focused = await page.evaluate(focusShown);
            if (focused && !focused.ring) fail(where, `no focus ring on "${focused.name}"`);
          }
          if (system === "macos" || view.name === "phone")
            await page.screenshot({
              path: NodePath.join(out, `page-${state}-${system}-${theme}-${view.name}.png`),
              fullPage: true,
            });
          await page.close();
        }
  failures.push(...(await checkAddDevice({ browser, url, out })));
  // The quiet row opens the pairing dialog straight at its steps, and Advanced opens in place.
  const page = await browser.newPage({ viewport: VIEWS[0] });
  await page.goto(`${url}?view=page&state=add-phone&theme=light`, { timeout: 240_000 });
  await page.getByRole("button", { name: PAIR_BUTTON }).click();
  const dialog = page.getByRole("dialog");
  await dialog.waitFor({ timeout: 30_000 });
  const dialogText = await dialog.innerText();
  if (!dialogText.includes("Pair over your own network"))
    fail("pair dialog", `opens as "${dialogText.slice(0, 80)}"`);
  if (!dialogText.includes("Turn on Network access"))
    fail("pair dialog", "does not offer Turn on Network access when the phone has no address");
  await page.screenshot({ path: NodePath.join(out, "page-pair-dialog.png") });
  await page.keyboard.press("Escape");
  await page.locator("summary", { hasText: "Advanced:" }).click();
  const advanced = await page.locator("details", { hasText: "Advanced:" }).last().innerText();
  for (const line of [
    "SpecWithCode Connect",
    "Activity for phone notifications",
    "Saved connections",
  ])
    if (!advanced.includes(line)) fail("advanced", `missing "${line}"`);
  await page.screenshot({ path: NodePath.join(out, "page-advanced-open.png"), fullPage: true });
  await page.close();
  return failures;
}

// `?view=add-device`: the add dialog for a phone and a computer, in each setup state.
const ADD_DEVICE = {
  done: { qr: true, ready: true, step: false },
  "add-phone": { qr: true, ready: true, step: false },
  "turn-on": { qr: false, ready: false, step: true },
  "sign-in": { qr: false, ready: false, step: true },
  "no-connect": { qr: false, ready: false, step: false },
};

async function checkAddDevice({ browser, url, out }) {
  const failures = [];
  for (const [state, want] of Object.entries(ADD_DEVICE))
    for (const tab of ["phone", "computer"])
      for (const view of VIEWS) {
        const where = `add-device ${state} ${tab} ${view.name}`;
        const page = await browser.newPage({ viewport: view });
        const errors = [];
        page.on("pageerror", (error) => errors.push(String(error)));
        await page.goto(`${url}?view=add-device&state=${state}&tab=${tab}&theme=dark`, {
          timeout: 240_000,
        });
        const dialog = page.getByRole("dialog");
        await dialog.waitFor({ timeout: 60_000 });
        await page.waitForTimeout(300);
        const seen = await dialog.evaluate((node) => ({
          text: node.innerText,
          qr: node.querySelectorAll("svg title").length,
          ready: node.querySelector("[data-add-device-ready]") !== null,
          step: node.querySelector("[data-add-device-step]") !== null,
          checked: [...node.querySelectorAll('[role="radio"]')].map((radio) =>
            radio.getAttribute("aria-checked"),
          ),
          focused: document.activeElement?.getAttribute("aria-checked") ?? null,
          overflow: node.scrollWidth - node.clientWidth,
          width: node.getBoundingClientRect().width,
        }));
        const fail = (message) => failures.push(`${where}: ${message}`);
        if (errors.length > 0) fail(`page errors: ${errors.join("; ")}`);
        if (seen.overflow > 0) fail(`overflows sideways by ${seen.overflow}px`);
        if (seen.width > view.width) fail(`is ${seen.width}px wide in a ${view.width}px window`);
        if (seen.checked.join() !== (tab === "phone" ? "true,false" : "false,true"))
          fail(`choices read ${seen.checked.join()}`);
        if (seen.focused !== "true") fail("focus does not start on the chosen kind");
        if (seen.qr > 0 !== want.qr) fail(`${seen.qr} codes`);
        if (seen.ready !== want.ready) fail(`ready line ${seen.ready ? "shown" : "missing"}`);
        if (seen.step !== want.step) fail(`Connect step ${seen.step ? "shown" : "missing"}`);
        if (
          want.qr &&
          !seen.text.includes(
            tab === "phone" ? "specwithcode.com/get" : "specwithcode.com/download",
          )
        )
          fail("does not name the link the code opens");
        if (
          !seen.text.includes(tab === "phone" ? "Pair with a private QR code" : "Use a join line")
        )
          fail("no fallback");
        await page.screenshot({
          path: NodePath.join(out, `add-device-${state}-${tab}-${view.name}.png`),
        });
        await page.close();
      }
  return failures;
}
