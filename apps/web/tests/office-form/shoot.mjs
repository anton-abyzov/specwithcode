// Headless check and captures of the form view over a real form and its
// responses Sheet on disk: edit and autosave, a required question refused,
// answers sent (one that reads as a formula kept as text), a second response
// that meets a conflict and still lands, and the Responses tab, in light and
// dark. Always headless; serves the fixture only. Run after building:
//   node node_modules/vite-plus/bin/vp build --config apps/web/tests/office-form/vite.config.ts
//   node apps/web/tests/office-form/shoot.mjs /absolute/owned/evidence-dir
// Optional: STUDIO_PLAYWRIGHT_MODULE (a playwright-core entry), STUDIO_TEST_CHROMIUM.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

process.env.PWDEBUG = "0";
process.env.PLAYWRIGHT_HTML_OPEN = "never";
const { chromium } = process.env.STUDIO_PLAYWRIGHT_MODULE
  ? await import(NodeURL.pathToFileURL(process.env.STUDIO_PLAYWRIGHT_MODULE).href)
  : NodeModule.createRequire(NodePath.resolve("apps/server/package.json"))("playwright-core");
const site = NodePath.resolve(process.env.OFFICE_FIXTURE_SITE ?? ".artifacts/office-form/site");
const output = NodePath.resolve(process.argv[2] ?? ".artifacts/office-form/evidence");
await NodeFSP.mkdir(output, { recursive: true });

const load = (file) => import(NodeURL.pathToFileURL(NodePath.resolve(file)).href);
const { emptyResponsesSheet, parseForm, serializeForm } = await load(
  "packages/shared/src/officeForm/index.ts",
);
const { parseSheetDocument, serializeSheetDocument, sheetContentRevision } = await load(
  "packages/shared/src/officeSheet/model.ts",
);

// A scratch folder of its own; nothing in the repository or the app is touched.
const scratch = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "office-form-fixture-"));
const formFile = NodePath.join(scratch, "team-offsite.form.json");
const sheetFile = NodePath.join(scratch, "team-offsite-responses.sheet.json");
const seed = {
  v: 1,
  kind: "form",
  title: "Team offsite, March 2027",
  description: "Two days in Lisbon. Tell us how you travel and what you eat.",
  items: [
    { id: "name", type: "short", title: "Your name", required: true },
    {
      id: "team",
      type: "dropdown",
      title: "Team",
      options: ["Product", "Engineering", "Design", "Sales"],
      required: true,
    },
    {
      id: "travel",
      type: "choice",
      title: "How will you get there?",
      options: ["Plane", "Train", "Car"],
      other: true,
    },
    {
      id: "food",
      type: "checkboxes",
      title: "Food needs",
      options: ["Vegetarian", "Vegan", "Gluten free", "None"],
    },
    { id: "days", type: "section", title: "Dates", description: "We book rooms from these." },
    { id: "arrive", type: "date", title: "Arrival day" },
    {
      id: "excited",
      type: "scale",
      title: "How much are you looking forward to it?",
      scale: { min: 1, max: 5, minLabel: "Not much", maxLabel: "A lot" },
    },
    { id: "notes", type: "paragraph", title: "Anything else we should know?" },
  ],
  responses: { sheet: "team-offsite-responses.sheet.json" },
};
await NodeFSP.writeFile(formFile, serializeForm(seed));
await NodeFSP.writeFile(sheetFile, serializeSheetDocument(emptyResponsesSheet(seed)));

let failNextSheetWrites = 0;
let sheetConflicts = 0;
const readBody = (req) =>
  new Promise((done, fail) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => done(Buffer.concat(chunks).toString("utf8")));
    req.on("error", fail);
  });

const MIME = { ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };
const server = NodeHttp.createServer(async (req, res) => {
  try {
    const pathname = new URL(req.url, "http://localhost").pathname;
    const file = pathname === "/form" ? formFile : pathname === "/sheet" ? sheetFile : null;
    if (file !== null && req.method === "GET") {
      const text = await NodeFSP.readFile(file, "utf8").catch(() => null);
      return void (text === null ? res.writeHead(404).end() : res.writeHead(200).end(text));
    }
    if (file !== null && req.method === "POST") {
      const { contents, expectedRevision } = JSON.parse(await readBody(req));
      const current = await NodeFSP.readFile(file, "utf8").catch(() => null);
      if (file === sheetFile && failNextSheetWrites > 0) {
        // Another window adds a row in between: its write lands first.
        failNextSheetWrites -= 1;
        sheetConflicts += 1;
        const other = parseSheetDocument(current).document;
        const tab = other.tabs[0];
        const row =
          Math.max(...Object.keys(tab.cells).map((key) => Number(key.replace(/^[A-Z]+/, "")))) + 1;
        const next = {
          ...other,
          tabs: [
            {
              ...tab,
              cells: {
                ...tab.cells,
                [`A${row}`]: "2026-11-28 09:59:00",
                [`B${row}`]: "Other window",
              },
            },
          ],
        };
        await NodeFSP.writeFile(file, serializeSheetDocument(next));
        return void res.writeHead(409).end();
      }
      if (
        expectedRevision !== undefined &&
        (current === null || sheetContentRevision(current) !== expectedRevision)
      ) {
        return void res.writeHead(409).end();
      }
      await NodeFSP.writeFile(file, contents);
      return void res.writeHead(200).end("{}");
    }
    const target = NodePath.resolve(site, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (!target.startsWith(site + NodePath.sep)) return void res.writeHead(403).end();
    const body = await NodeFSP.readFile(target);
    res.writeHead(200, { "Content-Type": MIME[NodePath.extname(target)] ?? "text/html" }).end(body);
  } catch (error) {
    res.writeHead(500).end(String(error));
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const executablePath = process.env.STUDIO_TEST_CHROMIUM ?? process.env.STUDIO_CHROME;
const browser = await chromium.launch({
  headless: true,
  ...(executablePath ? { executablePath } : {}),
});

const problems = [];
const screenshots = [];
const fail = (where, what) => problems.push(`${where}: ${what}`);
const check = (where, ok, what) => ok || fail(where, what);

async function open(query) {
  const context = await browser.newContext({
    viewport: { width: 1180, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => fail(query, `page error: ${error.message}`));
  page.on("console", (message) => {
    // The conflict step's refused write is a 409 on purpose.
    if (message.type() === "error" && !message.text().includes("409"))
      fail(query, `console: ${message.text()}`);
  });
  await page.route("**/*", (route) =>
    route.request().url().startsWith(origin) ? route.continue() : route.abort(),
  );
  await page.goto(`${origin}/?${query}`);
  await page.waitForSelector('[role="tablist"]');
  return { page, context };
}

async function shot(page, name) {
  const target = NodePath.join(output, `${name}.png`);
  await page.screenshot({ path: target });
  screenshots.push(target);
}

const sheetCells = async () =>
  parseSheetDocument(await NodeFSP.readFile(sheetFile, "utf8")).document.tabs[0].cells;

// 1. Edit: title, a new question, autosave to the file.
{
  const where = "edit";
  const { page, context } = await open("theme=light&tab=edit");
  await shot(page, "form-editor-light");
  await page.getByLabel("Form title").fill("Team offsite, Lisbon 2027");
  await page.getByRole("button", { name: "Add question" }).click();
  const last = page.locator("ol > li").last();
  await last.getByLabel("Question", { exact: true }).fill("Room preference");
  await last.getByLabel("Item type").selectOption("choice");
  await last.getByLabel("Option 1", { exact: true }).fill("Single");
  await last.getByRole("button", { name: "Add option" }).click();
  await last.getByLabel("Option 2", { exact: true }).fill("Shared");
  await page.getByRole("status").filter({ hasText: "Saved" }).waitFor({ timeout: 10_000 });
  const saved = parseForm(await NodeFSP.readFile(formFile, "utf8"));
  check(
    where,
    saved.ok && saved.document.title === "Team offsite, Lisbon 2027",
    "the title did not reach the file",
  );
  check(
    where,
    saved.ok &&
      saved.document.items.at(-1)?.type === "choice" &&
      saved.document.items.at(-1)?.options?.join() === "Single,Shared",
    "the new question did not reach the file",
  );
  await page.locator("ol > li").last().scrollIntoViewIfNeeded();
  await shot(page, "form-editor-new-question");
  await context.close();
}

// 2. Fill in: a required question refused, then answers sent; text that reads as a formula stays text.
{
  const where = "fill";
  const { page, context } = await open("theme=light&tab=fill");
  await page.getByRole("button", { name: "Next" }).click();
  check(
    where,
    (await page.getByText("This question is required.").count()) === 2,
    "empty required questions were not refused",
  );
  await shot(page, "form-fill-required");
  await page
    .locator('input[aria-labelledby="form-q-name"]')
    .fill('=HYPERLINK("https://example.com")');
  await page.locator('select[aria-labelledby="form-q-team"]').selectOption("Design");
  await page.getByLabel("Other answer").fill("Ferry");
  await page.getByLabel("Vegetarian").check();
  await page.getByLabel("Gluten free").check();
  await shot(page, "form-fill-light");
  await page.getByRole("button", { name: "Next" }).click();
  await page.locator('input[aria-labelledby="form-q-arrive"]').fill("2027-03-04");
  await page
    .getByRole("radiogroup", { name: "How much are you looking forward to it?" })
    .getByLabel("4", { exact: true })
    .check();
  await page
    .locator('textarea[aria-labelledby="form-q-notes"]')
    .fill("Arriving late, around 23:00.");
  await page.getByRole("button", { name: "Submit" }).click();
  await page.getByText("Your response has been recorded.").waitFor({ timeout: 10_000 });
  await shot(page, "form-sent");
  const cells = await sheetCells();
  check(
    where,
    cells.B2 === '\'=HYPERLINK("https://example.com")',
    `the formula-like answer was not kept as text: ${cells.B2}`,
  );
  check(
    where,
    cells.C2 === "Design" && cells.D2 === "Ferry",
    `choice answers wrong: ${cells.C2} ${cells.D2}`,
  );
  check(where, cells.E2 === "Vegetarian, Gluten free", `checkbox answers wrong: ${cells.E2}`);
  check(
    where,
    cells.F2 === "2027-03-04" && cells.G2 === 4,
    `date or scale wrong: ${cells.F2} ${cells.G2}`,
  );
  check(where, cells.I1 === "Room preference", `the new question has no column: ${cells.I1}`);

  // 3. A second response whose first write meets another window's row: both land.
  failNextSheetWrites = 1;
  await page.getByRole("button", { name: "Submit another response" }).click();
  await page.locator('input[aria-labelledby="form-q-name"]').fill("Bea");
  await page.locator('select[aria-labelledby="form-q-team"]').selectOption("Engineering");
  await page.getByLabel("Train").check();
  await page.getByRole("button", { name: "Next" }).click();
  await page
    .getByRole("radiogroup", { name: "How much are you looking forward to it?" })
    .getByLabel("5", { exact: true })
    .check();
  await page.getByRole("button", { name: "Submit" }).click();
  await page.getByText("Your response has been recorded.").waitFor({ timeout: 10_000 });
  const after = await sheetCells();
  check("conflict", sheetConflicts === 1, "the conflict was not met");
  check(
    "conflict",
    after.B3 === "Other window" && after.B4 === "Bea",
    `rows after the conflict: ${after.B3} ${after.B4}`,
  );
  await context.close();
}

// 4. Responses: the Sheet with every row, in light and dark.
for (const theme of ["light", "dark"]) {
  const { page, context } = await open(`theme=${theme}&tab=responses`);
  check(
    `responses ${theme}`,
    (await page.getByRole("tab", { name: "Responses (3)" }).count()) === 1,
    "the count is not 3",
  );
  await page.waitForTimeout(400);
  await shot(page, `form-responses-${theme}`);
  if (theme === "dark") {
    await page.getByRole("tab", { name: "Edit" }).click();
    await shot(page, "form-editor-dark");
    await page.getByRole("tab", { name: "Fill in" }).click();
    await shot(page, "form-fill-dark");
  }
  await context.close();
}

await browser.close();
server.close();
await NodeFSP.copyFile(formFile, NodePath.join(output, "team-offsite.form.json"));
await NodeFSP.copyFile(sheetFile, NodePath.join(output, "team-offsite-responses.sheet.json"));
await NodeFSP.rm(scratch, { recursive: true, force: true });
await NodeFSP.writeFile(
  NodePath.join(output, "report.json"),
  JSON.stringify({ problems, screenshots }, null, 2),
);
console.log(`${screenshots.length} captures in ${output}`);
if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
